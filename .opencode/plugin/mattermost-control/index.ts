import type { Plugin } from "@opencode-ai/plugin";
import { MattermostClient } from "../../../src/clients/mattermost-client.js";
import { MattermostWebSocketClient } from "../../../src/clients/websocket-client.js";
import { SessionManager } from "../../../src/session-manager.js";
import { ResponseStreamer } from "../../../src/response-streamer.js";
import { NotificationService } from "../../../src/notification-service.js";
import { FileHandler } from "../../../src/file-handler.js";
import { ReactionHandler } from "../../../src/reaction-handler.js";
import { loadConfig } from "../../../src/config.js";
import { log } from "../../../src/logger.js";
import type { User, Post, WebSocketEvent } from "../../../src/models/index.js";

let isConnected = false;
let connectedOpenCodeSessionId: string | null = null;
let mmClient: MattermostClient | null = null;
let wsClient: MattermostWebSocketClient | null = null;
let sessionManager: SessionManager | null = null;
let streamer: ResponseStreamer | null = null;
let notifications: NotificationService | null = null;
let fileHandler: FileHandler | null = null;
let reactionHandler: ReactionHandler | null = null;
let botUser: User | null = null;
let projectName: string = "";
let pendingResponseContext: {
  opencodeSessionId: string;
  mmSession: any;
  streamCtx: any;
  responseBuffer: string;
  thinkingBuffer: string;
  toolsPostId: string | null;
  toolCalls: string[];
  lastUpdateTime: number;
} | null = null;

const TOOL_UPDATE_INTERVAL_MS = 1000;
let toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;

