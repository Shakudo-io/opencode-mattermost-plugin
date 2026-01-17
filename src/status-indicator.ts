import type { MattermostClient } from "./clients/mattermost-client.js";
import { log } from "./logger.js";

export type PromptState =
  | { state: "queued"; reason: string; position?: number }
  | { state: "connecting"; sessionId: string; shortId: string }
  | { state: "processing"; startedAt: number }
  | { state: "tool_running"; tool: string; startedAt: number }
  | { state: "waiting"; reason: "permission" | "question"; details?: string }
  | { state: "retrying"; attempt: number; maxAttempts: number; nextRetryAt: number; error: string }
  | { state: "error"; error: string; recoverable: boolean }
  | { state: "complete"; duration: number };

const STATUS_EMOJI: Record<PromptState["state"], string> = {
  queued: "⏳",
  connecting: "🔗",
  processing: "💻",
  tool_running: "🔧",
  waiting: "⏸️",
  retrying: "🔄",
  error: "❌",
  complete: "✅",
};

const STATUS_LABELS: Record<PromptState["state"], string> = {
  queued: "Queued",
  connecting: "Connecting",
  processing: "Processing",
  tool_running: "Running Tool",
  waiting: "Waiting",
  retrying: "Retrying",
  error: "Error",
  complete: "Complete",
};

export interface StatusIndicatorConfig {
  postId: string;
  channelId: string;
  threadRootPostId?: string;
  sessionShortId?: string;
  projectName?: string;
}

export class StatusIndicator {
  private mmClient: MattermostClient;
  private config: StatusIndicatorConfig;
  private currentState: PromptState;
  private startTime: number;
  private lastUpdateTime: number;
  private updateThrottleMs: number = 500;
  private contentStarted: boolean = false;
  private processingStartedAt: number | null = null;

  constructor(mmClient: MattermostClient, config: StatusIndicatorConfig) {
    this.mmClient = mmClient;
    this.config = config;
    this.startTime = Date.now();
    this.lastUpdateTime = 0;
    this.currentState = { state: "queued", reason: "Initializing..." };
  }

  hasContentStarted(): boolean {
    return this.contentStarted;
  }

  markContentStarted(): void {
    this.contentStarted = true;
  }

  getState(): PromptState {
    return this.currentState;
  }

  getPostId(): string {
    return this.config.postId;
  }

  formatStatusMessage(includeContent: boolean = false, content?: string): string {
    const emoji = STATUS_EMOJI[this.currentState.state];
    const label = STATUS_LABELS[this.currentState.state];
    
    let statusLine = `${emoji} **${label}**`;
    let details = "";

    switch (this.currentState.state) {
      case "queued":
        details = this.currentState.reason;
        if (this.currentState.position !== undefined) {
          details += ` (position ${this.currentState.position})`;
        }
        break;

      case "connecting":
        details = `Session: ${this.currentState.shortId}`;
        break;

      case "processing":
        const elapsed = Math.round((Date.now() - this.currentState.startedAt) / 1000);
        details = `${elapsed}s elapsed`;
        break;

      case "tool_running":
        const toolElapsed = Math.round((Date.now() - this.currentState.startedAt) / 1000);
        details = `\`${this.currentState.tool}\` (${toolElapsed}s)`;
        break;

      case "waiting":
        if (this.currentState.reason === "permission") {
          details = "Awaiting permission approval";
        } else {
          details = "Awaiting your response";
        }
        if (this.currentState.details) {
          details += `\n> ${this.currentState.details}`;
        }
        break;

      case "retrying":
        const retryIn = Math.max(0, Math.round((this.currentState.nextRetryAt - Date.now()) / 1000));
        details = `Attempt ${this.currentState.attempt}/${this.currentState.maxAttempts}`;
        if (retryIn > 0) {
          details += ` - retry in ${retryIn}s`;
        }
        details += `\n> ${this.currentState.error}`;
        break;

      case "error":
        details = this.currentState.error;
        if (this.currentState.recoverable) {
          details += "\n\n_React with 🔁 to retry_";
        }
        break;

      case "complete":
        const duration = Math.round(this.currentState.duration / 1000);
        details = `Completed in ${duration}s`;
        break;
    }

    let message = statusLine;
    if (details) {
      message += `\n${details}`;
    }

    if (includeContent && content) {
      message += `\n\n---\n\n${content}`;
    }

    if (["processing", "tool_running", "connecting"].includes(this.currentState.state)) {
      if (!includeContent) {
        message += " ...";
      }
    }

    return message;
  }

