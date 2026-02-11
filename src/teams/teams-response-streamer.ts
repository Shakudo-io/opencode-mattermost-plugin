import { TurnContext, Activity, MessageFactory } from "botbuilder";
import { teamsLog } from "./teams-logger.js";
import type { TeamsConfig } from "./teams-config.js";
import type { ResponseChunk } from "./opencode-bridge.js";
import {
  createStatusCard,
  createResponseCard,
  createErrorResponseCard,
  createPaginatedResponseCards,
  type ToolStatus,
  MAX_CONTENT_LENGTH,
} from "./cards/index.js";

export interface StreamingSession {
  streamId: string;
  sessionId: string;
  prompt: string;
  startTime: number;
  context: TurnContext;
  statusMessageId: string | null;
  tools: ToolStatus[];
  chunks: string[];
  lastUpdateTime: number;
  isComplete: boolean;
  error: string | null;
}

export interface TeamsResponseStreamerConfig {
  updateIntervalMs: number;
  maxCardSizeBytes: number;
  rateLimitRps: number;
}

const DEFAULT_CONFIG: TeamsResponseStreamerConfig = {
  updateIntervalMs: 5000,
  maxCardSizeBytes: 25000,
  rateLimitRps: 30,
};

export class TeamsResponseStreamer {
  private readonly log = teamsLog.withContext("ResponseStreamer");
  private readonly config: TeamsResponseStreamerConfig;
  private readonly activeSessions: Map<string, StreamingSession> = new Map();
  private readonly updateTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private readonly requestTimes: number[] = [];
  private readonly updatingStreams = new Set<string>();

  constructor(config?: Partial<TeamsResponseStreamerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log.info(`ResponseStreamer initialized with ${this.config.updateIntervalMs}ms update interval`);
  }

  async startStreaming(
    sessionId: string,
    prompt: string,
    context: TurnContext
  ): Promise<string> {
    const streamId = `${sessionId}-${Date.now()}`;
    const startTime = Date.now();

    this.log.info(
      `Start streaming streamId=${streamId} sessionId=${sessionId} promptLength=${prompt.length}`
    );

    const session: StreamingSession = {
      streamId,
      sessionId,
      prompt,
      startTime,
      context,
      statusMessageId: null,
      tools: [],
      chunks: [],
      lastUpdateTime: startTime,
      isComplete: false,
      error: null,
    };

    this.activeSessions.set(streamId, session);

    const initialCard = createStatusCard({
      sessionId,
      prompt,
      startTime,
    });

    await this.checkRateLimit();
    const response = await context.sendActivity(MessageFactory.attachment(initialCard));

    if (response?.id) {
      session.statusMessageId = response.id;
    }

    this.startPeriodicUpdates(streamId);

    return streamId;
  }

  async handleChunk(streamId: string, chunk: ResponseChunk): Promise<void> {
    const session = this.activeSessions.get(streamId);
    if (!session) {
      this.log.warn(`No session found for streamId ${streamId}`);
      return;
    }

    const contentLength = chunk.content?.length ?? chunk.error?.length ?? 0;
    this.log.debug(
      `Handle chunk streamId=${streamId} sessionId=${session.sessionId} type=${chunk.type} contentLength=${contentLength}`
    );

    switch (chunk.type) {
      case "text":
        if (chunk.content) {
          session.chunks.push(chunk.content);
          const totalLength = session.chunks.join("").length;
          this.log.debug(
            `Chunk text streamId=${streamId} totalLength=${totalLength}`
          );
        }
        break;

      case "tool_start":
        if (chunk.toolName) {
          this.log.info(
            `Chunk tool_start streamId=${streamId} tool=${chunk.toolName}`
          );
          session.tools.push({
            name: chunk.toolName,
            status: "running",
            startTime: Date.now(),
            args: chunk.toolArgs,
          });
        }
        break;

      case "tool_end":
        if (chunk.toolName) {
          this.log.info(
            `Chunk tool_end streamId=${streamId} tool=${chunk.toolName}`
          );
          const tool = session.tools.find(
            (t) => t.name === chunk.toolName && t.status === "running"
          );
          if (tool) {
            tool.status = "completed";
            tool.endTime = Date.now();
            tool.result = chunk.toolResult;
          }
        }
        break;

      case "error":
        session.error = chunk.error || "error chunk received with no message";
        this.log.warn(
          `Chunk error streamId=${streamId} sessionId=${session.sessionId} errorLength=${session.error.length}`
        );
        const errorTool = session.tools.find((t) => t.status === "running");
        if (errorTool) {
          errorTool.status = "error";
          errorTool.endTime = Date.now();
          errorTool.error = chunk.error;
        }
        break;

      case "complete":
        this.log.info(
          `Chunk complete streamId=${streamId} sessionId=${session.sessionId}`
        );
        session.isComplete = true;
        break;
    }
  }

