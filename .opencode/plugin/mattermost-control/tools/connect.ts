import { PluginState } from "../state.js";
import { startQuestionCleanupTimer, stopQuestionCleanupTimer } from "../timers.js";
import { MattermostClient } from "../../../../src/clients/mattermost-client.js";
import { MattermostWebSocketClient } from "../../../../src/clients/websocket-client.js";
import { SessionManager } from "../../../../src/session-manager.js";
import { ResponseStreamer } from "../../../../src/response-streamer.js";
import { NotificationService } from "../../../../src/notification-service.js";
import { FileHandler } from "../../../../src/file-handler.js";
import { ReactionHandler } from "../../../../src/reaction-handler.js";
import { OpenCodeSessionRegistry, type OpenCodeSessionInfo } from "../../../../src/opencode-session-registry.js";
import { MessageRouter } from "../../../../src/message-router.js";
import { CommandHandler } from "../../../../src/command-handler.js";
import { ThreadManager } from "../../../../src/thread-manager.js";
import { TodoManager } from "../../../../src/todo-manager.js";
import { QuestionHandler } from "../../../../src/question-handler.js";
import { GuestApprovalHandler } from "../../../../src/guest-approval-handler.js";
import { SessionOwnershipHandler } from "../../../../src/session-ownership-handler.js";
import { FileCompletionHandler } from "../../../../src/file-completion-handler.js";
import { isBotMentioned } from "../../../../src/context-builder.js";
import { loadConfig, type PluginConfig } from "../../../../src/config.js";
import { log } from "../../../../src/logger.js";
import type { WebSocketEvent } from "../../../../src/models/index.js";

export interface ConnectionContext {
  client: any;
  directory: string;
  projectName: string;
  opencodeBaseUrl: string;
  handleUserMessage: (post: any) => Promise<void>;
}

export function createConnectTool(ctx: ConnectionContext) {
  return {
    description: "Connect to Mattermost for remote control via DMs",
    args: {},
    async execute() {
      return await handleConnect(ctx);
    },
  };
}

export function createDisconnectTool() {
  return {
    description: "Disconnect from Mattermost remote control",
    args: {},
    async execute() {
      return await handleDisconnect();
    },
  };
}

export function createStatusTool(projectName: string) {
  return {
    description: "Show Mattermost connection status",
    args: {},
    async execute() {
      return handleStatus(projectName);
    },
  };
}

