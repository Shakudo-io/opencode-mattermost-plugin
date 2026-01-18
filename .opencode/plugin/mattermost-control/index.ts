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
import { TodoManager } from "../../../src/todo-manager.js";
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
let todoManager: TodoManager | null = null;
let botUser: User | null = null;
let projectName: string = "";
interface ActiveTool {
  name: string;
  startTime: number;
}

interface TodoItem {
  id: string;
  content: string;
  status: string;
  priority: string;
}

interface TokenInfo {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

interface CostInfo {
  sessionTotal: number;
  currentMessage: number;
  tokens: TokenInfo;
}

interface ResponseContext {
  opencodeSessionId: string;
  mmSession: any;
  streamCtx: any;
  threadRootPostId?: string;
  responseBuffer: string;
  thinkingBuffer: string;
  toolCalls: string[];
  activeTool: ActiveTool | null;
  shellOutput: string;
  shellOutputLastUpdate: number;  // Timestamp of last shell output update
  lastUpdateTime: number;
  textPartCount?: number;
  reasoningPartCount?: number;
  compactionCount: number;
  todos: TodoItem[];
  cost: CostInfo;
  responseStartTime: number;
}

const activeResponseContexts: Map<string, ResponseContext> = new Map();

const TOOL_UPDATE_INTERVAL_MS = 1000;

function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return `${tokens}`;
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  if (cost >= 0.001) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

function formatCostStatus(cost: CostInfo): string {
  const totalTokens = cost.tokens.input + cost.tokens.output + cost.tokens.reasoning;
  if (cost.sessionTotal === 0 && cost.currentMessage === 0 && totalTokens === 0) return "";
  
  const sessionCost = formatCost(cost.sessionTotal + cost.currentMessage);
  const msgCost = cost.currentMessage > 0 ? ` (+${formatCost(cost.currentMessage)})` : "";
  const tokenStr = totalTokens > 0 ? ` | ${formatTokenCount(totalTokens)} tok` : "";
  
  return `💰 ${sessionCost}${msgCost}${tokenStr}`;
}

function formatToolStatus(toolCalls: string[], activeTool: ActiveTool | null, compactionCount: number = 0, cost?: CostInfo, responseStartTime?: number): string {
  const parts: string[] = [];
  
  if (responseStartTime) {
    const elapsed = formatElapsedTime(Date.now() - responseStartTime);
    parts.push(`💻 Processing (${elapsed})`);
  }
  
  if (toolCalls.length > 0) {
    const toolCounts = toolCalls.reduce((acc, tool) => {
      acc[tool] = (acc[tool] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const summary = Object.entries(toolCounts)
      .map(([tool, count]) => count > 1 ? `\`${tool}\` ×${count}` : `\`${tool}\``)
      .join(", ");
    parts.push(`✅ ${summary}`);
  }
  
  if (compactionCount > 0) {
    parts.push(compactionCount > 1 ? `📦 Compacted ×${compactionCount}` : `📦 Compacted`);
  }
  
  if (cost && (cost.sessionTotal > 0 || cost.currentMessage > 0 || cost.tokens.input > 0)) {
    parts.push(formatCostStatus(cost));
  }
  
  if (activeTool) {
    const elapsed = formatElapsedTime(Date.now() - activeTool.startTime);
    parts.push(`🔧 \`${activeTool.name}\` (${elapsed})...`);
  }
  
  return parts.join(" | ");
}

const activeToolTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
const activeResponseTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

async function updateResponseStream(sessionId: string): Promise<void> {
  const ctx = activeResponseContexts.get(sessionId);
  if (!ctx || !streamer) return;
  
  const formattedOutput = formatFullResponse(ctx);
  
  try {
    await streamer.updateStream(ctx.streamCtx, formattedOutput);
  } catch (e) {
    log.error("Failed to update stream:", e);
  }
}

function startActiveToolTimer(sessionId: string): void {
  if (activeToolTimers.has(sessionId)) return;
  
  const timer = setInterval(async () => {
    const ctx = activeResponseContexts.get(sessionId);
    if (!ctx?.activeTool) {
      stopActiveToolTimer(sessionId);
      return;
    }
    await updateResponseStream(sessionId);
  }, TOOL_UPDATE_INTERVAL_MS);
  
  activeToolTimers.set(sessionId, timer);
}

function stopActiveToolTimer(sessionId: string): void {
  const timer = activeToolTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    activeToolTimers.delete(sessionId);
  }
}

function startResponseTimer(sessionId: string): void {
  if (activeResponseTimers.has(sessionId)) return;
  
  const timer = setInterval(async () => {
    const ctx = activeResponseContexts.get(sessionId);
    if (!ctx) {
      stopResponseTimer(sessionId);
      return;
    }
    await updateResponseStream(sessionId);
  }, TOOL_UPDATE_INTERVAL_MS);
  
  activeResponseTimers.set(sessionId, timer);
}

function stopResponseTimer(sessionId: string): void {
  const timer = activeResponseTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    activeResponseTimers.delete(sessionId);
  }
}

const MAX_SHELL_OUTPUT_LINES = 15;
const BASH_HEARTBEAT_THRESHOLD_MS = 10_000;

function formatShellOutput(shellOutput: string, lastOutputTime?: number, toolStartTime?: number): string {
  if (!shellOutput) return "";
  
  const lines = shellOutput.trim().split('\n');
  const totalLines = lines.length;
  
  let output: string;
  if (totalLines <= MAX_SHELL_OUTPUT_LINES) {
    output = shellOutput.trim();
  } else {
    const tailLines = lines.slice(-MAX_SHELL_OUTPUT_LINES);
    output = `... (${totalLines - MAX_SHELL_OUTPUT_LINES} lines hidden)\n${tailLines.join('\n')}`;
  }
  
  if (lastOutputTime && toolStartTime) {
    const timeSinceLastOutput = Date.now() - lastOutputTime;
    const totalRunTime = Date.now() - toolStartTime;
    
    if (timeSinceLastOutput >= BASH_HEARTBEAT_THRESHOLD_MS) {
      const lastOutputAgo = formatElapsedTime(timeSinceLastOutput);
      const runningFor = formatElapsedTime(totalRunTime);
      output += `\n\n⏳ Still running (${runningFor} total, last output ${lastOutputAgo} ago)`;
    }
  }
  
  return output;
}

const TODO_STATUS_ICONS: Record<string, string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⏳",
  cancelled: "❌",
};

function formatTodoStatus(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return "";
  
  const completed = todos.filter(t => t.status === "completed").length;
  const inProgress = todos.filter(t => t.status === "in_progress").length;
  const pending = todos.filter(t => t.status === "pending").length;
  const total = todos.length;
  
  const sortedTodos = [...todos].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
      cancelled: 3,
    };
    return (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
  });
  
  let output = `📋 **Tasks** (${completed}/${total})\n`;
  
  for (const todo of sortedTodos) {
    const icon = TODO_STATUS_ICONS[todo.status] || "❓";
    if (todo.status === "completed") {
      output += `${icon} ~~${todo.content}~~\n`;
    } else if (todo.status === "cancelled") {
      output += `${icon} ~~${todo.content}~~\n`;
    } else {
      output += `${icon} ${todo.content}\n`;
    }
  }
  
  return output;
}