  async completeStreaming(streamId: string): Promise<void> {
    const session = this.activeSessions.get(streamId);
    if (!session) {
      this.log.warn(`No session found for streamId ${streamId}`);
      return;
    }

    this.stopPeriodicUpdates(streamId);

    const fullContent = session.chunks.join("");

    if (session.error) {
      await this.sendErrorCard(session, session.error, fullContent);
    } else if (fullContent.length > MAX_CONTENT_LENGTH) {
      await this.sendPaginatedResponse(session, fullContent);
    } else {
      await this.sendFinalResponseCard(session, fullContent);
    }

    this.activeSessions.delete(streamId);
    this.log.info(`Streaming session ${streamId} completed`);
  }

  cancelStreaming(streamId: string): void {
    const session = this.activeSessions.get(streamId);
    if (!session) {
      this.log.warn(`Cancel streaming streamId=${streamId} reason=not_found`);
      return;
    }

    this.stopPeriodicUpdates(streamId);
    this.activeSessions.delete(streamId);
    const reason = session.error ? "error" : "cancelled";
    this.log.info(`Cancel streaming streamId=${streamId} reason=${reason}`);
  }

  private startPeriodicUpdates(streamId: string): void {
    const timer = setInterval(async () => {
      await this.updateStatusCard(streamId);
    }, this.config.updateIntervalMs);

    this.updateTimers.set(streamId, timer);
    this.log.debug(
      `Start periodic updates streamId=${streamId} intervalMs=${this.config.updateIntervalMs}`
    );
  }

  private stopPeriodicUpdates(streamId: string): void {
    const timer = this.updateTimers.get(streamId);
    if (timer) {
      clearInterval(timer);
      this.updateTimers.delete(streamId);
      this.log.debug(`Stop periodic updates streamId=${streamId}`);
    }
  }

  private async updateStatusCard(streamId: string): Promise<void> {
    const session = this.activeSessions.get(streamId);
    if (!session || !session.statusMessageId || session.isComplete) return;
    if (this.updatingStreams.has(streamId)) return;
    this.updatingStreams.add(streamId);

    try {
      const currentContent = session.chunks.join("");
      const previewLength = 500;
      const preview = currentContent.length > previewLength
        ? currentContent.slice(-previewLength)
        : currentContent;

    const card = createStatusCard({
      sessionId: session.sessionId,
      prompt: session.prompt,
      startTime: session.startTime,
      tools: session.tools,
      currentOutput: preview,
    });

    const cardSizeBytes = Buffer.byteLength(JSON.stringify(card), "utf8");
    const elapsedMs = Date.now() - session.startTime;
    this.log.debug(
      `Update status card attempt streamId=${streamId} cardBytes=${cardSizeBytes} toolsCount=${session.tools.length} elapsedMs=${elapsedMs}`
    );

      try {
        await this.checkRateLimit();

        const updateActivity: Partial<Activity> = {
          id: session.statusMessageId,
          type: "message",
          attachments: [card],
        };

        await session.context.updateActivity(updateActivity);
        session.lastUpdateTime = Date.now();
      } catch (error) {
        this.log.error(`Failed to update status card: ${error}`);
      }
    } finally {
      this.updatingStreams.delete(streamId);
    }
  }

