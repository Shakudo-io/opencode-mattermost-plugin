import fs from "fs";
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
import { getSchedulerService } from "../../../../src/scheduler/scheduler-service.js";
import { isBotMentioned, stripDelegationMentions } from "../../../../src/context-builder.js";
import { loadConfig, type PluginConfig } from "../../../../src/config.js";
import { log } from "../../../../src/logger.js";
import { TeamStore } from "../../../../src/persistence/team-store.js";
import { createPendingInteractionsPgStore, type PendingInteractionsPgStore } from "../../../../src/persistence/postgres/pending-interactions-pg.js";
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

// ─── Single-instance lock ────────────────────────────────────────────────────
// Prevents two simultaneous OpenCode processes from both connecting to
// Mattermost and doubling every incoming message event.
const LOCK_FILE = "/tmp/opencode-mattermost.lock";

function tryAcquireLock(): { acquired: boolean; holderPid?: number } {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, "utf8").trim();
      const pid = parseInt(content, 10);
      if (!isNaN(pid) && pid !== process.pid) {
        try {
          process.kill(pid, 0); // throws if process no longer exists
          return { acquired: false, holderPid: pid };
        } catch {
          log.warn(`[Lock] Stale lock (PID ${pid} gone), overwriting`);
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return { acquired: true };
  } catch (e) {
    log.warn(`[Lock] Could not acquire lock: ${e} — proceeding anyway`);
    return { acquired: true };
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* best-effort */ }
}
// ─────────────────────────────────────────────────────────────────────────────