async function updateToolsPost(): Promise<void> {
  if (!pendingResponseContext || !mmClient || pendingResponseContext.toolCalls.length === 0) return;

  const toolCounts = pendingResponseContext.toolCalls.reduce((acc, tool) => {
    acc[tool] = (acc[tool] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const summary = Object.entries(toolCounts)
    .map(([tool, count]) => count > 1 ? `${tool} ×${count}` : tool)
    .join(", ");

  const message = `:hammer_and_wrench: **Tools:** ${summary}`;

  try {
    if (pendingResponseContext.toolsPostId) {
      await mmClient.updatePost(pendingResponseContext.toolsPostId, message);
    } else {
      const post = await mmClient.createPost(pendingResponseContext.mmSession.dmChannelId, message);
      pendingResponseContext.toolsPostId = post.id;
    }
  } catch (e) {
    log.error("Failed to update tools post:", e);
  }
}

function scheduleToolUpdate(): void {
  if (toolUpdateTimer) return;
  
  toolUpdateTimer = setTimeout(async () => {
    toolUpdateTimer = null;
    await updateToolsPost();
  }, TOOL_UPDATE_INTERVAL_MS);
}

function addToolCall(toolName: string): void {
  if (!pendingResponseContext) return;
  pendingResponseContext.toolCalls.push(toolName);
  scheduleToolUpdate();
}

function formatResponseWithThinking(response: string, thinking: string): string {
  if (!thinking) {
    return response;
  }
  
  const thinkingPreview = thinking.length > 500 
    ? thinking.slice(-500) + "..." 
    : thinking;
  
  return `${response}\n\n---\n:brain: **Thinking:**\n> ${thinkingPreview.split('\n').join('\n> ')}`;
}

export const MattermostControlPlugin: Plugin = async ({ client, project, directory, $ }) => {
  const config = loadConfig();
  projectName = (project as any)?.name || directory.split("/").pop() || "opencode";

  mmClient = new MattermostClient(config.mattermost);
  wsClient = new MattermostWebSocketClient(config.mattermost);

  log.info("Loaded (not connected - use /mattermost connect)");

  async function handleConnect(): Promise<string> {
    if (isConnected) {
      return `Already connected to Mattermost as @${botUser?.username}. Use /mattermost status for details.`;
    }

    try {
      await wsClient!.connect();
      botUser = await mmClient!.getCurrentUser();

      sessionManager = new SessionManager(mmClient!, config.sessions);
      await sessionManager.setBotUserId(botUser.id);

      streamer = new ResponseStreamer(mmClient!, config.streaming);
      notifications = new NotificationService(mmClient!, config.notifications);
      fileHandler = new FileHandler(mmClient!, config.files);

      reactionHandler = new ReactionHandler(sessionManager, notifications, {
        onApprove: async (session) => {
          await notifications!.notifyStatus(session, { type: "waiting", details: "Permission approved" });
        },
        onDeny: async (session) => {
          await notifications!.notifyStatus(session, { type: "waiting", details: "Permission denied" });
        },
        onCancel: async (session) => {
          session.isProcessing = false;
          await notifications!.notifyStatus(session, { type: "idle", details: "Operation cancelled" });
        },
        onRetry: async (session) => {
          if (session.lastPrompt) {
            await handleUserMessage(session.lastPrompt);
          }
        },
        onClear: async (session) => {
          fileHandler!.cleanupSessionFiles(session);
        },
      });
      reactionHandler.setBotUserId(botUser.id);

      const sessionsResult = await client.session.list();
      const sessions = sessionsResult.data;
      if (sessions && sessions.length > 0) {
        const sortedSessions = sessions.sort((a, b) => b.time.updated - a.time.updated);
        connectedOpenCodeSessionId = sortedSessions[0].id;
        log.info(`Bound to OpenCode session: ${connectedOpenCodeSessionId}`);
      }

      setupEventListeners();
      isConnected = true;

      log.info(`Connected to Mattermost as @${botUser.username}`);

      return `✓ Connected to Mattermost as @${botUser.username}\n✓ Listening for DMs\n✓ Project: ${projectName}\n\nDM @${botUser.username} in Mattermost to send prompts remotely.`;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error("Connection failed:", errorMsg);
      return `✗ Failed to connect: ${errorMsg}`;
    }
  }

  async function handleDisconnect(): Promise<string> {
    if (!isConnected) {
      return "Not connected to Mattermost.";
    }

    try {
      if (toolUpdateTimer) {
        clearTimeout(toolUpdateTimer);
        toolUpdateTimer = null;
      }
      await updateToolsPost();
      
      wsClient!.disconnect();
      sessionManager?.shutdown();
      fileHandler?.cleanupTempFiles();

      isConnected = false;
      connectedOpenCodeSessionId = null;
      mmClient = null;
      sessionManager = null;
      streamer = null;
      notifications = null;
      fileHandler = null;
      reactionHandler = null;

      log.info("Disconnected from Mattermost");

      return "✓ Disconnected from Mattermost";
    } catch (error) {
      return `✗ Error disconnecting: ${error}`;
    }
  }

  function handleStatus(): string {
    if (!isConnected) {
      return "Status: **Disconnected**\n\nUse `/mattermost connect` to enable remote control.";
    }

    const sessions = sessionManager?.listSessions() || [];
    const wsStatus = wsClient?.isConnected() ? "Connected" : "Reconnecting...";

    return `Status: **Connected**
Bot: @${botUser?.username}
Project: ${projectName}
OpenCode Session: ${connectedOpenCodeSessionId || 'none'}
Active MM Sessions: ${sessions.length}
WebSocket: ${wsStatus}`;
  }

  function setupEventListeners(): void {
    wsClient!.on("hello", (_event: WebSocketEvent) => {
      log.info("Received hello event - connection authenticated");
    });

    wsClient!.on("posted", async (event: WebSocketEvent) => {
      log.debug("Received posted event");
      if (!isConnected) return;

      try {
        const postData = typeof event.data.post === "string" ? JSON.parse(event.data.post) : event.data.post;
        log.debug(`Post from user ${postData.user_id} in channel ${postData.channel_id}`);
        if (postData.user_id === botUser!.id) return;

        const channel = await mmClient!.getChannel(postData.channel_id);
        log.debug(`Channel type: ${channel.type}`);
        if (channel.type !== "D") return;

        log.info("Processing DM message...");
        await handleUserMessage(postData);
      } catch (error) {
        log.error("Error handling posted event:", error);
      }
    });

    wsClient!.on("reaction_added", async (event: WebSocketEvent) => {
      if (!isConnected || !reactionHandler) return;
      await reactionHandler.handleReaction(event);
    });
  }

  async function handleUserMessage(post: Post): Promise<void> {
    if (!sessionManager || !streamer || !notifications || !fileHandler) return;

    let session;
    try {
      session = await sessionManager.getOrCreateSession(post.user_id);
    } catch (error) {
      log.error("Failed to get/create session:", error);
      return;
    }

    session.isProcessing = true;
    session.currentPromptPostId = post.id;
    session.lastPrompt = post;

    let promptText = post.message;

    try {
      if (post.file_ids?.length > 0) {
        const filePaths = await fileHandler.processInboundAttachments(post.file_ids);
        if (filePaths.length > 0) {
          promptText += `\n\n[Attached files: ${filePaths.join(", ")}]`;
        }
      }

      const streamCtx = await streamer.startStream(session);
      session.currentResponsePostId = streamCtx.postId;

      if (!connectedOpenCodeSessionId) {
        throw new Error("No OpenCode session bound - reconnect to Mattermost");
      }

      log.info(`Using bound OpenCode session: ${connectedOpenCodeSessionId}`);

      pendingResponseContext = {
        opencodeSessionId: "",
        mmSession: session,
        streamCtx,
        responseBuffer: "",
        thinkingBuffer: "",
        toolsPostId: null,
        toolCalls: [],
        lastUpdateTime: Date.now(),
      };

      await client.session.promptAsync({
        path: { id: connectedOpenCodeSessionId },
        body: {
          parts: [{ type: "text", text: `[Mattermost DM from @${session.mattermostUsername}]: ${promptText}` }],
        },
      });

      log.info(`Successfully injected prompt into session ${connectedOpenCodeSessionId}`);

    } catch (error) {
      log.error("Error processing message:", error);
      if (notifications && session) {
        await notifications.notifyError(session, error as Error);
      }
      session.isProcessing = false;
      pendingResponseContext = null;
    }
  }

  const mattermostConnectTool = {
    description: "Connect to Mattermost for remote control via DMs",
    args: {},
    async execute() {
      return await handleConnect();
    },
  };

  const mattermostDisconnectTool = {
    description: "Disconnect from Mattermost remote control",
    args: {},
    async execute() {
      return await handleDisconnect();
    },
  };

  const mattermostStatusTool = {
    description: "Show Mattermost connection status",
    args: {},
    async execute() {
      return handleStatus();
    },
  };

  return {
    tool: {
      mattermost_connect: mattermostConnectTool,
      mattermost_disconnect: mattermostDisconnectTool,
      mattermost_status: mattermostStatusTool,
    },

    event: async ({ event }) => {
      if (!isConnected) return;

      if (event.type === "message.part.updated" && pendingResponseContext && streamer) {
        const part = (event as any).properties?.part;
        const delta = (event as any).properties?.delta;
        const sessionId = part?.sessionID || (event as any).properties?.sessionID;
        
        if (!delta || delta.length === 0) return;
        
        if (part?.type === "text" || part?.type === "thinking") {
          if (!pendingResponseContext.opencodeSessionId) {
            pendingResponseContext.opencodeSessionId = sessionId;
            log.info(`Locked onto session: ${sessionId}`);
          }
          
          if (sessionId !== pendingResponseContext.opencodeSessionId) return;
          
          if (part?.type === "text") {
            pendingResponseContext.responseBuffer += delta;
          } else if (part?.type === "thinking") {
            pendingResponseContext.thinkingBuffer += delta;
          }
          
          pendingResponseContext.lastUpdateTime = Date.now();
          
          const formattedOutput = formatResponseWithThinking(
            pendingResponseContext.responseBuffer,
            pendingResponseContext.thinkingBuffer
          );
          
          try {
            await streamer.updateStream(pendingResponseContext.streamCtx, formattedOutput);
          } catch (e) {
            log.error("Failed to update stream:", e);
          }
        }
      }

      if (event.type === "session.idle" && pendingResponseContext && streamer && notifications) {
        const sessionId = (event as any).properties?.sessionID;
        if (sessionId === pendingResponseContext.opencodeSessionId) {
          try {
            if (toolUpdateTimer) {
              clearTimeout(toolUpdateTimer);
              toolUpdateTimer = null;
            }
            await updateToolsPost();
            
            pendingResponseContext.streamCtx.buffer = pendingResponseContext.responseBuffer;
            await streamer.endStream(pendingResponseContext.streamCtx);
            await notifications.notifyCompletion(pendingResponseContext.mmSession, "Response complete");
            pendingResponseContext.mmSession.isProcessing = false;
          } catch (e) {
            log.error("Error finalizing stream:", e);
          }
          pendingResponseContext = null;
        }
      }

      if (event.type === "file.edited" && pendingResponseContext && fileHandler) {
        try {
          const filePath = (event as any).properties?.path;
          if (filePath) {
            await fileHandler.sendOutboundFile(pendingResponseContext.mmSession, filePath, `File updated: \`${filePath}\``);
          }
        } catch (e) {
          log.error("Failed to send file update:", e);
        }
      }
    },

    "tool.execute.after": async (input) => {
      if (!isConnected || !pendingResponseContext) return;
      
      addToolCall(input.tool);
    },
  };
};

export default MattermostControlPlugin;