async function handleConnect(ctx: ConnectionContext): Promise<string> {
  if (PluginState.isConnected) {
    return `Already connected to Mattermost as @${PluginState.botUser?.username}. Use /mattermost status for details.`;
  }

  const config = loadConfig();

  if (!config.mattermost.token) {
    return "MATTERMOST_TOKEN environment variable is required. Set it before connecting.";
  }

  if (config.mattermost.baseUrl.includes("your-mattermost-instance.example.com")) {
    return "MATTERMOST_URL environment variable is required. Set it before connecting.";
  }

  try {
    log.info("Creating Mattermost clients...");
    const mmClient = new MattermostClient(config.mattermost);
    const wsClient = new MattermostWebSocketClient(config.mattermost);
    
    await wsClient.connect();
    const botUser = await mmClient.getCurrentUser();

    const sessionManager = new SessionManager(mmClient, config.sessions);
    await sessionManager.setBotUserId(botUser.id);

    const streamer = new ResponseStreamer(mmClient, config.streaming);
    const notifications = new NotificationService(mmClient, config.notifications);
    const fileHandler = new FileHandler(mmClient, config.files);

    const reactionHandler = new ReactionHandler(sessionManager, notifications, {
      onApprove: async (session) => {
        await notifications.notifyStatus(session, { type: "waiting", details: "Permission approved" });
      },
      onDeny: async (session) => {
        await notifications.notifyStatus(session, { type: "waiting", details: "Permission denied" });
      },
      onCancel: async (session) => {
        session.isProcessing = false;
        await notifications.notifyStatus(session, { type: "idle", details: "Operation cancelled" });
      },
      onRetry: async (session) => {
        if (session.lastPrompt) {
          await ctx.handleUserMessage(session.lastPrompt);
        }
      },
      onClear: async (session) => {
        fileHandler.cleanupSessionFiles(session);
      },
    });
    reactionHandler.setBotUserId(botUser.id);

    const openCodeSessionRegistry = new OpenCodeSessionRegistry(config.sessionSelection.refreshIntervalMs);
    openCodeSessionRegistry.initialize(ctx.client.session);
    await openCodeSessionRegistry.refresh();
    openCodeSessionRegistry.startAutoRefresh();

    const messageRouter = new MessageRouter(config.sessionSelection.commandPrefix);
    const commandHandler = new CommandHandler(config.sessionSelection.commandPrefix);
    const threadMappingStore = PluginState.threadMappingStore;

    if (threadMappingStore) {
      messageRouter.setThreadLookup((threadRootPostId) => 
        threadMappingStore.getByThreadRootPostId(threadRootPostId)
      );
    }

    let threadManager: ThreadManager | null = null;
    if (threadMappingStore) {
      threadManager = new ThreadManager(mmClient, threadMappingStore);
    }
    
    const todoManager = new TodoManager(mmClient);
    const questionHandler = new QuestionHandler(mmClient);
    const guestApprovalHandler = new GuestApprovalHandler(mmClient);
    const sessionOwnershipHandler = new SessionOwnershipHandler(mmClient);
    sessionOwnershipHandler.setBotUserId(botUser.id);
    
    const fileCompletionHandler = new FileCompletionHandler(ctx.opencodeBaseUrl, ctx.directory);
    PluginState.setFileCompletionHandler(fileCompletionHandler);

    setupSessionCallbacks(openCodeSessionRegistry, threadMappingStore, threadManager, sessionManager, config);
    
    const availableSessions = openCodeSessionRegistry.listAvailable();
    cleanOrphanedMappings(threadMappingStore, availableSessions);
    await createThreadsForExistingSessions(threadManager, threadMappingStore, sessionManager, availableSessions, config);

    setupWebSocketListeners(wsClient, botUser.id, config, ctx.handleUserMessage, reactionHandler);
    startQuestionCleanupTimer();

    PluginState.setConnected(
      mmClient,
      wsClient,
      sessionManager,
      streamer,
      notifications,
      fileHandler,
      reactionHandler,
      openCodeSessionRegistry,
      messageRouter,
      commandHandler,
      threadManager,
      todoManager,
      questionHandler,
      guestApprovalHandler,
      sessionOwnershipHandler,
      botUser
    );

    log.info(`Connected to Mattermost as @${botUser.username}`);
    return `Connected to Mattermost as @${botUser.username}\nListening for DMs\nProject: ${ctx.projectName}\n\nDM @${botUser.username} in Mattermost to send prompts remotely.`;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error("Connection failed:", errorMsg);
    return `Failed to connect: ${errorMsg}`;
  }
}

async function handleDisconnect(): Promise<string> {
  if (!PluginState.isConnected) {
    return "Not connected to Mattermost.";
  }

  try {
    stopQuestionCleanupTimer();
    PluginState.disconnect();
    log.info("Disconnected from Mattermost");
    return "Disconnected from Mattermost";
  } catch (error) {
    return `Error disconnecting: ${error}`;
  }
}

function handleStatus(projectName: string): string {
  if (!PluginState.isConnected) {
    return "Status: **Disconnected**\n\nUse `/mattermost connect` to enable remote control.";
  }

  const config = loadConfig();
  const mmSessions = PluginState.sessionManager?.listSessions() || [];
  const wsStatus = PluginState.wsClient?.isConnected() ? "Connected" : "Reconnecting...";
  const availableOpenCodeSessions = PluginState.openCodeSessionRegistry?.countAvailable() || 0;
  const defaultSession = PluginState.openCodeSessionRegistry?.getDefault();

  const ownerInfo = config.mattermost.ownerUserId 
    ? `Owner Filter: ${config.mattermost.ownerUserId}` 
    : "Owner Filter: disabled (responds to all users)";

  return `Status: **Connected**
Bot: @${PluginState.botUser?.username}
Project: ${projectName}
OpenCode Sessions: ${availableOpenCodeSessions} available
Default Session: ${defaultSession ? `${defaultSession.projectName} (${defaultSession.shortId})` : 'none'}
Active MM Sessions: ${mmSessions.length}
WebSocket: ${wsStatus}
${ownerInfo}

Use \`!sessions\` in DM to see and select OpenCode sessions.`;
}

