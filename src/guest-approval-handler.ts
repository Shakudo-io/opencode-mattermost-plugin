import { log } from "./logger.js";
import type { Post } from "./models/index.js";
import type { ThreadMappingStore } from "./persistence/thread-mapping-store.js";

export interface PendingApproval {
  requestPostId: string;
  guestUserId: string;
  guestUsername: string;
  originalPost: Post;
  threadRootPostId: string;
  sessionId: string;
  createdAt: Date;
}

export class GuestApprovalHandler {
  private mmClient: any;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private readonly APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

  constructor(mmClient: any) {
    this.mmClient = mmClient;
  }

  async requestApproval(
    post: Post,
    guestUsername: string,
    threadRootPostId: string,
    sessionId: string,
    channelId: string
  ): Promise<string> {
    const messagePreview = post.message.length > 200 
      ? post.message.substring(0, 200) + "..." 
      : post.message;

    const approvalMessage = `🔔 **Guest Access Request**

@${guestUsername} wants to send a prompt in this session:

> ${messagePreview}

**Reply with a number to respond:**
\`1\` - Approve this message only
\`2\` - Approve all future messages from @${guestUsername} in this thread
\`3\` - Approve all users in this thread

_Reply \`deny\` or \`0\` to reject_`;

    const requestPost = await this.mmClient.createPost(
      channelId,
      approvalMessage,
      threadRootPostId
    );

    const pending: PendingApproval = {
      requestPostId: requestPost.id,
      guestUserId: post.user_id,
      guestUsername,
      originalPost: post,
      threadRootPostId,
      sessionId,
      createdAt: new Date(),
    };

    this.pendingApprovals.set(sessionId, pending);
    log.info(`[GuestApproval] Requested approval for @${guestUsername} in session ${sessionId.substring(0, 8)}`);

    return requestPost.id;
  }

  hasPendingApproval(sessionId: string): boolean {
    const pending = this.pendingApprovals.get(sessionId);
    if (!pending) return false;

    const elapsed = Date.now() - pending.createdAt.getTime();
    if (elapsed > this.APPROVAL_TIMEOUT_MS) {
      this.pendingApprovals.delete(sessionId);
      log.info(`[GuestApproval] Approval request expired for session ${sessionId.substring(0, 8)}`);
      return false;
    }

    return true;
  }

  getPendingApproval(sessionId: string): PendingApproval | undefined {
    if (!this.hasPendingApproval(sessionId)) return undefined;
    return this.pendingApprovals.get(sessionId);
  }

  async handleOwnerReply(
    sessionId: string,
    replyText: string,
    threadMappingStore: ThreadMappingStore,
    channelId: string
  ): Promise<{ approved: boolean; post?: Post; message: string }> {
    const pending = this.pendingApprovals.get(sessionId);
    if (!pending) {
      return { approved: false, message: "No pending approval request found." };
    }

    const trimmed = replyText.trim().toLowerCase();
    const mapping = threadMappingStore.getBySessionId(sessionId);

    if (trimmed === "0" || trimmed === "deny" || trimmed === "no") {
      this.pendingApprovals.delete(sessionId);
      await this.mmClient.createPost(
        channelId,
        `❌ Request from @${pending.guestUsername} was denied.`,
        pending.threadRootPostId
      );
      log.info(`[GuestApproval] Denied request from @${pending.guestUsername} in session ${sessionId.substring(0, 8)}`);
      return { approved: false, message: "Request denied." };
    }

    if (trimmed === "1") {
      this.pendingApprovals.delete(sessionId);
      await this.mmClient.createPost(
        channelId,
        `✅ Approved message from @${pending.guestUsername}.`,
        pending.threadRootPostId
      );
      log.info(`[GuestApproval] Approved single message from @${pending.guestUsername} in session ${sessionId.substring(0, 8)}`);
      return { approved: true, post: pending.originalPost, message: "Message approved." };
    }

    if (trimmed === "2") {
      this.pendingApprovals.delete(sessionId);
      if (mapping) {
        const approvedUsers = mapping.approvedUsers || [];
        if (!approvedUsers.includes(pending.guestUserId)) {
          approvedUsers.push(pending.guestUserId);
        }
        mapping.approvedUsers = approvedUsers;
        threadMappingStore.update(mapping);
      }
      await this.mmClient.createPost(
        channelId,
        `✅ Approved @${pending.guestUsername} for all future messages in this thread.`,
        pending.threadRootPostId
      );
      log.info(`[GuestApproval] Approved @${pending.guestUsername} for all future messages in session ${sessionId.substring(0, 8)}`);
      return { approved: true, post: pending.originalPost, message: "User approved for thread." };
    }

    if (trimmed === "3") {
      this.pendingApprovals.delete(sessionId);
      if (mapping) {
        mapping.approveAllUsers = true;
        threadMappingStore.update(mapping);
      }
      await this.mmClient.createPost(
        channelId,
        `✅ Approved all users for this thread. Anyone can now send prompts here.`,
        pending.threadRootPostId
      );
      log.info(`[GuestApproval] Approved all users for session ${sessionId.substring(0, 8)}`);
      return { approved: true, post: pending.originalPost, message: "All users approved for thread." };
    }

    return { approved: false, message: "Invalid response. Reply with 1, 2, 3, or deny." };
  }

  isUserApproved(
    userId: string,
    mapping: { approvedUsers?: string[]; approveAllUsers?: boolean } | null
  ): boolean {
    if (!mapping) return false;
    if (mapping.approveAllUsers) return true;
    if (mapping.approvedUsers?.includes(userId)) return true;
    return false;
  }

  clearPendingApproval(sessionId: string): void {
    this.pendingApprovals.delete(sessionId);
  }

  cleanupExpired(): number {
    let cleaned = 0;
    const now = Date.now();
    
    for (const [sessionId, pending] of this.pendingApprovals.entries()) {
      if (now - pending.createdAt.getTime() > this.APPROVAL_TIMEOUT_MS) {
        this.pendingApprovals.delete(sessionId);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}
