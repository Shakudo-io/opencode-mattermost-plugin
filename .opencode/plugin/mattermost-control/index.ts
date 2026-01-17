import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { MattermostClient } from "../../../src/clients/mattermost-client.js";
import { MattermostWebSocketClient } from "../../../src/clients/websocket-client.js";
import { SessionManager, type UserSession } from "../../../src/session-manager.js";
import { ResponseStreamer } from "../../../src/response-streamer.js";
import { NotificationService } from "../../../src/notification-service.js";
import { FileHandler } from "../../../src/file-handler.js";
import { ReactionHandler } from "../../../src/reaction-handler.js";
import { OpenCodeSessionRegistry, type OpenCodeSessionInfo } from "../../../src/opencode-session-registry.js";
import { MessageRouter } from "../../../src/message-router.js";
import { CommandHandler } from "../../../src/command-handler.js";
import { MonitorService, handleMonitorAlert, type MonitoredSession } from "../../../src/monitor-service.js";
import { ThreadMappingStore } from "../../../src/persistence/thread-mapping-store.js";
import { ThreadManager } from "../../../src/thread-manager.js";
import { loadConfig } from "../../../src/config.js";
import { log } from "../../../src/logger.js";
import type { User, Post, WebSocketEvent, ThreadSessionMapping } from "../../../src/models/index.js";
import type { InboundRouteResult } from "../../../src/models/routing.js";

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
let threadMappingStore: ThreadMappingStore | null = null;
let threadManager: ThreadManager | null = null;
let botUser: User | null = null;
let projectName: string = "";
interface ResponseContext {
  opencodeSessionId: string;
  mmSession: any;
  streamCtx: any;
  threadRootPostId?: string;
  responseBuffer: string;
  thinkingBuffer: string;
  toolsPostId: string | null;
  toolCalls: string[];
  lastUpdateTime: number;
}

const activeResponseContexts: Map<string, ResponseContext> = new Map();

const TOOL_UPDATE_INTERVAL_MS = 1000;
const toolUpdateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