function setupSessionCallbacks(
  registry: OpenCodeSessionRegistry,
  threadMappingStore: any,
  threadManager: ThreadManager | null,
  sessionManager: SessionManager,
  config: PluginConfig
) {
  registry.onNewSession(async (sessionInfo: OpenCodeSessionInfo) => {
    if (!threadManager || !sessionManager) return;
    
    const existingMapping = threadMappingStore?.getBySessionId(sessionInfo.id);
    if (existingMapping) return;
    
    let mmSessions = sessionManager.listSessions();
    if (mmSessions.length === 0) return;
    
    if (config.mattermost.ownerUserId) {
      mmSessions = mmSessions.filter(s => s.mattermostUserId === config.mattermost.ownerUserId);
      if (mmSessions.length === 0) return;
    }
    
    for (const mmSession of mmSessions) {
      try {
        await threadManager.createThread(
          sessionInfo,
          mmSession.mattermostUserId,
          mmSession.dmChannelId,
          undefined,
          undefined,
          mmSession.mattermostUsername
        );
        log.info(`[AutoThread] Created thread for session ${sessionInfo.shortId}`);
      } catch (e) {
        log.error(`[AutoThread] Failed to create thread:`, e);
      }
    }
  });

  registry.onSessionDeleted(async (sessionId) => {
    if (!threadManager) return;
    try {
      await threadManager.endThread(sessionId);
      log.info(`[AutoThread] Ended thread for session ${sessionId.substring(0, 8)}`);
    } catch (e) {
      log.error(`[AutoThread] Failed to end thread:`, e);
    }
  });
}

function cleanOrphanedMappings(threadMappingStore: any, availableSessions: OpenCodeSessionInfo[]) {
  if (!threadMappingStore) return;
  const validSessionIds = new Set(availableSessions.map(s => s.id));
  const cleanedCount = threadMappingStore.cleanOrphaned(validSessionIds);
  if (cleanedCount > 0) {
    log.info(`[AutoThread] Marked ${cleanedCount} orphaned mappings`);
  }
}

async function createThreadsForExistingSessions(
  threadManager: ThreadManager | null,
  threadMappingStore: any,
  sessionManager: SessionManager,
  availableSessions: OpenCodeSessionInfo[],
  config: PluginConfig
) {
  if (!threadManager || !sessionManager || availableSessions.length === 0) return;
  
  let mmSessions = sessionManager.listSessions();
  if (config.mattermost.ownerUserId) {
    mmSessions = mmSessions.filter(s => s.mattermostUserId === config.mattermost.ownerUserId);
  }
  
  if (mmSessions.length === 0) return;
  
  for (const sessionInfo of availableSessions) {
    const existingMapping = threadMappingStore?.getBySessionId(sessionInfo.id);
    if (existingMapping) continue;
    
    for (const mmSession of mmSessions) {
      try {
        await threadManager.createThread(
          sessionInfo,
          mmSession.mattermostUserId,
          mmSession.dmChannelId,
          undefined,
          undefined,
          mmSession.mattermostUsername
        );
        log.info(`[AutoThread] Created thread for existing session ${sessionInfo.shortId}`);
      } catch (e) {
        log.error(`[AutoThread] Failed to create thread:`, e);
      }
    }
  }
}

