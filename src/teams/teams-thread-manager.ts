import {
  TurnContext,
  ConversationReference,
  MessageFactory,
  CardFactory,
} from "botbuilder";
import { teamsLog } from "./teams-logger.js";
import type { TeamsConfig } from "./teams-config.js";
import {
  getTeamsThreadMappingStore,
  type TeamsThreadMappingStore,
} from "../persistence/teams-thread-mapping-store.js";
import {
  type TeamsThreadMapping,
  createDefaultTeamsThreadMapping,
} from "../models/teams-types.js";
import {
  getOpenCodeBridge,
  type OpenCodeBridge,
  type SessionEvent,
} from "./opencode-bridge.js";
import type { OpenCodeSessionInfo } from "../opencode-session-registry.js";
import {
  getTeamsResponseStreamer,
  type TeamsResponseStreamer,
} from "./teams-response-streamer.js";

export interface TeamsThreadManagerOptions {
  config: TeamsConfig;
  adapter: import("botbuilder").CloudAdapter;
}

export interface ThreadCreationResult {
  mapping: TeamsThreadMapping;
  rootMessageId: string;
}

export class TeamsThreadManager {
  private readonly log = teamsLog.withContext("ThreadManager");
  private readonly config: TeamsConfig;
  private readonly adapter: import("botbuilder").CloudAdapter;
  private readonly store: TeamsThreadMappingStore;
  private readonly streamer: TeamsResponseStreamer;
  private bridge: OpenCodeBridge | null = null;
  private initialized = false;

  constructor(options: TeamsThreadManagerOptions) {
    this.config = options.config;
    this.adapter = options.adapter;
    this.store = getTeamsThreadMappingStore();
    this.streamer = getTeamsResponseStreamer({
      updateIntervalMs: this.config.bot.cardUpdateInterval,
      maxCardSizeBytes: this.config.bot.maxCardSize,
      rateLimitRps: this.config.bot.rateLimit,
    });
    this.log.info("TeamsThreadManager created");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.store.load();
    this.log.info("Thread mappings loaded");

    try {
      this.bridge = getOpenCodeBridge();
      this.bridge.getSessions();
      this.log.info("OpenCodeBridge connected");
    } catch {
      this.log.warn("OpenCodeBridge not available yet");
    }

    this.initialized = true;
    this.log.info("TeamsThreadManager initialized");
  }

  setBridge(bridge: OpenCodeBridge): void {
    this.bridge = bridge;
    this.log.info(`Bridge set (connected=${bridge.isConnected()})`);
  }

  async createThreadForSession(
    context: TurnContext,
    session: OpenCodeSessionInfo
  ): Promise<ThreadCreationResult> {
    const activity = context.activity;
    const userId = activity.from?.id;
    if (!userId) {
      this.log.error("Missing Teams userId while creating thread");
      throw new Error("Missing Teams userId for thread creation");
    }
    const conversationId = activity.conversation?.id;
    if (!conversationId) {
      this.log.error("Missing Teams conversationId while creating thread");
      throw new Error("Missing Teams conversationId for thread creation");
    }

    this.log.info(
      `Creating thread for sessionId=${session.id} shortId=${session.shortId} userId=${userId} conversationId=${conversationId}`
    );

    const conversationReference = TurnContext.getConversationReference(activity) as ConversationReference;

    this.log.debug(
      `Conversation reference captured sessionId=${session.id} conversationId=${conversationReference.conversation?.id} serviceUrl=${conversationReference.serviceUrl}`
    );

    const rootMessage = this.buildSessionStartCard(session);
    const response = await context.sendActivity(rootMessage);

    if (!response?.id) {
      throw new Error("Failed to send thread root message");
    }

    const mapping = createDefaultTeamsThreadMapping({
      threadRootMessageId: response.id,
      conversationId,
      openCodeSessionId: session.id,
      teamsUserId: userId,
      conversationReference,
      metadata: {
        projectName: session.projectName,
        projectDirectory: session.directory,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      },
    });

    await this.store.save(mapping);

    this.log.info(`Thread created: ${mapping.id} for session ${session.shortId}`);

    return {
      mapping,
      rootMessageId: response.id,
    };
  }