function formatFullResponse(ctx: ResponseContext): string {
  const toolStatus = formatToolStatus(ctx.toolCalls, ctx.activeTool, ctx.compactionCount, ctx.cost, ctx.responseStartTime);
  const todoStatus = formatTodoStatus(ctx.todos);
  const thinkingPreview = ctx.thinkingBuffer.length > 500 
    ? ctx.thinkingBuffer.slice(-500) + "..." 
    : ctx.thinkingBuffer;
  
  let output = "";
  
  if (toolStatus) {
    output += toolStatus + "\n\n";
  }
  
  if (todoStatus) {
    output += todoStatus + "\n";
  }
  
  if (ctx.shellOutput && ctx.activeTool?.name === "bash") {
    const formattedShell = formatShellOutput(
      ctx.shellOutput, 
      ctx.shellOutputLastUpdate,
      ctx.activeTool.startTime
    );
    output += "```\n" + formattedShell + "\n```\n\n";
  }
  
  output += ctx.responseBuffer;
  
  if (ctx.thinkingBuffer) {
    output += `\n\n---\n:brain: **Thinking:**\n> ${thinkingPreview.split('\n').join('\n> ')}`;
  }
  
  return output;
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
      
      todoManager = new TodoManager(mmClient);

      openCodeSessionRegistry.onNewSession(async (sessionInfo) => {
        if (!threadManager || !sessionManager) return;
        
        const existingMapping = threadMappingStore?.getBySessionId(sessionInfo.id);
        if (existingMapping) {
          log.debug(`[AutoThread] Thread already exists for session ${sessionInfo.shortId}`);
          return;
        }
        
        let mmSessions = sessionManager.listSessions();
        if (mmSessions.length === 0) {
          log.debug(`[AutoThread] No active Mattermost users, skipping thread creation for ${sessionInfo.shortId}`);
          return;
        }
        
        // Filter to only owner if ownerUserId is configured
        if (config.mattermost.ownerUserId) {
          mmSessions = mmSessions.filter(s => s.mattermostUserId === config.mattermost.ownerUserId);
          if (mmSessions.length === 0) {
            log.debug(`[AutoThread] Owner ${config.mattermost.ownerUserId} not in active sessions, skipping thread creation for ${sessionInfo.shortId}`);
            return;
          }
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

      if (threadManager && sessionManager && availableSessions.length > 0) {
        let mmSessions = sessionManager.listSessions();
        if (config.mattermost.ownerUserId) {
          mmSessions = mmSessions.filter(s => s.mattermostUserId === config.mattermost.ownerUserId);
        }
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
      for (const [sessionId, timer] of activeToolTimers) {
        clearInterval(timer);
      }
      activeToolTimers.clear();
      
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

    const ownerInfo = config.mattermost.ownerUserId 
      ? `Owner Filter: ${config.mattermost.ownerUserId}` 
      : "Owner Filter: disabled (responds to all users)";

    return `Status: **Connected**
Bot: @${botUser?.username}
Project: ${projectName}
OpenCode Sessions: ${availableOpenCodeSessions} available
Default Session: ${defaultSession ? `${defaultSession.projectName} (${defaultSession.shortId})` : 'none'}
Active MM Sessions: ${mmSessions.length}
WebSocket: ${wsStatus}
${ownerInfo}

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

        if (config.mattermost.ownerUserId && postData.user_id !== config.mattermost.ownerUserId) {
          log.debug(`Ignoring DM from non-owner user ${postData.user_id} (owner: ${config.mattermost.ownerUserId})`);
          return;
        }

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
      
      if (config.mattermost.ownerUserId && event.data?.user_id !== config.mattermost.ownerUserId) {
        log.debug(`Ignoring reaction from non-owner user ${event.data?.user_id}`);
        return;
      }
      
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
          opencodeClient: client,
        });
        await mmClient.createPost(userSession.dmChannelId, result.message);
        return;
      }
      
      case "main_dm_prompt": {
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
        const promptText = routeResult.promptText.trim();
        
        if (promptText.startsWith(config.sessionSelection.commandPrefix)) {
          const parsed = messageRouter.parseCommand(promptText);
          if (parsed) {
            const result = await commandHandler.execute(parsed, {
              userSession,
              registry: openCodeSessionRegistry,
              mmClient,
              threadMappingStore,
              opencodeClient: client,
              sessionId: routeResult.sessionId,
              threadRootPostId: routeResult.threadRootPostId,
            });
            await mmClient.createPost(userSession.dmChannelId, result.message, routeResult.threadRootPostId);
            return;
          }
        }
        
        const numericSelection = parseInt(promptText, 10);
        if (!isNaN(numericSelection) && commandHandler.isPendingModelSelection(routeResult.sessionId, threadMappingStore)) {
          const result = await commandHandler.handleModelSelection(numericSelection, {
            userSession,
            registry: openCodeSessionRegistry,
            mmClient,
            threadMappingStore,
            opencodeClient: client,
            sessionId: routeResult.sessionId,
            threadRootPostId: routeResult.threadRootPostId,
          });
          if (result) {
            await mmClient.createPost(userSession.dmChannelId, result.message, routeResult.threadRootPostId);
            return;
          }
        }
        
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

      let inboundFileParts: Array<{ type: "file"; mime: string; filename: string; url: string }> = [];
      if (route.fileIds && route.fileIds.length > 0) {
        const { fileParts, textFilePaths } = await fileHandler.processInboundAttachmentsAsFileParts(route.fileIds);
        inboundFileParts = fileParts;
        if (textFilePaths.length > 0) {
          promptText += `\n\n[Attached files: ${textFilePaths.join(", ")}]`;
        }
        if (fileParts.length > 0) {
          log.info(`[FileHandler] Sending ${fileParts.length} file(s) as FilePartInput to OpenCode`);
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

      let sessionTotalCost = 0;
      try {
        const messagesResult = await client.session.messages({ path: { id: targetSessionId } });
        const messages = messagesResult.data || [];
        for (const message of messages) {
          if (message.info.role === "assistant") {
            sessionTotalCost += (message.info as any).cost || 0;
          }
        }
        log.debug(`[CostTracker] Session ${shortId} prior cost: $${sessionTotalCost.toFixed(4)}`);
      } catch (e) {
        log.debug(`[CostTracker] Could not fetch session messages: ${e}`);
      }

      const responseContext: ResponseContext = {
        opencodeSessionId: targetSessionId,
        mmSession: userSession,
        streamCtx,
        threadRootPostId,
        responseBuffer: "",
        thinkingBuffer: "",
        toolCalls: [],
        activeTool: null,
        shellOutput: "",
        shellOutputLastUpdate: 0,
        lastUpdateTime: Date.now(),
        compactionCount: 0,
        todos: [],
        cost: {
          sessionTotal: sessionTotalCost,
          currentMessage: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        responseStartTime: Date.now(),
      };
      
      activeResponseContexts.set(targetSessionId, responseContext);
      startResponseTimer(targetSessionId);
      
      if (todoManager && threadRootPostId) {
        todoManager.setThreadRoot(targetSessionId, threadRootPostId, userSession.dmChannelId);
      }

      // Build reply context for agents with other Mattermost integrations
      const replyContext = threadRootPostId 
        ? `[Reply-To: thread=${threadRootPostId} post=${post.id} channel=${userSession.dmChannelId}]`
        : `[Reply-To: post=${post.id} channel=${userSession.dmChannelId}]`;
      
      const promptMessage = `[Mattermost DM from @${userSession.mattermostUsername}]\n${replyContext}\n${promptText}`;
      
      log.debug(`Injecting prompt into session ${targetSessionId}: "${promptMessage.slice(0, 150)}..."`);
      
      await statusIndicator.setProcessing();
      
      const mapping = threadMappingStore?.getBySessionId(targetSessionId);
      const selectedModel = mapping?.model;
      
      if (selectedModel) {
        log.debug(`[ModelSelection] Using model ${selectedModel.providerID}/${selectedModel.modelID} for session ${shortId}`);
      }
      
      const promptParts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; filename: string; url: string }> = [
        { type: "text", text: promptMessage },
        ...inboundFileParts,
      ];

      await client.session.promptAsync({
        path: { id: targetSessionId },
        body: {
          parts: promptParts,
          ...(selectedModel && {
            model: {
              providerID: selectedModel.providerID,
              modelID: selectedModel.modelID,
            },
          }),
        },
      });

      log.info(`Prompt injected into session ${targetSessionId} from @${userSession.mattermostUsername}`);

    } catch (error) {
      log.error("Error processing message:", error);
      
      stopResponseTimer(route.sessionId);
      stopActiveToolTimer(route.sessionId);
      
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

  const mattermostSendFileTool = tool({
    description: "Upload a file to the current Mattermost conversation thread. Use this when the user asks you to send them a file you've created or modified.",
    args: {
      filePath: tool.schema.string().describe("Absolute path to the file to send"),
      message: tool.schema.string().optional().describe("Optional message to accompany the file"),
    },
    async execute(args, ctx) {
      if (!isConnected || !fileHandler || !threadMappingStore || !mmClient) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      const mapping = threadMappingStore.getBySessionId(ctx.sessionID);
      if (!mapping) {
        return `No Mattermost thread associated with session ${ctx.sessionID.substring(0, 8)}. This tool can only be used when responding to a Mattermost conversation.`;
      }

      if (mapping.status === "ended" || mapping.status === "disconnected") {
        return `The Mattermost thread for session ${ctx.sessionID.substring(0, 8)} is no longer active (status: ${mapping.status}).`;
      }

      const result = await fileHandler.sendFileToThread(
        mapping.dmChannelId,
        mapping.threadRootPostId,
        args.filePath,
        args.message
      );

      if (result.success) {
        return `File sent to Mattermost: ${result.fileName}`;
      } else {
        return `Failed to send file: ${result.error}`;
      }
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
      mattermost_send_file: mattermostSendFileTool,
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

      if (eventType === "session.compacted" && eventSessionId) {
        log.info(`[Compaction] Session ${eventSessionId.substring(0, 8)} compacted`);
        const ctx = activeResponseContexts.get(eventSessionId);
        if (ctx) {
          ctx.compactionCount += 1;
          await updateResponseStream(eventSessionId);
        }
      }

      if (eventType === "message.updated") {
        const msgInfo = (event as any).properties?.info;
        if (msgInfo?.role === "assistant" && msgInfo?.sessionID) {
          const ctx = activeResponseContexts.get(msgInfo.sessionID);
          if (ctx) {
            ctx.cost.currentMessage = msgInfo.cost || 0;
            if (msgInfo.tokens) {
              ctx.cost.tokens = {
                input: msgInfo.tokens.input || 0,
                output: msgInfo.tokens.output || 0,
                reasoning: msgInfo.tokens.reasoning || 0,
                cache: {
                  read: msgInfo.tokens.cache?.read || 0,
                  write: msgInfo.tokens.cache?.write || 0,
                },
              };
            }
            await updateResponseStream(msgInfo.sessionID);
          }
        }
      }

      if (!isConnected) return;

      if (event.type === "message.part.updated" && streamer) {
        const part = (event as any).properties?.part;
        const delta = (event as any).properties?.delta;
        const sessionId = part?.sessionID || (event as any).properties?.sessionID;
        
        if (!sessionId) return;
        
        const ctx = activeResponseContexts.get(sessionId);
        if (!ctx) return;
        
        let shouldUpdate = false;
        
        if (part?.type === "text" && delta) {
          ctx.responseBuffer += delta;
          ctx.textPartCount = (ctx.textPartCount || 0) + 1;
          shouldUpdate = true;
        } else if (part?.type === "reasoning" && delta) {
          ctx.thinkingBuffer += delta;
          ctx.reasoningPartCount = (ctx.reasoningPartCount || 0) + 1;
          shouldUpdate = true;
        } else if (part?.type === "tool" && part?.tool === "bash" && part?.state?.status === "running") {
          const shellOutput = part.state.metadata?.output;
          if (shellOutput && shellOutput !== ctx.shellOutput) {
            ctx.shellOutput = shellOutput;
            ctx.shellOutputLastUpdate = Date.now();
            shouldUpdate = true;
          }
        }
        
        if (shouldUpdate) {
          ctx.lastUpdateTime = Date.now();
          
          const formattedOutput = formatFullResponse(ctx);
          
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
          log.info(`[MessageParts] Session ${sessionId.substring(0, 8)} completed: textParts=${ctx.textPartCount || 0}, reasoningParts=${ctx.reasoningPartCount || 0}, responseLen=${ctx.responseBuffer.length}, thinkingLen=${ctx.thinkingBuffer.length}, tools=${ctx.toolCalls.length}, compactions=${ctx.compactionCount}, todos=${ctx.todos.length}, cost=$${(ctx.cost.sessionTotal + ctx.cost.currentMessage).toFixed(4)}`);
          try {
            stopActiveToolTimer(sessionId);
            stopResponseTimer(sessionId);
            
            ctx.streamCtx.buffer = formatFullResponse(ctx);
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

      if (event.type === "todo.updated") {
        const sessionId = (event as any).properties?.sessionID;
        const todos = (event as any).properties?.todos;
        if (!sessionId || !todos) return;
        
        const completed = todos.filter((t: any) => t.status === "completed").length;
        log.info(`[TodoEvent] Session ${sessionId.substring(0, 8)}: ${completed}/${todos.length} complete`);
        
        const ctx = activeResponseContexts.get(sessionId);
        if (ctx) {
          ctx.todos = todos;
          await updateResponseStream(sessionId);
        }
      }
    },

    "tool.execute.before": async (input) => {
      if (!isConnected) return;
      
      const toolSessionId = (input as any).sessionID || (input as any).session?.id;
      if (!toolSessionId) return;
      
      const ctx = activeResponseContexts.get(toolSessionId);
      if (!ctx) return;
      
      ctx.activeTool = {
        name: input.tool,
        startTime: Date.now(),
      };
      
      startActiveToolTimer(toolSessionId);
      await updateResponseStream(toolSessionId);
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
      
      const ctx = activeResponseContexts.get(toolSessionId);
      if (ctx) {
        if (ctx.activeTool) {
          ctx.toolCalls.push(ctx.activeTool.name);
          if (ctx.activeTool.name === "bash") {
            ctx.shellOutput = "";
            ctx.shellOutputLastUpdate = 0;
          }
          ctx.activeTool = null;
          stopActiveToolTimer(toolSessionId);
        }
        await updateResponseStream(toolSessionId);
      }
    },
  };
};

export default MattermostControlPlugin;