function setupWebSocketListeners(
  wsClient: MattermostWebSocketClient,
  botUserId: string,
  config: PluginConfig,
  handleUserMessage: (post: any) => Promise<void>,
  reactionHandler: ReactionHandler
) {
  wsClient.on("hello", () => {
    log.info("Received hello event - connection authenticated");
  });

  wsClient.on("posted", async (event: WebSocketEvent) => {
    if (!PluginState.isConnected) return;
    
    const mmClient = PluginState.mmClient;
    if (!mmClient) return;

    try {
      const postData = typeof event.data.post === "string" ? JSON.parse(event.data.post) : event.data.post;
      if (postData.user_id === botUserId) return;

      const channel = await mmClient.getChannel(postData.channel_id);
      
      if (channel.type === "D") {
        if (config.mattermost.ownerUserId && postData.user_id !== config.mattermost.ownerUserId) {
          log.debug(`Ignoring 1:1 DM from non-owner user ${postData.user_id}`);
          return;
        }
      } else if (channel.type === "G") {
        const botUser = PluginState.botUser;
        if (!botUser) {
          log.error(`[GroupDM] Bot user not available`);
          return;
        }
        
        const threadRootId = postData.root_id || postData.id;
        const isOwner = !config.mattermost.ownerUserId || postData.user_id === config.mattermost.ownerUserId;
        
        const sessionOwnershipHandler = PluginState.sessionOwnershipHandler;
        if (isOwner && sessionOwnershipHandler?.hasPendingConfirmation(channel.id, threadRootId, postData.user_id)) {
          log.info(`[GroupDM] Processing ownership confirmation reply from @${postData.user_id}`);
          const pending = sessionOwnershipHandler.getPendingConfirmation(channel.id, threadRootId);
          const confirmResult = await sessionOwnershipHandler.handleReply(
            channel.id,
            threadRootId,
            postData.message.trim()
          );
          
          if (confirmResult.confirmed && pending?.originalPost) {
            log.info(`[SessionOwnership] User confirmed, creating session directly`);
            const originalPost = pending.originalPost;
            (originalPost as any)._ownershipConfirmed = true;
            await handleUserMessage(originalPost);
          }
          return;
        }
        
        // Check if owner is replying to a pending guest approval (no @mention needed)
        const threadMappingStore = PluginState.threadMappingStore;
        const guestApprovalHandler = PluginState.guestApprovalHandler;
        const mappingForApproval = threadMappingStore?.getByThreadRootPostId(threadRootId);
        
        if (isOwner && mappingForApproval && guestApprovalHandler?.hasPendingApproval(mappingForApproval.sessionId)) {
          const trimmedReply = postData.message.trim().toLowerCase();
          // Check if this looks like an approval response (1, 2, 3, deny, 0, no)
          if (/^[0-3]$/.test(trimmedReply) || trimmedReply === "deny" || trimmedReply === "no") {
            log.info(`[GroupDM] Processing guest approval reply from owner: "${trimmedReply}"`);
            const result = await guestApprovalHandler.handleOwnerReply(
              mappingForApproval.sessionId,
              postData.message.trim(),
              threadMappingStore!,
              mappingForApproval.channelId || mappingForApproval.dmChannelId
            );
            
            if (result.approved && result.post) {
              log.info(`[GuestApproval] Approved, processing original guest message`);
              await handleUserMessage(result.post);
            }
            return;
          }
        }
        
        const mentioned = isBotMentioned(postData.message, botUser.username, botUser.id);
        if (!mentioned) {
          log.debug(`[GroupDM] Skipping message - bot not @mentioned (channel: ${channel.id})`);
          return;
        }
        
        const mapping = threadMappingStore?.getByThreadRootPostId(threadRootId);
        
        if (isOwner) {
          if (!mapping) {
            const sessionOwnershipHandler = PluginState.sessionOwnershipHandler;
            const mmClient = PluginState.mmClient;
            if (!mmClient || !sessionOwnershipHandler) return;
            
            let ownerUsername = "unknown";
            try {
              const ownerUser = await mmClient.getUserById(postData.user_id);
              ownerUsername = ownerUser.username;
            } catch (e) {
              log.warn(`[GroupDM] Could not fetch owner username: ${e}`);
            }
            
            log.info(`[GroupDM] Owner @mentioned bot in unmapped thread, requesting ownership confirmation`);
            await sessionOwnershipHandler.requestOwnershipConfirmation(
              postData,
              ownerUsername,
              threadRootId,
              channel.id
            );
            return;
          }
          log.info(`[GroupDM] Bot @mentioned by owner, processing message (channel: ${channel.id})`);
        } else {
          if (!mapping) {
            log.debug(`[GroupDM] Non-owner @mention but no thread mapping found - ignoring (channel: ${channel.id})`);
            return;
          }
          
          if (guestApprovalHandler?.isUserApproved(postData.user_id, mapping)) {
            log.info(`[GroupDM] Bot @mentioned by approved guest ${postData.user_id}, processing (channel: ${channel.id})`);
          } else {
            log.info(`[GroupDM] Bot @mentioned by non-approved guest ${postData.user_id}, requesting approval (channel: ${channel.id})`);
            
            const mmClient = PluginState.mmClient;
            if (!mmClient || !guestApprovalHandler) return;
            
            let guestUsername = "unknown";
            try {
              const guestUser = await mmClient.getUserById(postData.user_id);
              guestUsername = guestUser.username;
            } catch (e) {
              log.warn(`[GroupDM] Could not fetch guest username: ${e}`);
            }
            
            await guestApprovalHandler.requestApproval(
              postData,
              guestUsername,
              threadRootId,
              mapping.sessionId,
              mapping.channelId || mapping.dmChannelId
            );
            return;
          }
        }
      } else {
        return;
      }

      log.info("Processing DM message...");
      await handleUserMessage(postData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      log.error(`Error handling posted event: ${errorMessage}`);
      if (errorStack) {
        log.error(`Stack trace: ${errorStack}`);
      }
    }
  });

  wsClient.on("reaction_added", async (event: WebSocketEvent) => {
    if (!PluginState.isConnected) return;
    
    if (config.mattermost.ownerUserId && event.data?.user_id !== config.mattermost.ownerUserId) {
      return;
    }
    
    await reactionHandler.handleReaction(event);
  });
}