  private buildSessionStartCard(session: OpenCodeSessionInfo): Partial<import("botbuilder").Activity> {
    this.log.debug(
      `Building session start card sessionId=${session.id} shortId=${session.shortId} project=${session.projectName}`
    );
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "TextBlock",
          size: "large",
          weight: "bolder",
          text: "🚀 OpenCode Session Started",
        },
        {
          type: "FactSet",
          facts: [
            { title: "Project", value: session.projectName || "Unknown" },
            { title: "Directory", value: session.directory || "Unknown" },
            { title: "Session", value: session.shortId },
            { title: "Started", value: new Date().toLocaleString() },
          ],
        },
        {
          type: "TextBlock",
          text: "Reply to this message to send prompts to this session.",
          wrap: true,
          spacing: "medium",
        },
      ],
    };

    return MessageFactory.attachment(CardFactory.adaptiveCard(card));
  }

  async routeMessageToSession(
    context: TurnContext,
    text: string
  ): Promise<{ handled: boolean; sessionId?: string; error?: string }> {
    const activity = context.activity;
    const conversationId = activity.conversation?.id;
    if (!conversationId) {
      this.log.error("Missing Teams conversationId while routing message");
      throw new Error("Missing Teams conversationId while routing message");
    }
    const userId = activity.from?.id;
    if (!userId) {
      this.log.error("Missing Teams userId while routing message");
      throw new Error("Missing Teams userId while routing message");
    }
    const replyToId = activity.replyToId;

    this.log.info(
      `Route message entry userId=${userId} conversationId=${conversationId} replyToId=${replyToId} textLength=${text.length}`
    );

    if (!replyToId) {
      this.log.info(`Route message not in thread conversationId=${conversationId}`);
      return { handled: false, error: "not_in_thread" };
    }

    const mapping = this.store.getByThreadRootMessageId(replyToId);
    if (!mapping) {
      const allMappingsInConversation = this.store.getByConversationId(conversationId);
      const possibleMapping = allMappingsInConversation.find(
        (m) => m.threadRootMessageId === replyToId
      );

      if (!possibleMapping) {
        this.log.warn(
          `Unknown thread replyToId=${replyToId} conversationId=${conversationId}`
        );
        return { handled: false, error: "unknown_thread" };
      }
    }

    const threadMapping = mapping || this.store.getByConversationId(conversationId).find(
      (m) => m.threadRootMessageId === replyToId
    );

    if (!threadMapping) {
      this.log.warn(
        `Thread mapping not found replyToId=${replyToId} conversationId=${conversationId}`
      );
      return { handled: false, error: "mapping_not_found" };
    }

    if (threadMapping.mode === "ended") {
      this.log.info(
        `Session ended for thread=${threadMapping.id} sessionId=${threadMapping.openCodeSessionId}`
      );
      await context.sendActivity(
        MessageFactory.text("❌ This session has ended. Start a new session by sending a message outside this thread.")
      );
      return { handled: true, error: "session_ended" };
    }

    if (threadMapping.mode === "merged") {
      this.log.info(
        `Thread merged thread=${threadMapping.id} sessionId=${threadMapping.openCodeSessionId}`
      );
      await context.sendActivity(
        MessageFactory.text("🔒 This thread has been merged into another thread.")
      );
      return { handled: true, error: "session_merged" };
    }

    if (!this.store.isUserApproved(threadMapping, userId)) {
      this.log.warn(
        `User not approved userId=${userId} thread=${threadMapping.id} sessionId=${threadMapping.openCodeSessionId}`
      );
      return { handled: false, error: "user_not_approved", sessionId: threadMapping.openCodeSessionId };
    }

    await this.store.updateActivity(threadMapping.id);

    if (!this.bridge || !this.bridge.isConnected()) {
      this.log.warn(
        `Bridge disconnected thread=${threadMapping.id} sessionId=${threadMapping.openCodeSessionId}`
      );
      await context.sendActivity(
        MessageFactory.text("⚠️ OpenCode is not connected. Please try again later.")
      );
      return { handled: true, error: "opencode_disconnected" };
    }

    const session = this.bridge.getSession(threadMapping.openCodeSessionId);
    if (!session) {
      this.log.warn(
        `Session not found for thread=${threadMapping.id} sessionId=${threadMapping.openCodeSessionId}`
      );
      await context.sendActivity(
        MessageFactory.text("⚠️ The OpenCode session is no longer available.")
      );
      await this.store.setMode(threadMapping.id, "ended");
      return { handled: true, error: "session_not_found" };
    }

    this.log.info(`Routing message to session ${threadMapping.openCodeSessionId}`);

    const streamId = await this.streamer.startStreaming(
      threadMapping.openCodeSessionId,
      text,
      context
    );

    this.log.debug(`Started streaming session ${streamId}`);

    try {
      await this.bridge.sendPrompt(
        threadMapping.openCodeSessionId,
        text,
        async (chunk) => {
          this.log.debug(`Received response chunk: type=${chunk.type}`);
          await this.streamer.handleChunk(streamId, chunk);
        }
      );

      await this.streamer.completeStreaming(streamId);
      this.log.debug(`Completed streaming session ${streamId}`);
    } catch (error) {
      this.log.error(`Error during streaming: ${error}`);
      this.streamer.cancelStreaming(streamId);
      throw error;
    }

    return { handled: true, sessionId: threadMapping.openCodeSessionId };
  }

  async handleSessionEnded(sessionId: string): Promise<void> {
    const mapping = this.store.getBySessionId(sessionId);
    if (!mapping) {
      this.log.debug(`No thread mapping found for ended session ${sessionId}`);
      return;
    }

    this.log.info(`Session ${sessionId} ended, updating thread ${mapping.id}`);

    await this.store.setMode(mapping.id, "ended");

    const endCard = this.buildSessionEndCard(mapping);
    await this.sendProactiveMessage(mapping.conversationReference, endCard);
  }

  private buildSessionEndCard(mapping: TeamsThreadMapping): Partial<import("botbuilder").Activity> {
    this.log.debug(
      `Building session end card sessionId=${mapping.openCodeSessionId} threadId=${mapping.id} mode=${mapping.mode}`
    );
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "TextBlock",
          size: "medium",
          weight: "bolder",
          text: "✅ Session Completed",
        },
        {
          type: "FactSet",
          facts: [
            { title: "Project", value: mapping.metadata.projectName || "Unknown" },
            { title: "Session", value: mapping.openCodeSessionId.split("_")[1]?.substring(0, 4) || mapping.openCodeSessionId },
            { title: "Started", value: mapping.metadata.startedAt ? new Date(mapping.metadata.startedAt).toLocaleString() : "Unknown" },
            { title: "Ended", value: new Date().toLocaleString() },
          ],
        },
        {
          type: "TextBlock",
          text: "This session has ended. Start a new session by sending a message outside this thread.",
          wrap: true,
          spacing: "medium",
          color: "attention",
        },
      ],
    };

    return MessageFactory.attachment(CardFactory.adaptiveCard(card));
  }

  async handleSessionEvent(event: SessionEvent): Promise<void> {
    switch (event.type) {
      case "session_created":
        this.log.debug(`Session created event: ${event.sessionId}`);
        break;

      case "session_deleted":
        await this.handleSessionEnded(event.sessionId);
        break;

      case "session_idle":
      case "question_asked":
      case "permission_requested":
        this.log.debug(`Session event ${event.type} for ${event.sessionId}`);
        break;
    }
  }

  async reconnectThreads(): Promise<number> {
    if (!this.bridge || !this.bridge.isConnected()) {
      this.log.warn("Cannot reconnect threads: OpenCodeBridge not connected");
      return 0;
    }

    const activeMappings = this.store.getActive();
    const sessions = this.bridge.getSessions();
    const sessionIds = new Set(sessions.map((s) => s.id));

    let reconnected = 0;
    let ended = 0;

    for (const mapping of activeMappings) {
      if (sessionIds.has(mapping.openCodeSessionId)) {
        this.log.debug(`Thread ${mapping.id} reconnected to session ${mapping.openCodeSessionId}`);
        reconnected++;
      } else {
        this.log.info(`Session ${mapping.openCodeSessionId} no longer exists, marking thread as ended`);
        await this.store.setMode(mapping.id, "ended");
        ended++;
      }
    }

    this.log.info(`Thread reconnection complete: ${reconnected} reconnected, ${ended} ended`);
    return reconnected;
  }

  private async sendProactiveMessage(
    conversationReference: ConversationReference,
    activity: Partial<import("botbuilder").Activity>
  ): Promise<void> {
    try {
      await this.adapter.continueConversationAsync(
        this.config.azure.appId,
        conversationReference,
        async (context) => {
          await context.sendActivity(activity);
        }
      );
      this.log.info(
        `Proactive message sent conversationId=${conversationReference.conversation?.id}`
      );
    } catch (error) {
      this.log.error(`Failed to send proactive message: ${error}`);
    }
  }

  getThreadBySessionId(sessionId: string): TeamsThreadMapping | undefined {
    const mapping = this.store.getBySessionId(sessionId);
    this.log.debug(`Get thread by session sessionId=${sessionId} found=${Boolean(mapping)}`);
    return mapping;
  }

  getThreadByRootMessageId(messageId: string): TeamsThreadMapping | undefined {
    return this.store.getByThreadRootMessageId(messageId);
  }

  getActiveThreadsForUser(userId: string): TeamsThreadMapping[] {
    const threads = this.store.getByTeamsUserId(userId).filter((m) => m.mode === "normal");
    this.log.debug(`Get active threads for user userId=${userId} count=${threads.length}`);
    return threads;
  }

  getAllActiveThreads(): TeamsThreadMapping[] {
    return this.store.getActive();
  }

  async approveUser(threadId: string, userId: string): Promise<boolean> {
    const mapping = this.store.getById(threadId);
    if (!mapping) {
      this.log.warn(`Approve user failed: thread not found threadId=${threadId}`);
      return false;
    }
    await this.store.addApprovedUser(threadId, userId);
    this.log.info(`User approved threadId=${threadId} userId=${userId}`);
    return true;
  }

  async setApproveAll(threadId: string, approveAll: boolean): Promise<boolean> {
    const mapping = this.store.getById(threadId);
    if (!mapping) {
      this.log.warn(`Set approve all failed: thread not found threadId=${threadId}`);
      return false;
    }
    await this.store.setApproveAll(threadId, approveAll);
    this.log.info(`Set approve all threadId=${threadId} approveAll=${approveAll}`);
    return true;
  }
}

let managerInstance: TeamsThreadManager | null = null;

export function getTeamsThreadManager(options?: TeamsThreadManagerOptions): TeamsThreadManager {
  if (!managerInstance && options) {
    managerInstance = new TeamsThreadManager(options);
  }
  if (!managerInstance) {
    throw new Error("TeamsThreadManager not initialized. Call getTeamsThreadManager with options first.");
  }
  return managerInstance;
}

export function clearTeamsThreadManager(): void {
  managerInstance = null;
}
