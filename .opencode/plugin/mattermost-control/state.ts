import type { ResponseContext } from "./types.js";
import type { MattermostClient } from "../../../src/clients/mattermost-client.js";
import type { MattermostWebSocketClient } from "../../../src/clients/websocket-client.js";
import type { SessionManager } from "../../../src/session-manager.js";
import type { ResponseStreamer } from "../../../src/response-streamer.js";
import type { NotificationService } from "../../../src/notification-service.js";
import type { FileHandler } from "../../../src/file-handler.js";
import type { ReactionHandler } from "../../../src/reaction-handler.js";
import type { OpenCodeSessionRegistry } from "../../../src/opencode-session-registry.js";
import type { MessageRouter } from "../../../src/message-router.js";
import type { CommandHandler } from "../../../src/command-handler.js";
import type { ThreadMappingStore } from "../../../src/persistence/thread-mapping-store.js";
import type { ThreadManager } from "../../../src/thread-manager.js";
import type { TodoManager } from "../../../src/todo-manager.js";
import type { QuestionHandler } from "../../../src/question-handler.js";
import type { GuestApprovalHandler } from "../../../src/guest-approval-handler.js";
import type { SessionOwnershipHandler } from "../../../src/session-ownership-handler.js";
import type { FileCompletionHandler } from "../../../src/file-completion-handler.js";
import type { SchedulerService } from "../../../src/scheduler/scheduler-service.js";
import type { TeamStore } from "../../../src/persistence/team-store.js";
import type { User } from "../../../src/models/index.js";

class PluginStateManager {
  private _isConnected = false;
  private _mmClient: MattermostClient | null = null;
  private _wsClient: MattermostWebSocketClient | null = null;
  private _sessionManager: SessionManager | null = null;
  private _streamer: ResponseStreamer | null = null;
  private _notifications: NotificationService | null = null;
  private _fileHandler: FileHandler | null = null;
  private _reactionHandler: ReactionHandler | null = null;
  private _openCodeSessionRegistry: OpenCodeSessionRegistry | null = null;
  private _messageRouter: MessageRouter | null = null;
  private _commandHandler: CommandHandler | null = null;
  private _threadMappingStore: ThreadMappingStore | null = null;
  private _threadManager: ThreadManager | null = null;
  private _todoManager: TodoManager | null = null;
  private _questionHandler: QuestionHandler | null = null;
  private _guestApprovalHandler: GuestApprovalHandler | null = null;
  private _sessionOwnershipHandler: SessionOwnershipHandler | null = null;
  private _fileCompletionHandler: FileCompletionHandler | null = null;
  private _schedulerService: SchedulerService | null = null;
  private _teamStore: TeamStore | null = null;
  private _botUser: User | null = null;
  private _projectName: string = "";

  readonly activeResponseContexts: Map<string, ResponseContext> = new Map();
  readonly activeToolTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  readonly activeResponseTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private _questionCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _pendingCleanupTimer: ReturnType<typeof setInterval> | null = null;

  get isConnected(): boolean { return this._isConnected; }
  get projectName(): string { return this._projectName; }
  get botUser(): User | null { return this._botUser; }
  
  get mmClient(): MattermostClient | null { return this._mmClient; }
  get wsClient(): MattermostWebSocketClient | null { return this._wsClient; }
  get sessionManager(): SessionManager | null { return this._sessionManager; }
  get streamer(): ResponseStreamer | null { return this._streamer; }
  get notifications(): NotificationService | null { return this._notifications; }
  get fileHandler(): FileHandler | null { return this._fileHandler; }
  get reactionHandler(): ReactionHandler | null { return this._reactionHandler; }
  get openCodeSessionRegistry(): OpenCodeSessionRegistry | null { return this._openCodeSessionRegistry; }
  get messageRouter(): MessageRouter | null { return this._messageRouter; }
  get commandHandler(): CommandHandler | null { return this._commandHandler; }
  get threadMappingStore(): ThreadMappingStore | null { return this._threadMappingStore; }
  get threadManager(): ThreadManager | null { return this._threadManager; }
  get todoManager(): TodoManager | null { return this._todoManager; }
  get questionHandler(): QuestionHandler | null { return this._questionHandler; }
  get guestApprovalHandler(): GuestApprovalHandler | null { return this._guestApprovalHandler; }
  get sessionOwnershipHandler(): SessionOwnershipHandler | null { return this._sessionOwnershipHandler; }
  get fileCompletionHandler(): FileCompletionHandler | null { return this._fileCompletionHandler; }
  get questionCleanupTimer(): ReturnType<typeof setInterval> | null { return this._questionCleanupTimer; }
  get pendingCleanupTimer(): ReturnType<typeof setInterval> | null { return this._pendingCleanupTimer; }
  get schedulerService(): SchedulerService | null { return this._schedulerService; }
  get teamStore(): TeamStore | null { return this._teamStore; }