  private async updatePost(content?: string): Promise<void> {
    const now = Date.now();
    
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      return;
    }

    try {
      const message = this.formatStatusMessage(!!content, content);
      await this.mmClient.updatePost(this.config.postId, message);
      this.lastUpdateTime = now;
    } catch (e) {
      log.error("[StatusIndicator] Failed to update post:", e);
    }
  }

  async setQueued(reason: string, position?: number): Promise<void> {
    this.currentState = { state: "queued", reason, position };
    log.debug(`[StatusIndicator] State -> queued: ${reason}`);
    await this.updatePost();
  }

  async setConnecting(sessionId: string, shortId: string): Promise<void> {
    if (this.processingStartedAt === null) {
      this.processingStartedAt = Date.now();
    }
    this.currentState = { state: "connecting", sessionId, shortId };
    log.debug(`[StatusIndicator] State -> connecting: ${shortId}`);
    await this.updatePost();
  }

  async setProcessing(): Promise<void> {
    if (this.processingStartedAt === null) {
      this.processingStartedAt = Date.now();
    }
    this.currentState = { state: "processing", startedAt: this.processingStartedAt };
    log.debug("[StatusIndicator] State -> processing");
    if (!this.contentStarted) {
      await this.updatePost();
    }
  }

  async setToolRunning(tool: string): Promise<void> {
    const startedAt = this.processingStartedAt || Date.now();
    this.currentState = { state: "tool_running", tool, startedAt };
    log.debug(`[StatusIndicator] State -> tool_running: ${tool}`);
    if (!this.contentStarted) {
      await this.updatePost();
    }
  }

  async setWaiting(reason: "permission" | "question", details?: string): Promise<void> {
    this.currentState = { state: "waiting", reason, details };
    log.debug(`[StatusIndicator] State -> waiting: ${reason}`);
    await this.updatePost();
  }

  async setRetrying(attempt: number, maxAttempts: number, error: string, nextRetryMs: number): Promise<void> {
    this.currentState = {
      state: "retrying",
      attempt,
      maxAttempts,
      error,
      nextRetryAt: Date.now() + nextRetryMs,
    };
    log.debug(`[StatusIndicator] State -> retrying: attempt ${attempt}/${maxAttempts}`);
    await this.updatePost();
  }

  async setError(error: string, recoverable: boolean = true): Promise<void> {
    this.currentState = { state: "error", error, recoverable };
    log.debug(`[StatusIndicator] State -> error: ${error}`);
    await this.updatePost();
  }

  async setComplete(): Promise<void> {
    const duration = Date.now() - this.startTime;
    this.currentState = { state: "complete", duration };
    log.debug(`[StatusIndicator] State -> complete: ${duration}ms`);
  }

  async updateWithContent(content: string): Promise<void> {
    if (this.currentState.state !== "processing" && this.currentState.state !== "tool_running") {
      this.currentState = { state: "processing", startedAt: Date.now() };
    }
    await this.updatePost(content);
  }

  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  isTerminal(): boolean {
    return this.currentState.state === "complete" || this.currentState.state === "error";
  }

  isActive(): boolean {
    return ["connecting", "processing", "tool_running"].includes(this.currentState.state);
  }
}

export async function createStatusIndicator(
  mmClient: MattermostClient,
  channelId: string,
  threadRootPostId?: string,
  initialReason: string = "Received message..."
): Promise<StatusIndicator> {
  const initialMessage = `⏳ **Queued**\n${initialReason} ...`;
  const post = await mmClient.createPost(channelId, initialMessage, threadRootPostId);

  const indicator = new StatusIndicator(mmClient, {
    postId: post.id,
    channelId,
    threadRootPostId,
  });

  return indicator;
}
