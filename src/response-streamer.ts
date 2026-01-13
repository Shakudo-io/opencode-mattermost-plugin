import type { MattermostClient } from "./clients/mattermost-client.js";
import type { StreamingConfig } from "./config.js";
import type { UserSession } from "./session-manager.js";
import { log } from "./logger.js";

export interface StreamContext {
  postId: string;
  channelId: string;
  buffer: string;
  lastUpdateTime: number;
  totalChunks: number;
  isCancelled: boolean;
}

export class ResponseStreamer {
  private mmClient: MattermostClient;
  private config: StreamingConfig;
  private activeStreams: Map<string, StreamContext> = new Map();

  constructor(mmClient: MattermostClient, config: StreamingConfig) {
    this.mmClient = mmClient;
    this.config = config;
  }

  async startStream(session: UserSession, initialText: string = ""): Promise<StreamContext> {
    const displayText = initialText || "Thinking...";
    const post = await this.mmClient.createPost(session.dmChannelId, displayText + " ...");

    const ctx: StreamContext = {
      postId: post.id,
      channelId: session.dmChannelId,
      buffer: initialText,
      lastUpdateTime: Date.now(),
      totalChunks: 0,
      isCancelled: false,
    };

    this.activeStreams.set(post.id, ctx);
    return ctx;
  }

  async appendChunk(ctx: StreamContext, chunk: string): Promise<void> {
    if (ctx.isCancelled) return;

    ctx.buffer += chunk;
    ctx.totalChunks++;

    const now = Date.now();
    const timeSinceLastUpdate = now - ctx.lastUpdateTime;
    const shouldUpdate =
      ctx.buffer.length >= this.config.bufferSize || timeSinceLastUpdate >= this.config.maxDelay;

    if (shouldUpdate) {
      await this.flushBuffer(ctx);
    }
  }

  private async flushBuffer(ctx: StreamContext): Promise<void> {
    if (ctx.isCancelled) return;

    const timeSinceLastUpdate = Date.now() - ctx.lastUpdateTime;
    const minInterval = 1000 / this.config.editRateLimit;

    if (timeSinceLastUpdate < minInterval) {
      await this.sleep(minInterval - timeSinceLastUpdate);
    }

    try {
      await this.mmClient.updatePost(ctx.postId, ctx.buffer + " ...");
      ctx.lastUpdateTime = Date.now();
    } catch (error) {
      log.error("[ResponseStreamer] Failed to update post:", error);
    }
  }

  async updateStream(ctx: StreamContext, fullText: string): Promise<void> {
    if (ctx.isCancelled) return;

    ctx.buffer = fullText;

    const now = Date.now();
    const timeSinceLastUpdate = now - ctx.lastUpdateTime;
    const minInterval = 1000 / this.config.editRateLimit;

    if (timeSinceLastUpdate >= minInterval) {
      try {
        await this.mmClient.updatePost(ctx.postId, ctx.buffer + " ...");
        ctx.lastUpdateTime = Date.now();
      } catch (error) {
        log.error("[ResponseStreamer] Failed to update post:", error);
      }
    }
  }

  async endStream(ctx: StreamContext): Promise<void> {
    if (ctx.isCancelled) return;

    this.activeStreams.delete(ctx.postId);

    try {
      await this.mmClient.updatePost(ctx.postId, ctx.buffer || "(No response)");
    } catch (error) {
      log.error("[ResponseStreamer] Failed to finalize post:", error);
    }
  }

  async cancelStream(ctx: StreamContext): Promise<void> {
    ctx.isCancelled = true;
    this.activeStreams.delete(ctx.postId);

    try {
      await this.mmClient.updatePost(ctx.postId, ctx.buffer + "\n\n*(Cancelled)*");
    } catch (error) {
      log.error("[ResponseStreamer] Failed to mark post as cancelled:", error);
    }
  }

  isStreaming(postId: string): boolean {
    return this.activeStreams.has(postId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