async function updateToolsPost(sessionId: string): Promise<void> {
  const ctx = activeResponseContexts.get(sessionId);
  if (!ctx || !mmClient || ctx.toolCalls.length === 0) return;

  const toolCounts = ctx.toolCalls.reduce((acc, tool) => {
    acc[tool] = (acc[tool] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const summary = Object.entries(toolCounts)
    .map(([tool, count]) => count > 1 ? `${tool} ×${count}` : tool)
    .join(", ");

  const message = `:hammer_and_wrench: **Tools:** ${summary}`;

  try {
    if (ctx.toolsPostId) {
      await mmClient.updatePost(ctx.toolsPostId, message);
    } else {
      const post = await mmClient.createPost(
        ctx.mmSession.dmChannelId, 
        message,
        ctx.threadRootPostId
      );
      ctx.toolsPostId = post.id;
    }
  } catch (e) {
    log.error("Failed to update tools post:", e);
  }
}

function scheduleToolUpdate(sessionId: string): void {
  if (toolUpdateTimers.has(sessionId)) return;
  
  const timer = setTimeout(async () => {
    toolUpdateTimers.delete(sessionId);
    await updateToolsPost(sessionId);
  }, TOOL_UPDATE_INTERVAL_MS);
  
  toolUpdateTimers.set(sessionId, timer);
}

function addToolCall(sessionId: string, toolName: string): void {
  const ctx = activeResponseContexts.get(sessionId);
  if (!ctx) return;
  ctx.toolCalls.push(toolName);
  scheduleToolUpdate(sessionId);
}

function clearToolTimer(sessionId: string): void {
  const timer = toolUpdateTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    toolUpdateTimers.delete(sessionId);
  }
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
  projectName = directory.split("/").pop() || "opencode";

  threadMappingStore = new ThreadMappingStore();
  threadMappingStore.load().catch((e) => log.warn("[Plugin] Failed to load thread mappings:", e));

  if (config.mattermost.autoConnect && config.mattermost.token) {
    log.info("Auto-connect enabled, connecting to Mattermost...");
    setTimeout(async () => {
      const result = await handleConnect();
      log.info(`Auto-connect result: ${result.split('\n')[0]}`);
    }, 100);
  } else {
    log.info("Loaded (not connected - use /mattermost connect)");
  }

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

      if (threadMappingStore) {
        messageRouter.setThreadLookup((threadRootPostId) => 
          threadMappingStore!.getByThreadRootPostId(threadRootPostId)
        );
      }

      if (threadMappingStore) {
        threadManager = new ThreadManager(mmClient, threadMappingStore);
      }

      openCodeSessionRegistry.onNewSession(async (sessionInfo) => {
        if (!threadManager || !sessionManager) return;
        
        const existingMapping = threadMappingStore?.getBySessionId(sessionInfo.id);
        if (existingMapping) {
          log.debug(`[AutoThread] Thread already exists for session ${sessionInfo.shortId}`);
          return;
        }
        
        const mmSessions = sessionManager.listSessions();
        if (mmSessions.length === 0) {
          log.debug(`[AutoThread] No active Mattermost users, skipping thread creation for ${sessionInfo.shortId}`);
          return;
        }
        
        for (const mmSession of mmSessions) {
          try {
            await threadManager.createThread(sessionInfo, mmSession.mattermostUserId, mmSession.dmChannelId);
            log.info(`[AutoThread] Created thread for session ${sessionInfo.shortId} for user ${mmSession.mattermostUsername}`);
          } catch (e) {
            log.error(`[AutoThread] Failed to create thread for session ${sessionInfo.shortId}:`, e);
          }
        }
      });

      openCodeSessionRegistry.onSessionDeleted(async (sessionId, _sessionInfo) => {
        if (!threadManager) return;
        
        try {
          await threadManager.endThread(sessionId);
          log.info(`[AutoThread] Ended thread for session ${sessionId.substring(0, 8)}`);
        } catch (e) {
          log.error(`[AutoThread] Failed to end thread for session ${sessionId.substring(0, 8)}:`, e);
        }
      });

      const availableSessions = openCodeSessionRegistry.listAvailable();
      
      // T044: Clean orphaned mappings (sessions no longer available)
      if (threadMappingStore) {
        const validSessionIds = new Set(availableSessions.map(s => s.id));
        const cleanedCount = threadMappingStore.cleanOrphaned(validSessionIds);
        if (cleanedCount > 0) {
          log.info(`[AutoThread] Marked ${cleanedCount} orphaned mappings`);
        }
      }

      // T046: Create threads for existing sessions on connect
      if (threadManager && sessionManager && availableSessions.length > 0) {
        const mmSessions = sessionManager.listSessions();
        if (mmSessions.length > 0) {
          for (const sessionInfo of availableSessions) {
            const existingMapping = threadMappingStore?.getBySessionId(sessionInfo.id);
            if (!existingMapping) {
              for (const mmSession of mmSessions) {
                try {
                  await threadManager.createThread(sessionInfo, mmSession.mattermostUserId, mmSession.dmChannelId);
                  log.info(`[AutoThread] Created thread for existing session ${sessionInfo.shortId}`);
                } catch (e) {
                  log.error(`[AutoThread] Failed to create thread for existing session ${sessionInfo.shortId}:`, e);
                }
              }
            }
          }
        }
      }
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
      for (const [sessionId, timer] of toolUpdateTimers) {
        clearTimeout(timer);
        await updateToolsPost(sessionId);
      }
      toolUpdateTimers.clear();
      activeResponseContexts.clear();
      
      wsClient!.disconnect();
      sessionManager?.shutdown();
      fileHandler?.cleanupTempFiles();
      openCodeSessionRegistry?.clear();
      threadMappingStore?.shutdown();

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
      threadManager = null;

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
    } catch (error) {
      log.error("Failed to get/create session:", error);
      return;
    }

    // Create threads for any sessions that don't have mappings yet
    // This handles sessions that existed before MM connection or in different project contexts
    if (threadManager && threadMappingStore) {
      const availableSessions = openCodeSessionRegistry.listAvailable();
      for (const sessionInfo of availableSessions) {
        const existingMapping = threadMappingStore.getBySessionId(sessionInfo.id);
        if (!existingMapping) {
          try {
            await threadManager.createThread(sessionInfo, userSession.mattermostUserId, userSession.dmChannelId);
            log.info(`[AutoThread] Created thread for session ${sessionInfo.shortId} for user ${userSession.mattermostUsername}`);
          } catch (e) {
            log.error(`[AutoThread] Failed to create thread:`, e);
          }
        }
      }
    }

    const routeResult = threadMappingStore 
      ? messageRouter.routeWithThreads(post)
      : convertLegacyRoute(messageRouter.route(post), post);
    
    log.debug(`[ROUTING] type=${routeResult.type}`);

    switch (routeResult.type) {
      case "main_dm_command": {
        const result = await commandHandler.execute(routeResult.command, {
          userSession,
          registry: openCodeSessionRegistry,
          mmClient,
          threadMappingStore,
        });
        await mmClient.createPost(userSession.dmChannelId, result.message);
        return;
      }
      
      case "main_dm_prompt": {
        // Main DM prompts always create a new session when autoCreateSession is enabled
        // This makes the main DM channel the "new session launcher"
        // Use threads to continue existing sessions
        if (config.sessionSelection.autoCreateSession) {
          const newSession = await createNewSessionFromDm(userSession, post);
          if (newSession) {
            await handleThreadPrompt({
              sessionId: newSession.sessionId,
              threadRootPostId: newSession.threadRootPostId,
              promptText: post.message.trim(),
              fileIds: post.file_ids,
            }, userSession, post);
          }
          return;
        }
        
        // autoCreateSession is disabled - show error with guidance
        await mmClient.createPost(
          userSession.dmChannelId,
          `:warning: ${routeResult.errorMessage}\n\n${routeResult.suggestedAction}`
        );
        return;
      }
      
      case "unknown_thread": {
        await mmClient.createPost(
          userSession.dmChannelId,
          routeResult.errorMessage,
          routeResult.threadRootPostId
        );
        return;
      }
      
      case "ended_session": {
        await mmClient.createPost(
          userSession.dmChannelId,
          `:no_entry: ${routeResult.errorMessage}`,
          routeResult.threadRootPostId
        );
        return;
      }
      
      case "thread_prompt": {
        await handleThreadPrompt(routeResult, userSession, post);
        return;
      }
    }
  }

  function convertLegacyRoute(legacyResult: { type: string; command?: any; promptText?: string }, post: Post): InboundRouteResult {
    if (legacyResult.type === "command" && legacyResult.command) {
      return { type: "main_dm_command", command: legacyResult.command };
    }
    
    const defaultSession = openCodeSessionRegistry?.getDefault();
    if (!defaultSession) {
      return {
        type: "main_dm_prompt",
        errorMessage: "No OpenCode session available.",
        suggestedAction: "Start an OpenCode session first.",
      };
    }
    
    return {
      type: "thread_prompt",
      sessionId: defaultSession.id,
      threadRootPostId: "",
      promptText: legacyResult.promptText || post.message,
      fileIds: post.file_ids,
    };
  }

  async function createNewSessionFromDm(
    userSession: UserSession,
    post: Post
  ): Promise<{ sessionId: string; threadRootPostId: string } | null> {
    if (!mmClient || !threadManager) return null;
    
    try {
      const result = await client.session.create({
        body: {},
        query: {
          directory: directory
        }
      });
      
      if (!result.data) {
        throw new Error("Failed to create session - no data returned");
      }
      
      const sessionInfo: OpenCodeSessionInfo = {
        id: result.data.id,
        shortId: result.data.id.substring(0, 8),
        projectName: projectName,
        directory: directory,
        title: result.data.title || `Mattermost DM session`,
        lastUpdated: new Date(),
        isAvailable: true,
      };
      
      const mapping = await threadManager.createThread(
        sessionInfo,
        userSession.mattermostUserId,
        userSession.dmChannelId,
        post.id
      );
      
      await openCodeSessionRegistry?.refresh();
      
      log.info(`[CreateSession] Created new session ${sessionInfo.shortId} for @${userSession.mattermostUsername}`);
      
      return {
        sessionId: result.data.id,
        threadRootPostId: mapping.threadRootPostId,
      };
    } catch (error) {
      log.error("[CreateSession] Failed:", error);
      await mmClient.createPost(
        userSession.dmChannelId,
        `:x: Failed to create session: ${error instanceof Error ? error.message : "Unknown error"}`,
        post.id
      );
      return null;
    }
  }

  async function handleThreadPrompt(
    route: { sessionId: string; threadRootPostId: string; promptText: string; fileIds?: string[] },
    userSession: UserSession,
    post: Post
  ): Promise<void> {
    if (!streamer || !notifications || !fileHandler || !mmClient) return;

    userSession.isProcessing = true;
    userSession.currentPromptPostId = post.id;
    userSession.lastPrompt = post;

    let promptText = route.promptText;
    const threadRootPostId = route.threadRootPostId || undefined;
    const targetSessionId = route.sessionId;
    const shortId = targetSessionId.substring(0, 8);

    const { streamCtx, statusIndicator } = await streamer.startStreamWithStatus(
      userSession,
      threadRootPostId,
      "Checking session status..."
    );
    userSession.currentResponsePostId = streamCtx.postId;

    try {
      let sessionIsBusy = false;
      let sessionIsRetrying = false;
      let retryInfo: { attempt?: number; maxAttempts?: number } = {};

      try {
        const statusResult = await client.session.status();
        const statusMap = statusResult.data as Record<string, { type: string; attempt?: number; maxAttempts?: number }> | undefined;
        
        if (statusMap && statusMap[targetSessionId]) {
          const sessionStatus = statusMap[targetSessionId];
          log.debug(`[StatusCheck] Session ${shortId} status: ${sessionStatus.type}`);
          
          if (sessionStatus.type === "busy") {
            sessionIsBusy = true;
          } else if (sessionStatus.type === "retry") {
            sessionIsRetrying = true;
            retryInfo = {
              attempt: sessionStatus.attempt,
              maxAttempts: sessionStatus.maxAttempts,
            };
          }
        }
      } catch (e) {
        log.debug(`[StatusCheck] Could not get session status: ${e}`);
      }

      if (sessionIsBusy) {
        await statusIndicator.setQueued("Session is busy processing another request", 1);
      } else if (sessionIsRetrying) {
        await statusIndicator.setRetrying(
          retryInfo.attempt || 1,
          retryInfo.maxAttempts || 3,
          "Session is retrying a previous operation",
          5000
        );
      } else {
        await statusIndicator.setConnecting(targetSessionId, shortId);
      }

      if (route.fileIds && route.fileIds.length > 0) {
        const filePaths = await fileHandler.processInboundAttachments(route.fileIds);
        if (filePaths.length > 0) {
          promptText += `\n\n[Attached files: ${filePaths.join(", ")}]`;
        }
      }

      log.info(`Using OpenCode session: ${targetSessionId}`);

      if (threadMappingStore) {
        const mapping = threadMappingStore.getBySessionId(targetSessionId);
        if (mapping) {
          mapping.lastActivityAt = new Date().toISOString();
          threadMappingStore.update(mapping);
        }
      }

      const responseContext: ResponseContext = {
        opencodeSessionId: targetSessionId,
        mmSession: userSession,
        streamCtx,
        threadRootPostId,
        responseBuffer: "",
        thinkingBuffer: "",
        toolsPostId: null,
        toolCalls: [],
        lastUpdateTime: Date.now(),
      };
      
      activeResponseContexts.set(targetSessionId, responseContext);

      // Build reply context for agents with other Mattermost integrations
      const replyContext = threadRootPostId 
        ? `[Reply-To: thread=${threadRootPostId} post=${post.id} channel=${userSession.dmChannelId}]`
        : `[Reply-To: post=${post.id} channel=${userSession.dmChannelId}]`;
      
      const promptMessage = `[Mattermost DM from @${userSession.mattermostUsername}]\n${replyContext}\n${promptText}`;
      
      log.debug(`Injecting prompt into session ${targetSessionId}: "${promptMessage.slice(0, 150)}..."`);
      
      await statusIndicator.setProcessing();
      
      await client.session.promptAsync({
        path: { id: targetSessionId },
        body: {
          parts: [{ type: "text", text: promptMessage }],
        },
      });

      log.info(`Prompt injected into session ${targetSessionId} from @${userSession.mattermostUsername}`);

    } catch (error) {
      log.error("Error processing message:", error);
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      await statusIndicator.setError(errorMsg, true);
      
      if (notifications && userSession) {
        await notifications.notifyError(userSession, error as Error);
      }
      userSession.isProcessing = false;
      activeResponseContexts.delete(route.sessionId);
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

  const mattermostMonitorTool = tool({
    description: "Monitor an OpenCode session for events (permission requests, idle, questions). Sends DM alerts when the session needs attention.",
    args: {
      sessionId: tool.schema.string().optional().describe("Session ID to monitor. Defaults to current session if not specified."),
      targetUser: tool.schema.string().optional().describe("Mattermost username to notify (required if not connected to Mattermost)."),
      persistent: tool.schema.boolean().optional().describe("Keep monitoring after each alert (default: true). Set to false for one-time alerts."),
    },
    async execute(args) {
      const config = loadConfig();

      if (!config.mattermost.token) {
        return "✗ MATTERMOST_TOKEN environment variable is required.";
      }

      if (config.mattermost.baseUrl.includes("your-mattermost-instance.example.com")) {
        return "✗ MATTERMOST_URL environment variable is required.";
      }

      let targetSessionId = args.sessionId;
      let targetProjectName = projectName;
      let targetDirectory = directory;
      let targetSessionTitle: string | undefined;

      if (!targetSessionId) {
        if (openCodeSessionRegistry) {
          const defaultSession = openCodeSessionRegistry.getDefault();
          if (defaultSession) {
            targetSessionId = defaultSession.id;
            targetProjectName = defaultSession.projectName;
            targetDirectory = defaultSession.directory;
          }
        }
        
        if (!targetSessionId) {
          try {
            // First try session.status() which returns currently active sessions
            const statusResult = await client.session.status();
            const statusMap = statusResult.data as Record<string, { type: string }> | undefined;
            
            if (statusMap && Object.keys(statusMap).length > 0) {
              const activeSessionIds = Object.keys(statusMap);
              log.debug(`[Monitor] session.status() returned ${activeSessionIds.length} active sessions: ${activeSessionIds.join(', ')}`);
              
              // Prefer a "busy" session, otherwise take the first active one
              const busySessionId = activeSessionIds.find(id => statusMap[id]?.type === 'busy');
              targetSessionId = busySessionId || activeSessionIds[0];
              log.debug(`[Monitor] Using active session: ${targetSessionId} (status: ${statusMap[targetSessionId]?.type})`);
            }
            
            // Fallback to session list if status didn't help
            if (!targetSessionId) {
              const sessions = await client.session.list();
              log.debug(`[Monitor] client.session.list() returned ${sessions.data?.length || 0} sessions`);
              if (sessions.data && sessions.data.length > 0) {
                // Sort by time.updated (most recently active first)
                const sortedSessions = [...sessions.data]
                  .filter((s: any) => s.directory === directory)
                  .sort((a: any, b: any) => {
                    const timeA = a.time?.updated || a.time?.created || 0;
                    const timeB = b.time?.updated || b.time?.created || 0;
                    return timeB - timeA;
                  });
                
                log.debug(`[Monitor] Found ${sortedSessions.length} sessions for directory, top 3: ${sortedSessions.slice(0, 3).map((s: any) => `${s.id}(updated:${s.time?.updated})`).join(', ')}`);
                
                const currentSession = sortedSessions[0] || sessions.data[0];
                targetSessionId = currentSession.id;
                
                log.debug(`[Monitor] Using session ID: ${targetSessionId} (updated: ${currentSession.time?.updated})`);
                targetProjectName = currentSession.directory.split("/").pop() || "opencode";
                targetDirectory = currentSession.directory;
              }
            }
          } catch (e) {
            log.warn("Failed to get session:", e);
          }
        }
      } else if (openCodeSessionRegistry) {
        const session = openCodeSessionRegistry.get(targetSessionId);
        if (session) {
          targetSessionId = session.id;
          targetProjectName = session.projectName;
          targetDirectory = session.directory;
        }
      }

      if (!targetSessionId) {
        return "✗ No session ID provided and could not determine current session.";
      }

      try {
        const sessionDetails = await client.session.get({ path: { id: targetSessionId } });
        if (sessionDetails.data) {
          targetSessionTitle = (sessionDetails.data as any).title;
        }
      } catch (e) {
        log.debug(`[Monitor] Could not fetch session details: ${e}`);
      }

      if (MonitorService.isMonitored(targetSessionId)) {
        return `Session ${targetSessionId.substring(0, 8)} is already being monitored.`;
      }

      let mattermostUserId: string;
      let mattermostUsername: string;

      if (args.targetUser) {
        try {
          const tempClient = new MattermostClient(config.mattermost);
          const user = await tempClient.getUserByUsername(args.targetUser.replace(/^@/, ""));
          mattermostUserId = user.id;
          mattermostUsername = user.username;
        } catch (e) {
          return `✗ Could not find Mattermost user: ${args.targetUser}`;
        }
      } else if (botUser) {
        mattermostUserId = botUser.id;
        mattermostUsername = botUser.username;
      } else {
        return "✗ targetUser is required when not connected to Mattermost. Specify the Mattermost username to notify.";
      }

      const isPersistent = args.persistent !== false;
      
      const monitoredSession: MonitoredSession = {
        sessionId: targetSessionId,
        shortId: targetSessionId.substring(0, 8),
        mattermostUserId,
        mattermostUsername,
        projectName: targetProjectName,
        sessionTitle: targetSessionTitle,
        directory: targetDirectory,
        registeredAt: new Date(),
        persistent: isPersistent,
      };

      MonitorService.register(monitoredSession);

      const modeText = isPersistent 
        ? "_Persistent monitoring enabled. Use `mattermost_unmonitor` to stop._"
        : "_One-time alert. After notification, monitoring stops._";
      
      return `✓ Monitoring session ${monitoredSession.shortId} (${targetProjectName})\n✓ Will alert @${mattermostUsername} on permission request, idle, or question\n\n${modeText}`;
    },
  });

  const mattermostUnmonitorTool = tool({
    description: "Stop monitoring an OpenCode session. Stops all alerts for the specified or current session.",
    args: {
      sessionId: tool.schema.string().optional().describe("Session ID to stop monitoring. Defaults to current session if not specified."),
    },
    async execute(args) {
      let targetSessionId = args.sessionId;
      
      if (!targetSessionId) {
        try {
          const statusResult = await client.session.status();
          const statusMap = statusResult.data as Record<string, { type: string }> | undefined;
          if (statusMap && Object.keys(statusMap).length > 0) {
            const activeSessionIds = Object.keys(statusMap);
            const busySessionId = activeSessionIds.find(id => statusMap[id]?.type === 'busy');
            targetSessionId = busySessionId || activeSessionIds[0];
          }
        } catch (e) {
          log.warn("Failed to get session status:", e);
        }
      }
      
      if (!targetSessionId) {
        return "✗ No session ID provided and could not determine current session.";
      }
      
      if (!MonitorService.isMonitored(targetSessionId)) {
        return `Session ${targetSessionId.substring(0, 8)} is not being monitored.`;
      }
      
      MonitorService.unregister(targetSessionId);
      return `✓ Stopped monitoring session ${targetSessionId.substring(0, 8)}`;
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
      mattermost_monitor: mattermostMonitorTool,
      mattermost_unmonitor: mattermostUnmonitorTool,
    },

    event: async ({ event }) => {
      const eventType = event.type as string;
      const eventSessionId = (event as any).properties?.sessionID;

      if (eventType === "permission.asked") {
        log.debug(`[Monitor] permission.asked event: sessionId=${eventSessionId}`);
        const description = (event as any).properties?.description || "Permission requested";
        const activeSessionIds = Array.from(activeResponseContexts.keys());
        await handleMonitorAlert(eventSessionId, "permission.asked", description, activeSessionIds[0]);
        
        if (eventSessionId && isConnected) {
          const ctx = activeResponseContexts.get(eventSessionId);
          if (ctx?.streamCtx.statusIndicator) {
            await ctx.streamCtx.statusIndicator.setWaiting("permission", description);
          }
        }
      }

      if (eventType === "session.idle") {
        log.debug(`[Monitor] session.idle event: sessionId=${eventSessionId}, monitored=${MonitorService.isMonitored(eventSessionId || "")}`);
        if (eventSessionId) {
          const activeSessionIds = Array.from(activeResponseContexts.keys());
          await handleMonitorAlert(eventSessionId, "session.idle", undefined, activeSessionIds[0]);
        }
      }

      if (eventType === "session.status" && eventSessionId && isConnected) {
        const status = (event as any).properties?.status as { type: string; attempt?: number; maxAttempts?: number; error?: string } | undefined;
        const ctx = activeResponseContexts.get(eventSessionId);
        
        if (ctx?.streamCtx.statusIndicator && status) {
          log.debug(`[StatusEvent] Session ${eventSessionId.substring(0, 8)} status: ${status.type}`);
          
          switch (status.type) {
            case "busy":
              await ctx.streamCtx.statusIndicator.setProcessing();
              break;
            case "retry":
              await ctx.streamCtx.statusIndicator.setRetrying(
                status.attempt || 1,
                status.maxAttempts || 3,
                status.error || "Transient error",
                5000
              );
              break;
            case "idle":
              break;
          }
        }
      }

      if (!isConnected) return;

      if (event.type === "message.part.updated" && streamer) {
        const part = (event as any).properties?.part;
        const delta = (event as any).properties?.delta;
        const sessionId = part?.sessionID || (event as any).properties?.sessionID;
        
        if (!delta || delta.length === 0 || !sessionId) return;
        
        const ctx = activeResponseContexts.get(sessionId);
        if (!ctx) return;
        
        if (part?.type === "text" || part?.type === "thinking") {
          if (part?.type === "text") {
            ctx.responseBuffer += delta;
          } else if (part?.type === "thinking") {
            ctx.thinkingBuffer += delta;
          }
          
          ctx.lastUpdateTime = Date.now();
          
          const formattedOutput = formatResponseWithThinking(
            ctx.responseBuffer,
            ctx.thinkingBuffer
          );
          
          try {
            await streamer.updateStream(ctx.streamCtx, formattedOutput);
          } catch (e) {
            log.error("Failed to update stream:", e);
          }
        }
      }

      if (event.type === "session.idle" && streamer && notifications) {
        const sessionId = (event as any).properties?.sessionID;
        if (!sessionId) return;
        
        const ctx = activeResponseContexts.get(sessionId);
        if (ctx) {
          try {
            clearToolTimer(sessionId);
            await updateToolsPost(sessionId);
            
            ctx.streamCtx.buffer = ctx.responseBuffer;
            await streamer.endStream(ctx.streamCtx);
            await notifications.notifyCompletion(ctx.mmSession, "Response complete", ctx.streamCtx.threadRootPostId);
            ctx.mmSession.isProcessing = false;
          } catch (e) {
            log.error("Error finalizing stream:", e);
          }
          activeResponseContexts.delete(sessionId);
        }
      }

      if (event.type === "file.edited" && fileHandler) {
        const sessionId = (event as any).properties?.sessionID;
        if (!sessionId) return;
        
        const ctx = activeResponseContexts.get(sessionId);
        if (ctx) {
          try {
            const filePath = (event as any).properties?.path;
            if (filePath) {
              await fileHandler.sendOutboundFile(ctx.mmSession, filePath, `File updated: \`${filePath}\``);
            }
          } catch (e) {
            log.error("Failed to send file update:", e);
          }
        }
      }
    },

    "tool.execute.after": async (input) => {
      const toolSessionId = (input as any).sessionID || (input as any).session?.id;

      if (input.tool === "question" && toolSessionId) {
        const questionText = (input as any).args?.questions?.[0]?.question || "Question awaiting answer";
        const activeSessionIds = Array.from(activeResponseContexts.keys());
        await handleMonitorAlert(toolSessionId, "question", questionText, activeSessionIds[0]);
        
        if (isConnected) {
          const ctx = activeResponseContexts.get(toolSessionId);
          if (ctx?.streamCtx.statusIndicator) {
            await ctx.streamCtx.statusIndicator.setWaiting("question", questionText);
          }
        }
      }

      if (!isConnected || !toolSessionId) return;
      
      if (activeResponseContexts.has(toolSessionId)) {
        addToolCall(toolSessionId, input.tool);
      }
    },
  };
};

export default MattermostControlPlugin;
