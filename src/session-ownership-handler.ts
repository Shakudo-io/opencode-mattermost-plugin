import { log } from "./logger.js";
import type { Post } from "./models/index.js";

export interface PendingOwnershipConfirmation {
  requestPostId: string;
  userId: string;
  username: string;
  originalPost: Post;
  threadRootPostId: string;
  channelId: string;
  createdAt: Date;
}

export class SessionOwnershipHandler {
  private mmClient: any;
  private pendingConfirmations: Map<string, PendingOwnershipConfirmation> = new Map();
  private readonly CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(mmClient: any) {
    this.mmClient = mmClient;
  }

  private getKey(channelId: string, threadRootPostId: string): string {
    return `${channelId}:${threadRootPostId}`;
  }

  async requestOwnershipConfirmation(
    post: Post,
    username: string,
    threadRootPostId: string,
    channelId: string
  ): Promise<string> {
    const key = this.getKey(channelId, threadRootPostId);

    const confirmationMessage = `No session exists for this thread yet.

**Do you want to create a session with your OpenCode instance?**
- Reply \`yes\` to create a session now
- Reply \`no\` if you want someone else to be the session owner

_Request expires in 5 minutes_`;

    const requestPost = await this.mmClient.createPost(
      channelId,
      confirmationMessage,
      threadRootPostId
    );

    const pending: PendingOwnershipConfirmation = {
      requestPostId: requestPost.id,
      userId: post.user_id,
      username,
      originalPost: post,
      threadRootPostId,
      channelId,
      createdAt: new Date(),
    };

    this.pendingConfirmations.set(key, pending);
    log.info(`[SessionOwnership] Requested confirmation from @${username} for thread ${threadRootPostId.substring(0, 8)}`);

    return requestPost.id;
  }

  hasPendingConfirmation(channelId: string, threadRootPostId: string, userId: string): boolean {
    const key = this.getKey(channelId, threadRootPostId);
    const pending = this.pendingConfirmations.get(key);
    if (!pending) return false;

    if (pending.userId !== userId) return false;

    const elapsed = Date.now() - pending.createdAt.getTime();
    if (elapsed > this.CONFIRMATION_TIMEOUT_MS) {
      this.pendingConfirmations.delete(key);
      log.info(`[SessionOwnership] Confirmation request expired for thread ${threadRootPostId.substring(0, 8)}`);
      return false;
    }

    return true;
  }

  getPendingConfirmation(channelId: string, threadRootPostId: string): PendingOwnershipConfirmation | undefined {
    const key = this.getKey(channelId, threadRootPostId);
    const pending = this.pendingConfirmations.get(key);
    if (!pending) return undefined;

    const elapsed = Date.now() - pending.createdAt.getTime();
    if (elapsed > this.CONFIRMATION_TIMEOUT_MS) {
      this.pendingConfirmations.delete(key);
      return undefined;
    }

    return pending;
  }

  async handleReply(
    channelId: string,
    threadRootPostId: string,
    replyText: string
  ): Promise<{ confirmed: boolean; post?: Post; message: string }> {
    const key = this.getKey(channelId, threadRootPostId);
    const pending = this.pendingConfirmations.get(key);
    if (!pending) {
      return { confirmed: false, message: "No pending confirmation request found." };
    }

    const trimmed = replyText.trim().toLowerCase();

    if (trimmed === "yes" || trimmed === "y" || trimmed === "1") {
      this.pendingConfirmations.delete(key);
      log.info(`[SessionOwnership] @${pending.username} confirmed session creation for thread ${threadRootPostId.substring(0, 8)}`);
      return { confirmed: true, post: pending.originalPost, message: "Session will be created." };
    }

    if (trimmed === "no" || trimmed === "n" || trimmed === "0") {
      this.pendingConfirmations.delete(key);
      await this.mmClient.createPost(
        channelId,
        `Got it. Ask someone else to @mention me to create a session for this thread.`,
        threadRootPostId
      );
      log.info(`[SessionOwnership] @${pending.username} declined session creation for thread ${threadRootPostId.substring(0, 8)}`);
      return { confirmed: false, message: "Session creation declined." };
    }

    return { confirmed: false, message: "Invalid response. Reply with yes or no." };
  }

  clearPendingConfirmation(channelId: string, threadRootPostId: string): void {
    const key = this.getKey(channelId, threadRootPostId);
    this.pendingConfirmations.delete(key);
  }

  cleanupExpired(): number {
    let cleaned = 0;
    const now = Date.now();
    
    for (const [key, pending] of this.pendingConfirmations.entries()) {
      if (now - pending.createdAt.getTime() > this.CONFIRMATION_TIMEOUT_MS) {
        this.pendingConfirmations.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}