  setProjectName(name: string): void {
    this._projectName = name;
  }

  setThreadMappingStore(store: ThreadMappingStore): void {
    this._threadMappingStore = store;
  }

  setConnected(
    mmClient: MattermostClient,
    wsClient: MattermostWebSocketClient,
    sessionManager: SessionManager,
    streamer: ResponseStreamer,
    notifications: NotificationService,
    fileHandler: FileHandler,
    reactionHandler: ReactionHandler,
    openCodeSessionRegistry: OpenCodeSessionRegistry,
    messageRouter: MessageRouter,
    commandHandler: CommandHandler,
    threadManager: ThreadManager | null,
    todoManager: TodoManager,
    questionHandler: QuestionHandler,
    guestApprovalHandler: GuestApprovalHandler,
    sessionOwnershipHandler: SessionOwnershipHandler,
    botUser: User
  ): void {
    this._isConnected = true;
    this._mmClient = mmClient;
    this._wsClient = wsClient;
    this._sessionManager = sessionManager;
    this._streamer = streamer;
    this._notifications = notifications;
    this._fileHandler = fileHandler;
    this._reactionHandler = reactionHandler;
    this._openCodeSessionRegistry = openCodeSessionRegistry;
    this._messageRouter = messageRouter;
    this._commandHandler = commandHandler;
    this._threadManager = threadManager;
    this._todoManager = todoManager;
    this._questionHandler = questionHandler;
    this._guestApprovalHandler = guestApprovalHandler;
    this._sessionOwnershipHandler = sessionOwnershipHandler;
    this._botUser = botUser;
  }

  setQuestionCleanupTimer(timer: ReturnType<typeof setInterval> | null): void {
    this._questionCleanupTimer = timer;
  }

  setPendingCleanupTimer(timer: ReturnType<typeof setInterval> | null): void {
    this._pendingCleanupTimer = timer;
  }

  setFileCompletionHandler(handler: FileCompletionHandler): void {
    this._fileCompletionHandler = handler;
  }

  setSchedulerService(service: SchedulerService): void {
    this._schedulerService = service;
  }

  setTeamStore(store: TeamStore): void {
    this._teamStore = store;
  }

  disconnect(): void {
    // Stop the scheduler first
    if (this._schedulerService) {
      this._schedulerService.stop();
      this._schedulerService = null;
    }
    // Shutdown team store
    if (this._teamStore) {
      this._teamStore.shutdown();
      this._teamStore = null;
    }
    // Clear pending cleanup timer
    if (this._pendingCleanupTimer) {
      clearInterval(this._pendingCleanupTimer);
      this._pendingCleanupTimer = null;
    }
    for (const [_, timer] of this.activeToolTimers) {
      clearInterval(timer);
    }
    this.activeToolTimers.clear();
    this.activeResponseContexts.clear();
    
    // Release all thread claims before disconnecting
    const pgStore = this._threadMappingStore?.getPgStore();
    const instanceId = this._threadMappingStore?.getInstanceId() ?? "local";
    if (pgStore && instanceId !== "local") {
      pgStore.releaseAllClaims(instanceId).catch(() => {
        // Ignore errors during shutdown
      });
    }
    
    this._wsClient?.disconnect();
    this._sessionManager?.shutdown();
    this._fileHandler?.cleanupTempFiles();
    this._openCodeSessionRegistry?.clear();
    this._threadMappingStore?.shutdown();

    this._isConnected = false;
    this._mmClient = null;
    this._wsClient = null;
    this._sessionManager = null;
    this._streamer = null;
    this._notifications = null;
    this._fileHandler = null;
    this._reactionHandler = null;
    this._openCodeSessionRegistry = null;
    this._messageRouter = null;
    this._commandHandler = null;
    this._threadManager = null;
    this._questionHandler = null;
    this._guestApprovalHandler = null;
    this._sessionOwnershipHandler = null;
    this._fileCompletionHandler = null;
  }
}

export const PluginState = new PluginStateManager();
