import type { MattermostClient } from "./clients/mattermost-client.js";
import type { StreamingConfig } from "./config.js";
import type { UserSession } from "./session-manager.js";
import { StatusIndicator, createStatusIndicator } from "./status-indicator.js";
import { log } from "./logger.js";

export interface StreamContext {
  postId: string;
  channelId: string;
  threadRootPostId?: string;
  buffer: string;
  lastUpdateTime: number;
  totalChunks: number;
  isCancelled: boolean;
  continuationPostIds: string[];
  currentPostContent: string;
  statusIndicator?: StatusIndicator;
}

export class ResponseStreamer {
  private mmClient: MattermostClient;
  private config: StreamingConfig;
  private activeStreams: Map<string, StreamContext> = new Map();

  constructor(mmClient: MattermostClient, config: StreamingConfig) {
    this.mmClient = mmClient;
    this.config = config;
  }

  async startStream(session: UserSession, threadRootPostId?: string, initialText: string = ""): Promise<StreamContext> {
    const statusIndicator = await createStatusIndicator(
      this.mmClient,
      session.dmChannelId,
      threadRootPostId,
      "Checking session status..."
    );

    const ctx: StreamContext = {
      postId: statusIndicator.getPostId(),
      channelId: session.dmChannelId,
      threadRootPostId,
      buffer: initialText,
      lastUpdateTime: Date.now(),
      totalChunks: 0,
      isCancelled: false,
      continuationPostIds: [],
      currentPostContent: initialText,
      statusIndicator,
    };

    this.activeStreams.set(ctx.postId, ctx);
    return ctx;
  }

  async startStreamWithStatus(
    session: UserSession, 
    threadRootPostId?: string,
    initialReason: string = "Checking session status..."
  ): Promise<{ streamCtx: StreamContext; statusIndicator: StatusIndicator }> {
    const statusIndicator = await createStatusIndicator(
      this.mmClient,
      session.dmChannelId,
      threadRootPostId,
      initialReason
    );

    const ctx: StreamContext = {
      postId: statusIndicator.getPostId(),
      channelId: session.dmChannelId,
      threadRootPostId,
      buffer: "",
      lastUpdateTime: Date.now(),
      totalChunks: 0,
      isCancelled: false,
      continuationPostIds: [],
      currentPostContent: "",
      statusIndicator,
    };

    this.activeStreams.set(ctx.postId, ctx);
    return { streamCtx: ctx, statusIndicator };
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
      await this.updateWithSplitting(ctx, ctx.buffer + " ...");
      ctx.lastUpdateTime = Date.now();
    } catch (error) {
      log.error("[ResponseStreamer] Failed to update post:", error);
    }
  }

  async updateStream(ctx: StreamContext, fullText: string): Promise<void> {
    if (ctx.isCancelled) return;

    ctx.buffer = fullText;

    if (ctx.statusIndicator && !ctx.statusIndicator.hasContentStarted()) {
      ctx.statusIndicator.markContentStarted();
    }

    const now = Date.now();
    const timeSinceLastUpdate = now - ctx.lastUpdateTime;
    const minInterval = 1000 / this.config.editRateLimit;

    if (timeSinceLastUpdate >= minInterval) {
      try {
        await this.updateWithSplitting(ctx, ctx.buffer + " ...");
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
      if (ctx.statusIndicator) {
        await ctx.statusIndicator.setComplete();
      }
      const finalContent = ctx.buffer || "(No response)";
      await this.updateWithSplitting(ctx, finalContent);
    } catch (error) {
      log.error("[ResponseStreamer] Failed to finalize post:", error);
    }
  }

  async cancelStream(ctx: StreamContext): Promise<void> {
    ctx.isCancelled = true;
    this.activeStreams.delete(ctx.postId);

    try {
      const cancelledContent = ctx.buffer + "\n\n*(Cancelled)*";
      await this.updateWithSplitting(ctx, cancelledContent);
    } catch (error) {
      log.error("[ResponseStreamer] Failed to mark post as cancelled:", error);
    }
  }

  private async updateWithSplitting(ctx: StreamContext, content: string): Promise<void> {
    const maxLen = this.config.maxPostLength;
    
    if (content.length <= maxLen) {
      await this.mmClient.updatePost(ctx.postId, content);
      ctx.currentPostContent = content;
      return;
    }

    const parts = this.splitMessage(content, maxLen);
    
    const firstPartWithContinuation = parts.length > 1 
      ? parts[0] + "\n\n*(continued below...)*"
      : parts[0];
    
    await this.mmClient.updatePost(ctx.postId, firstPartWithContinuation);
    ctx.currentPostContent = firstPartWithContinuation;

    for (let i = 1; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const partContent = isLast 
        ? `*(continued ${i + 1}/${parts.length})*\n\n${parts[i]}`
        : `*(continued ${i + 1}/${parts.length})*\n\n${parts[i]}\n\n*(continued below...)*`;

      if (ctx.continuationPostIds[i - 1]) {
        await this.mmClient.updatePost(ctx.continuationPostIds[i - 1], partContent);
      } else {
        const post = await this.mmClient.createPost(
          ctx.channelId, 
          partContent, 
          ctx.threadRootPostId
        );
        ctx.continuationPostIds.push(post.id);
      }
    }

    const extraPosts = ctx.continuationPostIds.length - (parts.length - 1);
    if (extraPosts > 0) {
      for (let i = 0; i < extraPosts; i++) {
        const postIdToRemove = ctx.continuationPostIds.pop();
        if (postIdToRemove) {
          try {
            await this.mmClient.updatePost(postIdToRemove, "*(message consolidated above)*");
          } catch (e) {
            log.debug("[ResponseStreamer] Could not update orphaned continuation post");
          }
        }
      }
    }
  }

  private splitMessage(content: string, maxLen: number): string[] {
    if (content.length <= maxLen) {
      return [content];
    }

    const parts: string[] = [];
    let remaining = content;
    const reservedSpace = 50;
    const effectiveMax = maxLen - reservedSpace;

    while (remaining.length > 0) {
      if (remaining.length <= effectiveMax) {
        parts.push(remaining);
        break;
      }

      let splitPoint = this.findSplitPoint(remaining, effectiveMax);
      parts.push(remaining.substring(0, splitPoint).trimEnd());
      remaining = remaining.substring(splitPoint).trimStart();
    }

    return parts;
  }

  private findSplitPoint(text: string, maxLen: number): number {
    const doubleNewline = text.lastIndexOf("\n\n", maxLen);
    if (doubleNewline > maxLen * 0.5) {
      return doubleNewline + 2;
    }

    const singleNewline = text.lastIndexOf("\n", maxLen);
    if (singleNewline > maxLen * 0.5) {
      return singleNewline + 1;
    }

    const space = text.lastIndexOf(" ", maxLen);
    if (space > maxLen * 0.7) {
      return space + 1;
    }

    return maxLen;
  }

  isStreaming(postId: string): boolean {
    return this.activeStreams.has(postId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
