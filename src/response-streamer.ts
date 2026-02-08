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
  private updateLocks: Map<string, Promise<void>> = new Map();

  constructor(mmClient: MattermostClient, config: StreamingConfig) {
    this.mmClient = mmClient;
    this.config = config;
  }

  private async acquireLock(postId: string): Promise<() => void> {
    while (this.updateLocks.has(postId)) {
      await this.updateLocks.get(postId);
    }
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.updateLocks.set(postId, lockPromise);
    return () => {
      this.updateLocks.delete(postId);
      releaseLock!();
    };
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
    initialReason: string = "Checking session status...",
    overrideChannelId?: string
  ): Promise<{ streamCtx: StreamContext; statusIndicator: StatusIndicator }> {
    const targetChannelId = overrideChannelId || session.dmChannelId;
    const statusIndicator = await createStatusIndicator(
      this.mmClient,
      targetChannelId,
      threadRootPostId,
      initialReason
    );

    const ctx: StreamContext = {
      postId: statusIndicator.getPostId(),
      channelId: targetChannelId,
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
      await this.retryOperation(
        () => this.updateWithSplitting(ctx, ctx.buffer + " ..."),
        1,
        200
      );
      ctx.lastUpdateTime = Date.now();
    } catch (error) {
      log.warn("[ResponseStreamer] Failed to update post (non-critical):", error);
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
        await this.retryOperation(
          () => this.updateWithSplitting(ctx, ctx.buffer + " ..."),
          1,
          200
        );
        ctx.lastUpdateTime = Date.now();
      } catch (error) {
        log.warn("[ResponseStreamer] Failed to update post (non-critical):", error);
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
      await this.retryOperation(
        () => this.updateWithSplitting(ctx, finalContent),
        3,
        500
      );
    } catch (error) {
      log.error("[ResponseStreamer] Failed to update post after retries, attempting fallback:", error);
      try {
        const finalContent = ctx.buffer || "(No response)";
        await this.mmClient.createPost(
          ctx.channelId,
          `*(Response recovered)*\n\n${finalContent}`,
          ctx.threadRootPostId
        );
        log.info("[ResponseStreamer] Successfully posted final content via fallback");
      } catch (fallbackError) {
        log.error("[ResponseStreamer] Fallback also failed - response may be incomplete:", fallbackError);
      }
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

  async recreateStreamAtBottom(ctx: StreamContext, finalizeOldContent?: string): Promise<StreamContext> {
    this.activeStreams.delete(ctx.postId);

    try {
      if (finalizeOldContent !== undefined) {
        await this.mmClient.updatePost(ctx.postId, finalizeOldContent);
      } else {
        await this.mmClient.deletePost(ctx.postId);
      }
      
      for (const contPostId of ctx.continuationPostIds) {
        try {
          await this.mmClient.deletePost(contPostId);
        } catch (e) {
          log.debug(`[ResponseStreamer] Could not delete continuation post ${contPostId}`);
        }
      }
    } catch (error) {
      log.error("[ResponseStreamer] Failed to delete old stream post:", error);
    }

    const newPost = await this.mmClient.createPost(
      ctx.channelId,
      ctx.buffer || "...",
      ctx.threadRootPostId
    );

    const newCtx: StreamContext = {
      postId: newPost.id,
      channelId: ctx.channelId,
      threadRootPostId: ctx.threadRootPostId,
      buffer: ctx.buffer,
      lastUpdateTime: Date.now(),
      totalChunks: ctx.totalChunks,
      isCancelled: false,
      continuationPostIds: [],
      currentPostContent: ctx.buffer,
      statusIndicator: ctx.statusIndicator,
    };

    if (newCtx.statusIndicator) {
      newCtx.statusIndicator.updatePostId(newPost.id);
    }

    this.activeStreams.set(newCtx.postId, newCtx);
    return newCtx;
  }

  private async updateWithSplitting(ctx: StreamContext, content: string): Promise<void> {
    const releaseLock = await this.acquireLock(ctx.postId);
    try {
      await this.updateWithSplittingInternal(ctx, content);
    } finally {
      releaseLock();
    }
  }

  private async updateWithSplittingInternal(ctx: StreamContext, content: string): Promise<void> {
    const maxLen = this.config.maxPostLength;
    
    if (content.length <= maxLen) {
      await this.mmClient.updatePost(ctx.postId, content);
      ctx.currentPostContent = content;
      
      const orphanedPosts = ctx.continuationPostIds.splice(0);
      for (const postId of orphanedPosts) {
        try {
          await this.mmClient.deletePost(postId);
          log.debug(`[ResponseStreamer] Deleted orphaned continuation post ${postId}`);
        } catch (e) {
          log.warn(`[ResponseStreamer] Failed to delete orphaned post ${postId}, will retry as update`);
          try {
            await this.mmClient.updatePost(postId, "*(message consolidated above)*");
          } catch (e2) {
            log.error(`[ResponseStreamer] Failed to consolidate orphaned post ${postId}:`, e2);
          }
        }
      }
      return;
    }

    const parts = this.splitMessage(content, maxLen);
    
    const firstPartWithContinuation = parts.length > 1 
      ? parts[0] + "\n\n*(continued below...)*"
      : parts[0];
    
    await this.mmClient.updatePost(ctx.postId, firstPartWithContinuation);
    ctx.currentPostContent = firstPartWithContinuation;

    const neededContinuations = parts.length - 1;
    
    for (let i = 1; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const partContent = isLast 
        ? `*(continued ${i + 1}/${parts.length})*\n\n${parts[i]}`
        : `*(continued ${i + 1}/${parts.length})*\n\n${parts[i]}\n\n*(continued below...)*`;

      const existingPostId = ctx.continuationPostIds[i - 1];
      if (existingPostId) {
        try {
          await this.mmClient.updatePost(existingPostId, partContent);
        } catch (e) {
          log.warn(`[ResponseStreamer] Failed to update continuation ${existingPostId}, creating new`);
          const post = await this.mmClient.createPost(ctx.channelId, partContent, ctx.threadRootPostId);
          ctx.continuationPostIds[i - 1] = post.id;
        }
      } else {
        const post = await this.mmClient.createPost(ctx.channelId, partContent, ctx.threadRootPostId);
        ctx.continuationPostIds.push(post.id);
      }
    }

    const extraPosts = ctx.continuationPostIds.length - neededContinuations;
    if (extraPosts > 0) {
      log.debug(`[ResponseStreamer] Cleaning up ${extraPosts} extra continuation posts`);
      const postsToRemove = ctx.continuationPostIds.splice(neededContinuations);
      for (const postId of postsToRemove) {
        try {
          await this.mmClient.deletePost(postId);
          log.debug(`[ResponseStreamer] Deleted extra continuation post ${postId}`);
        } catch (e) {
          log.warn(`[ResponseStreamer] Failed to delete extra post ${postId}, updating instead`);
          try {
            await this.mmClient.updatePost(postId, "*(message consolidated above)*");
          } catch (e2) {
            log.error(`[ResponseStreamer] Failed to consolidate extra post ${postId}:`, e2);
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

  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 500
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          log.debug(`[ResponseStreamer] Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await this.sleep(delay);
        }
      }
    }
    throw lastError;
  }
}