  private async sendFinalResponseCard(
    session: StreamingSession,
    content: string
  ): Promise<void> {
    this.log.info(
      `Send final response card streamId=${session.streamId} contentLength=${content.length} paginated=no pageCount=1`
    );
    const responseCard = createResponseCard({
      sessionId: session.sessionId,
      content,
      startTime: session.startTime,
      endTime: Date.now(),
      prompt: session.prompt,
      tools: session.tools,
    });

    try {
      await this.checkRateLimit();

      if (session.statusMessageId) {
        const updateActivity: Partial<Activity> = {
          id: session.statusMessageId,
          type: "message",
          attachments: [responseCard],
        };
        await session.context.updateActivity(updateActivity);
      } else {
        await session.context.sendActivity(MessageFactory.attachment(responseCard));
      }
    } catch (error) {
      this.log.error(`Failed to send final response: ${error}`);
    }
  }

  private async sendErrorCard(
    session: StreamingSession,
    errorMessage: string,
    details?: string
  ): Promise<void> {
    const errorCard = createErrorResponseCard(
      session.sessionId,
      errorMessage,
      session.startTime,
      details
    );

    try {
      await this.checkRateLimit();

      if (session.statusMessageId) {
        const updateActivity: Partial<Activity> = {
          id: session.statusMessageId,
          type: "message",
          attachments: [errorCard],
        };
        await session.context.updateActivity(updateActivity);
      } else {
        await session.context.sendActivity(MessageFactory.attachment(errorCard));
      }
    } catch (error) {
      this.log.error(`Failed to send error card: ${error}`);
    }
  }

  private async sendPaginatedResponse(
    session: StreamingSession,
    content: string
  ): Promise<void> {
    const cards = createPaginatedResponseCards(
      {
        sessionId: session.sessionId,
        startTime: session.startTime,
        endTime: Date.now(),
        prompt: session.prompt,
        tools: session.tools,
      },
      content
    );

    this.log.info(
      `Send paginated response streamId=${session.streamId} contentLength=${content.length} paginated=yes pageCount=${cards.length}`
    );

    try {
      if (session.statusMessageId && cards.length > 0) {
        await this.checkRateLimit();
        const updateActivity: Partial<Activity> = {
          id: session.statusMessageId,
          type: "message",
          attachments: [cards[0]],
        };
        await session.context.updateActivity(updateActivity);
      }

      for (let i = 1; i < cards.length; i++) {
        await this.checkRateLimit();
        await session.context.sendActivity(MessageFactory.attachment(cards[i]));
      }
    } catch (error) {
      this.log.error(`Failed to send paginated response: ${error}`);
    }
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const windowStart = now - 1000;

    this.requestTimes.push(now);

    while (this.requestTimes.length > 0 && this.requestTimes[0] < windowStart) {
      this.requestTimes.shift();
    }

    if (this.requestTimes.length >= this.config.rateLimitRps) {
      const waitTime = 1000 - (now - this.requestTimes[0]);
      if (waitTime > 0) {
        this.log.warn(
          `Rate limit reached currentRps=${this.requestTimes.length} limit=${this.config.rateLimitRps} waitMs=${waitTime}`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  isSessionActive(streamId: string): boolean {
    return this.activeSessions.has(streamId);
  }

  getSessionProgress(streamId: string): {
    elapsedMs: number;
    chunkCount: number;
    toolCount: number;
    contentLength: number;
  } | null {
    const session = this.activeSessions.get(streamId);
    if (!session) return null;

    return {
      elapsedMs: Date.now() - session.startTime,
      chunkCount: session.chunks.length,
      toolCount: session.tools.length,
      contentLength: session.chunks.join("").length,
    };
  }
}

let streamerInstance: TeamsResponseStreamer | null = null;

export function getTeamsResponseStreamer(
  config?: Partial<TeamsResponseStreamerConfig>
): TeamsResponseStreamer {
  if (!streamerInstance) {
    streamerInstance = new TeamsResponseStreamer(config);
  }
  return streamerInstance;
}

export function clearTeamsResponseStreamer(): void {
  if (streamerInstance) {
    for (const [streamId] of streamerInstance["activeSessions"]) {
      streamerInstance.cancelStreaming(streamId);
    }
    streamerInstance = null;
  }
}