async function handleConnect(ctx: ConnectionContext): Promise<string> {
  if (PluginState.isConnected) {
    return `Already connected to Mattermost as @${PluginState.botUser?.username}. Use /mattermost status for details.`;
  }

  const lockResult = tryAcquireLock();
  if (!lockResult.acquired) {
    const msg = `Another OpenCode process (PID ${lockResult.holderPid}) is already connected to Mattermost. Skipping.`;
    log.warn(`[Lock] ${msg}`);
    return msg;
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
        // Call OpenCode abort API to actually stop the session
        const sessionId = session.targetOpenCodeSessionId;
        if (sessionId) {
          try {
            await ctx.client.session.abort({ path: { id: sessionId } });
            log.info(`[ReactionHandler] Aborted session ${sessionId.substring(0, 8)} via 🛑 reaction`);
          } catch (e) {
            log.error(`[ReactionHandler] Failed to abort session: ${e}`);
          }
        }
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
    questionHandler.setOpenCodeConfig(ctx.opencodeBaseUrl, ctx.directory);
    const guestApprovalHandler = new GuestApprovalHandler(mmClient);
    const sessionOwnershipHandler = new SessionOwnershipHandler(mmClient);
    sessionOwnershipHandler.setBotUserId(botUser.id);
    
    const fileCompletionHandler = new FileCompletionHandler(ctx.opencodeBaseUrl, ctx.directory);
    PluginState.setFileCompletionHandler(fileCompletionHandler);

    const clientManager = threadMappingStore?.getClientManager();
    let pendingPgStore: PendingInteractionsPgStore | null = null;
    if (clientManager) {
      pendingPgStore = createPendingInteractionsPgStore(clientManager);
      questionHandler.setPgStore(pendingPgStore);
      guestApprovalHandler.setPgStore(pendingPgStore);
      sessionOwnershipHandler.setPgStore(pendingPgStore);
      log.info("[PendingPg] Wired Postgres store to handlers");

      const TTL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
      const cleanupTimer = setInterval(async () => {
        try {
          const result = await pendingPgStore!.expireOldPending();
          if (result.questions > 0 || result.approvals > 0 || result.ownerships > 0) {
            log.info(`[TTL Cleanup] Expired: ${result.questions} questions, ${result.approvals} approvals, ${result.ownerships} ownerships`);
          }
        } catch (e) {
          log.warn(`[TTL Cleanup] Failed: ${e}`);
        }
      }, TTL_CLEANUP_INTERVAL_MS);
      PluginState.setPendingCleanupTimer(cleanupTimer);
    }

    setupSessionCallbacks(openCodeSessionRegistry, threadMappingStore, threadManager, sessionManager, config);
    
    const availableSessions = openCodeSessionRegistry.listAvailable();
    // NOTE: cleanOrphanedMappings disabled - it incorrectly marks threads as orphaned
    // when OpenCode restarts (session IDs change). Threads should remain active
    // and be matched by other means (user ID, project, etc.) rather than exact session ID.
    // cleanOrphanedMappings(threadMappingStore, availableSessions);
    await createThreadsForExistingSessions(threadManager, threadMappingStore, sessionManager, availableSessions, config);

    setupWebSocketListeners(wsClient, botUser.id, config, ctx.handleUserMessage, reactionHandler);
    startQuestionCleanupTimer();

    const scheduler = getSchedulerService();
    scheduler.setPromptExecutor(async (sessionId: string, prompt: string) => {
      const result = await ctx.client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: prompt }] },
      });
      return result.data?.text || "";
    });
    scheduler.setSessionChecker(async (sessionId: string) => {
      const session = openCodeSessionRegistry.get(sessionId);
      return session !== null && session.isAvailable;
    });
    await scheduler.start();

    const defaultSession = openCodeSessionRegistry.getDefault();
    if (defaultSession) {
      const rebound = await scheduler.rebindAllToSession(defaultSession.id);
      if (rebound > 0) {
        log.info(`[Connect] Re-bound ${rebound} schedules to current session ${defaultSession.id.substring(0, 12)}`);
      }
    }

    PluginState.setSchedulerService(scheduler);
    log.info(`[SchedulerService] Initialized with ${scheduler.getStats().enabled} active schedules`);

    const teamStore = new TeamStore();
    teamStore.load();
    if (!teamStore.hasTeam() && config.mattermost.ownerUserId) {
      teamStore.createTeam(config.mattermost.ownerUserId);
    }
    PluginState.setTeamStore(teamStore);

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

    // Release lock when the process exits (crash-safety)
    process.once("exit", releaseLock);

    log.info(`Connected to Mattermost as @${botUser.username}`);
    return `Connected to Mattermost as @${botUser.username}\nListening for DMs\nProject: ${ctx.projectName}\n\nDM @${botUser.username} in Mattermost to send prompts remotely.`;
  } catch (error) {
    releaseLock(); // Release on failure so the next attempt can succeed
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
    const scheduler = PluginState.schedulerService;
    if (scheduler) {
      await scheduler.stop();
      log.info("[SchedulerService] Stopped");
    }
    PluginState.disconnect();
    releaseLock();
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

    // Skip if createNewSessionFromDm is actively creating this session — it will call createThread itself
    if (PluginState.pendingSessionIds.has(sessionInfo.id)) {
      log.info(`[AutoThread] Skipping session ${sessionInfo.shortId} — already being handled by createNewSessionFromDm`);
      return;
    }

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

  const processedPostIds = new Set<string>();
  const POST_DEDUP_TTL_MS = 5000;
  
  wsClient.on("posted", async (event: WebSocketEvent) => {
    if (!PluginState.isConnected) return;
    
    const mmClient = PluginState.mmClient;
    if (!mmClient) return;

    try {
      const postData = typeof event.data.post === "string" ? JSON.parse(event.data.post) : event.data.post;
      if (postData.user_id === botUserId) return;

      if (processedPostIds.has(postData.id)) {
        log.debug(`[Dedup] Ignoring duplicate event for post ${postData.id}`);
        return;
      }
      processedPostIds.add(postData.id);
      setTimeout(() => processedPostIds.delete(postData.id), POST_DEDUP_TTL_MS);

      const channel = await mmClient.getChannel(postData.channel_id);
      
      // Check if channel type is allowed
      const allowedTypes = config.sessions.allowedChannelTypes;
      if (!allowedTypes.includes(channel.type as "D" | "G" | "O" | "P")) {
        log.debug(`Ignoring message from disallowed channel type '${channel.type}' (allowed: ${allowedTypes.join(",")})`);
        return;
      }
      
      if (channel.type === "D") {
        if (config.mattermost.ownerUserId && postData.user_id !== config.mattermost.ownerUserId) {
          log.debug(`Ignoring 1:1 DM from non-owner user ${postData.user_id}`);
          return;
        }
      } else if (channel.type === "G" || channel.type === "O" || channel.type === "P") {
        const botUser = PluginState.botUser;
        if (!botUser) {
          log.error(`[Channel] Bot user not available`);
          return;
        }
        
        const threadRootId = postData.root_id || postData.id;
        const isOwner = !config.mattermost.ownerUserId || postData.user_id === config.mattermost.ownerUserId;
        const isTeamMember = PluginState.teamStore?.isMember(postData.user_id) || false;
        const hasTeamAccess = isOwner || isTeamMember;
        
        const sessionOwnershipHandler = PluginState.sessionOwnershipHandler;
        if (hasTeamAccess && sessionOwnershipHandler?.hasPendingConfirmation(channel.id, threadRootId, postData.user_id)) {
          log.info(`[Channel] Processing ownership confirmation reply from @${postData.user_id}`);
          const pending = sessionOwnershipHandler.getPendingConfirmation(channel.id, threadRootId);
          const confirmResult = await sessionOwnershipHandler.handleReply(
            channel.id,
            threadRootId,
            postData.message.trim()
          );
          
          if (confirmResult.confirmed && pending?.originalPost) {
            log.info(`[SessionOwnership] User confirmed with approval policy: ${confirmResult.approvalPolicy || 'none'}`);
            const originalPost = pending.originalPost;
            (originalPost as any)._ownershipConfirmed = true;
            (originalPost as any)._approvalPolicy = confirmResult.approvalPolicy || "none";
            await handleUserMessage(originalPost);
          }
          return;
        }
        
        // Check if owner is replying to a pending guest approval (no @mention needed)
        const threadMappingStore = PluginState.threadMappingStore;
        const guestApprovalHandler = PluginState.guestApprovalHandler;
        const mappingForApproval = threadMappingStore?.getByThreadRootPostId(threadRootId);
        
        if (hasTeamAccess && mappingForApproval && guestApprovalHandler?.hasPendingApproval(mappingForApproval.sessionId)) {
          const trimmedReply = postData.message.trim().toLowerCase();
          if (/^[0-3]$/.test(trimmedReply) || trimmedReply === "deny" || trimmedReply === "no") {
            log.info(`[Channel] Processing guest approval reply from owner: "${trimmedReply}"`);
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
          log.debug(`[Channel] Skipping message - bot not @mentioned (channel: ${channel.id})`);
          return;
        }
        
        const mapping = threadMappingStore?.getByThreadRootPostId(threadRootId);
        
        if (!mapping) {
          // No existing session in this thread
          const sessionOwnershipHandler = PluginState.sessionOwnershipHandler;
          const mmClient = PluginState.mmClient;
          if (!mmClient || !sessionOwnershipHandler) return;
          
          const ownerUserId = config.mattermost.ownerUserId;
          
          // Parse !@mentions (delegation syntax) for all paths
          const otherMentions = botUser ? sessionOwnershipHandler.detectMentionedUsers(
            postData.message,
            botUser.username,
            botUser.id,
            postData.user_id
          ) : [];
          
          if (isOwner) {
            // Owner @mentioned bot. Did they also use !@someone (delegation syntax)?
            // If so, this is meant for that other person's Kaji — stay silent.
            if (otherMentions.length > 0) {
              log.debug(`[Channel] Owner @mentioned bot with !@delegation (${otherMentions.join(', ')}) - staying silent for other owner's Kaji to handle`);
              return;
            }
            
            // Owner mentioned only @kaji - standard ownership confirmation flow
            let userUsername = "unknown";
            try {
              const user = await mmClient.getUserById(postData.user_id);
              userUsername = user.username;
            } catch (e) {
              log.warn(`[Channel] Could not fetch user username: ${e}`);
            }
            
            log.info(`[Channel] Owner @mentioned bot in unmapped thread, requesting ownership confirmation`);
            await sessionOwnershipHandler.requestOwnershipConfirmation(
              postData,
              userUsername,
              threadRootId,
              channel.id
            );
            return;
          }
          
          // Non-owner mentioned bot - only allow delegated session creation
          // They MUST be a team member AND use !@owner delegation syntax
          // e.g., "@kaji !@christine fix this"
          // Just mentioning @kaji alone does nothing for non-owners
          if (!isTeamMember) {
            log.debug(`[Channel] Non-team-member @mentioned bot in unmapped thread - ignoring (channel: ${channel.id})`);
            return;
          }
          
          if (ownerUserId && botUser) {
            // Check if the owner was !@mentioned (delegation syntax)
            let ownerMentioned = false;
            let ownerUsername = "unknown";
            if (otherMentions.length > 0) {
              try {
                const ownerUser = await mmClient.getUserById(ownerUserId);
                ownerUsername = ownerUser.username;
                ownerMentioned = otherMentions.some(
                  m => m.toLowerCase() === ownerUsername.toLowerCase()
                );
              } catch (e) {
                log.warn(`[Delegation] Could not fetch owner user info: ${e}`);
              }
            }
            
            if (!ownerMentioned) {
              // Team member mentioned @kaji without !@owner delegation - silently ignore
              log.debug(`[Channel] Team member @mentioned bot without !@owner delegation - ignoring (channel: ${channel.id})`);
              return;
            }
            
            // Owner was mentioned - verify the owner is actually in this channel
            try {
              const members = await mmClient.getChannelMembers(channel.id);
              const ownerInChannel = members.some(m => m.user_id === ownerUserId);
              if (!ownerInChannel) {
                log.info(`[Delegation] Owner @${ownerUsername} is not a member of channel ${channel.id} - ignoring`);
                return;
              }
            } catch (e) {
              log.warn(`[Delegation] Could not check channel membership: ${e}`);
            }
            
            let initiatorUsername = "unknown";
            try {
              const initiatorUser = await mmClient.getUserById(postData.user_id);
              initiatorUsername = initiatorUser.username;
            } catch (e) {
              log.warn(`[Delegation] Could not fetch initiator username: ${e}`);
            }
            
            log.info(`[Delegation] Team member @${initiatorUsername} used !@${ownerUsername} delegation syntax - creating delegated session`);
            
            // Set delegation flags on the post for handleUserMessage to process
            const delegatedPost = { ...postData } as any;
            // Strip !@mentions from the message so they don't appear in the prompt
            delegatedPost.message = stripDelegationMentions(postData.message);
            delegatedPost._ownershipConfirmed = true;
            delegatedPost._approvalPolicy = "none";
            delegatedPost._delegatedOwnerUserId = ownerUserId;
            delegatedPost._delegatedOwnerUsername = ownerUsername;
            delegatedPost._delegatedInitiatorUserId = postData.user_id;
            delegatedPost._delegatedInitiatorUsername = initiatorUsername;
            
            await handleUserMessage(delegatedPost);
            return;
          }
          
          // No owner configured or bot user not available - ignore
          log.debug(`[Channel] Non-owner @mention in unmapped thread - ignoring (channel: ${channel.id})`);
          return;
        }
        
        // Existing session - check access permissions
        if (hasTeamAccess) {
          // Owner and team members can use existing sessions without approval
          log.info(`[Channel] Bot @mentioned by ${isOwner ? 'owner' : 'team member'}, processing message (channel: ${channel.id})`);
        } else {
          if (!mapping) {
            log.debug(`[Channel] Non-owner @mention but no thread mapping found - ignoring (channel: ${channel.id})`);
            return;
          }
          
          if (guestApprovalHandler?.isUserApproved(postData.user_id, mapping, PluginState.teamStore)) {
            log.info(`[Channel] Bot @mentioned by approved guest ${postData.user_id}, processing (channel: ${channel.id})`);
            if (mapping.approveNextMessage && threadMappingStore) {
              guestApprovalHandler.consumeNextMessageApproval(mapping, threadMappingStore);
            }
          } else {
            log.info(`[Channel] Bot @mentioned by non-approved guest ${postData.user_id}, requesting approval (channel: ${channel.id})`);
            
            const mmClient = PluginState.mmClient;
            if (!mmClient || !guestApprovalHandler) return;
            
            let guestUsername = "unknown";
            try {
              const guestUser = await mmClient.getUserById(postData.user_id);
              guestUsername = guestUser.username;
            } catch (e) {
              log.warn(`[Channel] Could not fetch guest username: ${e}`);
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
