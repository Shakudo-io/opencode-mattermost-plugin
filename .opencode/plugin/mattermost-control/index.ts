import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { MattermostClient } from "../../../src/clients/mattermost-client.js";
import { MattermostWebSocketClient } from "../../../src/clients/websocket-client.js";
import { SessionManager, type UserSession } from "../../../src/session-manager.js";
import { ResponseStreamer } from "../../../src/response-streamer.js";
import { NotificationService } from "../../../src/notification-service.js";
import { FileHandler } from "../../../src/file-handler.js";
import { ReactionHandler } from "../../../src/reaction-handler.js";
import { OpenCodeSessionRegistry } from "../../../src/opencode-session-registry.js";
import { MessageRouter } from "../../../src/message-router.js";
import { CommandHandler } from "../../../src/command-handler.js";
import { loadConfig } from "../../../src/config.js";
import { log } from "../../../src/logger.js";
import type { User, Post, WebSocketEvent } from "../../../src/models/index.js";

let isConnected = false;
let mmClient: MattermostClient | null = null;
let wsClient: MattermostWebSocketClient | null = null;
let sessionManager: SessionManager | null = null;
let streamer: ResponseStreamer | null = null;
let notifications: NotificationService | null = null;
let fileHandler: FileHandler | null = null;
let reactionHandler: ReactionHandler | null = null;
let openCodeSessionRegistry: OpenCodeSessionRegistry | null = null;
let messageRouter: MessageRouter | null = null;
let commandHandler: CommandHandler | null = null;
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
  let config = loadConfig();
  projectName = (project as any)?.name || directory.split("/").pop() || "opencode";

  log.info("Loaded (not connected - use /mattermost connect)");

  async function handleConnect(): Promise<string> {
    if (isConnected) {
      return `Already connected to Mattermost as @${botUser?.username}. Use /mattermost status for details.`;
    }

    config = loadConfig();

    if (!config.mattermost.token) {
      return "✗ MATTERMOST_TOKEN environment variable is required. Set it before connecting.";
    }

    if (config.mattermost.baseUrl.includes("your-mattermost-instance.example.com")) {
      return "✗ MATTERMOST_URL environment variable is required. Set it before connecting.";
    }

    try {
      log.info("Creating Mattermost clients...");
      log.debug(`Config mattermost: ${JSON.stringify(config?.mattermost || 'undefined')}`);
      mmClient = new MattermostClient(config.mattermost);
      wsClient = new MattermostWebSocketClient(config.mattermost);
      log.info("Clients created, connecting WebSocket...");
      
      await wsClient.connect();
      log.info("WebSocket connected, getting bot user...");
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

      openCodeSessionRegistry = new OpenCodeSessionRegistry(config.sessionSelection.refreshIntervalMs);
      openCodeSessionRegistry.initialize(client.session);
      await openCodeSessionRegistry.refresh();
      openCodeSessionRegistry.startAutoRefresh();

      messageRouter = new MessageRouter(config.sessionSelection.commandPrefix);
      commandHandler = new CommandHandler(config.sessionSelection.commandPrefix);

      const availableSessions = openCodeSessionRegistry.listAvailable();
      if (availableSessions.length > 0) {
        log.info(`Found ${availableSessions.length} OpenCode session(s)`);
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
      openCodeSessionRegistry?.clear();

      isConnected = false;
      mmClient = null;
      wsClient = null;
      sessionManager = null;
      streamer = null;
      notifications = null;
      fileHandler = null;
      reactionHandler = null;
      openCodeSessionRegistry = null;
      messageRouter = null;
      commandHandler = null;

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

    const mmSessions = sessionManager?.listSessions() || [];
    const wsStatus = wsClient?.isConnected() ? "Connected" : "Reconnecting...";
    const availableOpenCodeSessions = openCodeSessionRegistry?.countAvailable() || 0;
    const defaultSession = openCodeSessionRegistry?.getDefault();

    return `Status: **Connected**
Bot: @${botUser?.username}
Project: ${projectName}
OpenCode Sessions: ${availableOpenCodeSessions} available
Default Session: ${defaultSession ? `${defaultSession.projectName} (${defaultSession.shortId})` : 'none'}
Active MM Sessions: ${mmSessions.length}
WebSocket: ${wsStatus}

Use \`!sessions\` in DM to see and select OpenCode sessions.`;
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
    if (!sessionManager || !streamer || !notifications || !fileHandler || !messageRouter || !commandHandler || !openCodeSessionRegistry || !mmClient) return;

    let userSession: UserSession;
    try {
      userSession = await sessionManager.getOrCreateSession(post.user_id);
      log.info(`[DEBUG-A] Session obtained for ${userSession.mattermostUsername}`);
    } catch (error) {
      log.error("Failed to get/create session:", error);
      return;
    }

    log.info(`[DEBUG-B] About to route message`);
    log.info(`[ROUTING] Post message content: "${post.message}"`);
    const routeResult = messageRouter.route(post);
    log.info(`[ROUTING] Route result: type=${routeResult.type}, command=${routeResult.command?.name || 'none'}`);

    if (routeResult.type === "command" && routeResult.command) {
      log.info(`Processing command: ${routeResult.command.name}`);
      const result = await commandHandler.execute(routeResult.command, {
        userSession,
        registry: openCodeSessionRegistry,
        mmClient,
      });
      await mmClient.createPost(userSession.dmChannelId, result.message);
      return;
    }

    userSession.isProcessing = true;
    userSession.currentPromptPostId = post.id;
    userSession.lastPrompt = post;

    let promptText = routeResult.promptText || post.message;

    try {
      if (post.file_ids?.length > 0) {
        const filePaths = await fileHandler.processInboundAttachments(post.file_ids);
        if (filePaths.length > 0) {
          promptText += `\n\n[Attached files: ${filePaths.join(", ")}]`;
        }
      }

      const streamCtx = await streamer.startStream(userSession);
      userSession.currentResponsePostId = streamCtx.postId;

      const targetSessionId = resolveTargetSession(userSession);
      if (!targetSessionId) {
        throw new Error("No OpenCode session available. Use `!sessions` to see options.");
      }

      log.info(`Using OpenCode session: ${targetSessionId}`);

      pendingResponseContext = {
        opencodeSessionId: "",
        mmSession: userSession,
        streamCtx,
        responseBuffer: "",
        thinkingBuffer: "",
        toolsPostId: null,
        toolCalls: [],
        lastUpdateTime: Date.now(),
      };

      await client.session.promptAsync({
        path: { id: targetSessionId },
        body: {
          parts: [{ type: "text", text: `[Mattermost DM from @${userSession.mattermostUsername}]: ${promptText}` }],
        },
      });

      log.info(`Successfully injected prompt into session ${targetSessionId}`);

    } catch (error) {
      log.error("Error processing message:", error);
      if (notifications && userSession) {
        await notifications.notifyError(userSession, error as Error);
      }
      userSession.isProcessing = false;
      pendingResponseContext = null;
    }
  }

  function resolveTargetSession(userSession: UserSession): string | null {
    if (!openCodeSessionRegistry) return null;

    if (userSession.targetOpenCodeSessionId) {
      const targetSession = openCodeSessionRegistry.get(userSession.targetOpenCodeSessionId);
      if (targetSession?.isAvailable) {
        return targetSession.id;
      }
      userSession.targetOpenCodeSessionId = null;
    }

    const defaultSession = openCodeSessionRegistry.getDefault();
    return defaultSession?.id || null;
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

  const mattermostListSessionsTool = {
    description: "List available OpenCode sessions that can receive prompts from Mattermost",
    args: {},
    async execute() {
      if (!isConnected || !openCodeSessionRegistry) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      try {
        await openCodeSessionRegistry.refresh();
      } catch (e) {
        log.warn("Failed to refresh sessions:", e);
      }

      const sessions = openCodeSessionRegistry.listAvailable();
      if (sessions.length === 0) {
        return "No active OpenCode sessions found.";
      }

      const defaultSession = openCodeSessionRegistry.getDefault();
      const lines = sessions.map((s, i) => {
        const isDefault = s.id === defaultSession?.id;
        return `${i + 1}. ${s.projectName} (${s.shortId})${isDefault ? " [default]" : ""}\n   Directory: ${s.directory}`;
      });

      return `Available OpenCode Sessions:\n\n${lines.join("\n\n")}`;
    },
  };

  const mattermostSelectSessionTool = tool({
    description: "Select which OpenCode session should receive prompts from a Mattermost user",
    args: {
      sessionId: tool.schema.string().describe("Session ID (full or short 6-char ID) or project name"),
      mattermostUserId: tool.schema.string().optional().describe("Mattermost user ID to set session for (optional, defaults to all users)"),
    },
    async execute(args) {
      if (!isConnected || !openCodeSessionRegistry || !sessionManager) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      const session = openCodeSessionRegistry.get(args.sessionId);
      if (!session) {
        return `Session not found: ${args.sessionId}. Use mattermost_list_sessions to see available sessions.`;
      }

      if (!session.isAvailable) {
        return `Session ${session.shortId} (${session.projectName}) is not available.`;
      }

      if (args.mattermostUserId) {
        const userSession = sessionManager.getSession(args.mattermostUserId);
        if (userSession) {
          userSession.targetOpenCodeSessionId = session.id;
          return `Set session ${session.shortId} (${session.projectName}) as target for Mattermost user.`;
        }
        return `Mattermost user session not found. User must DM the bot first.`;
      }

      openCodeSessionRegistry.setDefault(session.id);
      return `Set ${session.shortId} (${session.projectName}) as the default OpenCode session for all Mattermost users.`;
    },
  });

  const mattermostCurrentSessionTool = tool({
    description: "Show the currently targeted OpenCode session for a Mattermost user",
    args: {
      mattermostUserId: tool.schema.string().optional().describe("Mattermost user ID to check (optional, shows default if not specified)"),
    },
    async execute(args) {
      if (!isConnected || !openCodeSessionRegistry || !sessionManager) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      if (args.mattermostUserId) {
        const userSession = sessionManager.getSession(args.mattermostUserId);
        if (!userSession) {
          return `No active Mattermost session for user ${args.mattermostUserId}. User must DM the bot first.`;
        }

        const targetId = userSession.targetOpenCodeSessionId;
        if (!targetId) {
          const defaultSession = openCodeSessionRegistry.getDefault();
          if (defaultSession) {
            return `User @${userSession.mattermostUsername} has no explicit session selected.\nUsing default: ${defaultSession.projectName} (${defaultSession.shortId})\nDirectory: ${defaultSession.directory}`;
          }
          return `User @${userSession.mattermostUsername} has no session selected and no default is available.`;
        }

        const session = openCodeSessionRegistry.get(targetId);
        if (!session || !session.isAvailable) {
          return `User @${userSession.mattermostUsername}'s selected session is no longer available.`;
        }

        return `User @${userSession.mattermostUsername} is targeting:\nProject: ${session.projectName}\nID: ${session.shortId}\nDirectory: ${session.directory}\nLast updated: ${session.lastUpdated.toISOString()}`;
      }

      const defaultSession = openCodeSessionRegistry.getDefault();
      if (!defaultSession) {
        return "No default OpenCode session is set. Use mattermost_list_sessions to see available sessions.";
      }

      return `Default OpenCode session:\nProject: ${defaultSession.projectName}\nID: ${defaultSession.shortId}\nDirectory: ${defaultSession.directory}\nLast updated: ${defaultSession.lastUpdated.toISOString()}`;
    },
  });

  return {
    tool: {
      mattermost_connect: mattermostConnectTool,
      mattermost_disconnect: mattermostDisconnectTool,
      mattermost_status: mattermostStatusTool,
      mattermost_list_sessions: mattermostListSessionsTool,
      mattermost_select_session: mattermostSelectSessionTool,
      mattermost_current_session: mattermostCurrentSessionTool,
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
