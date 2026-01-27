import { log } from "./logger.js";
import type { Post } from "./models/index.js";

export type ConfirmationStep = "confirm_create" | "select_approval";

export type ApprovalPolicy = "none" | "approve_next" | "approve_all";

export interface PendingOwnershipConfirmation {
  requestPostId: string;
  userId: string;
  username: string;
  originalPost: Post;
  threadRootPostId: string;
  channelId: string;
  createdAt: Date;
  step: ConfirmationStep;
}

export interface ExistingSessionOwner {
  username: string;
  found: boolean;
}

export class SessionOwnershipHandler {
  private mmClient: any;
  private botUserId: string | null = null;
  private pendingConfirmations: Map<string, PendingOwnershipConfirmation> = new Map();
  private readonly CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(mmClient: any) {
    this.mmClient = mmClient;
  }

  setBotUserId(botUserId: string): void {
    this.botUserId = botUserId;
  }

  private getKey(channelId: string, threadRootPostId: string): string {
    return `${channelId}:${threadRootPostId}`;
  }

  async checkExistingSessionOwner(
    threadRootPostId: string,
    currentUsername: string
  ): Promise<ExistingSessionOwner> {
    try {
      const thread = await this.mmClient.getPostThread(threadRootPostId);
      if (!thread || !thread.posts) {
        return { found: false, username: "" };
      }

      const posts = Object.values(thread.posts) as Post[];
      const SESSION_ANNOUNCEMENT_MARKER = "OpenCode Session Started";
      const OWNER_FIELD_MARKER = "**Owner**:";
      const OWNER_PATTERN = /\*\*Owner\*\*:\s*@(\w+)/;
      
      for (const post of posts) {
        const isBotMessage = this.botUserId && post.user_id === this.botUserId;
        if (!isBotMessage) continue;
        
        const message = post.message || "";
        const isSessionAnnouncement = message.includes(SESSION_ANNOUNCEMENT_MARKER) && message.includes(OWNER_FIELD_MARKER);
        if (!isSessionAnnouncement) continue;

        const ownerMatch = message.match(OWNER_PATTERN);
        if (ownerMatch) {
          const existingOwner = ownerMatch[1];
          if (existingOwner.toLowerCase() !== currentUsername.toLowerCase()) {
            log.info(`[SessionOwnership] Found existing session owner @${existingOwner} (current user: @${currentUsername})`);
            return { found: true, username: existingOwner };
          }
        }
      }
      
      return { found: false, username: "" };
    } catch (error) {
      log.warn(`[SessionOwnership] Failed to check existing session owner: ${error}`);
      return { found: false, username: "" };
    }
  }

  async requestOwnershipConfirmation(
    post: Post,
    username: string,
    threadRootPostId: string,
    channelId: string
  ): Promise<string | null> {
    const key = this.getKey(channelId, threadRootPostId);
    
    const existingOwner = await this.checkExistingSessionOwner(threadRootPostId, username);
    if (existingOwner.found) {
      log.info(`[SessionOwnership] Skipping ownership confirmation - thread already owned by @${existingOwner.username}`);
      return null;
    }

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
      step: "confirm_create",
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
  ): Promise<{ confirmed: boolean; post?: Post; message: string; approvalPolicy?: ApprovalPolicy }> {
    const key = this.getKey(channelId, threadRootPostId);
    const pending = this.pendingConfirmations.get(key);
    if (!pending) {
      return { confirmed: false, message: "No pending confirmation request found." };
    }

    const trimmed = replyText.trim().toLowerCase();

    // Step 1: Confirm session creation
    if (pending.step === "confirm_create") {
      if (trimmed === "yes" || trimmed === "y") {
        // Transition to step 2: ask about pre-approving users
        pending.step = "select_approval";
        pending.createdAt = new Date(); // Reset timeout
        this.pendingConfirmations.set(key, pending);

        const approvalMessage = `Great! **Do you want to pre-approve other people to use this session?**

\`1\` - No pre-approval (only you can use this session initially)
\`2\` - Pre-approve the next message (one-time approval for the next person)
\`3\` - Approve all subsequent messages (anyone can send prompts)

_Reply with a number (1, 2, or 3)_`;

        await this.mmClient.createPost(
          channelId,
          approvalMessage,
          threadRootPostId
        );
        log.info(`[SessionOwnership] @${pending.username} confirmed session creation, now asking for approval policy`);
        return { confirmed: false, message: "Waiting for approval policy selection." };
      }

      if (trimmed === "no" || trimmed === "n") {
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

    // Step 2: Select approval policy
    if (pending.step === "select_approval") {
      let approvalPolicy: ApprovalPolicy;

      if (trimmed === "1") {
        approvalPolicy = "none";
        log.info(`[SessionOwnership] @${pending.username} selected approval policy: none`);
      } else if (trimmed === "2") {
        approvalPolicy = "approve_next";
        log.info(`[SessionOwnership] @${pending.username} selected approval policy: approve_next`);
      } else if (trimmed === "3") {
        approvalPolicy = "approve_all";
        log.info(`[SessionOwnership] @${pending.username} selected approval policy: approve_all`);
      } else {
        return { confirmed: false, message: "Invalid response. Reply with 1, 2, or 3." };
      }

      this.pendingConfirmations.delete(key);
      log.info(`[SessionOwnership] @${pending.username} confirmed session creation with policy '${approvalPolicy}' for thread ${threadRootPostId.substring(0, 8)}`);
      return { confirmed: true, post: pending.originalPost, message: "Session will be created.", approvalPolicy };
    }

    return { confirmed: false, message: "Invalid state." };
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
