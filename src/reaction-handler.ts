import type { SessionManager, UserSession } from "./session-manager.js";
import type { NotificationService } from "./notification-service.js";
import type { WebSocketEvent } from "./models/index.js";
import { log } from "./logger.js";

export type ReactionAction = "approve" | "deny" | "cancel" | "retry" | "clear";

const REACTION_MAP: Record<string, ReactionAction> = {
  white_check_mark: "approve",
  heavy_check_mark: "approve",
  x: "deny",
  octagonal_sign: "cancel",
  stop_sign: "cancel",
  arrows_counterclockwise: "retry",
  repeat: "retry",
  wastebasket: "clear",
  trash: "clear",
};

export interface ReactionHandlerCallbacks {
  onApprove?: (session: UserSession) => Promise<void>;
  onDeny?: (session: UserSession) => Promise<void>;
  onCancel?: (session: UserSession) => Promise<void>;
  onRetry?: (session: UserSession) => Promise<void>;
  onClear?: (session: UserSession) => Promise<void>;
}

export class ReactionHandler {
  private sessionManager: SessionManager;
  private notifications: NotificationService;
  private callbacks: ReactionHandlerCallbacks;
  private botUserId: string | null = null;

  constructor(
    sessionManager: SessionManager,
    notifications: NotificationService,
    callbacks: ReactionHandlerCallbacks = {}
  ) {
    this.sessionManager = sessionManager;
    this.notifications = notifications;
    this.callbacks = callbacks;
  }

  setBotUserId(botUserId: string): void {
    this.botUserId = botUserId;
  }

  async handleReaction(event: WebSocketEvent): Promise<void> {
    const reactionData = event.data?.reaction;
    if (!reactionData) return;

    const { user_id: userId, emoji_name: emojiName, post_id: postId } = reactionData;

    if (userId === this.botUserId) return;

    const action = REACTION_MAP[emojiName];
    if (!action) return;

    const session = this.sessionManager.getSession(userId);
    if (!session) {
      log.warn(`[ReactionHandler] No session found for user ${userId}`);
      return;
    }

    log.debug(`[ReactionHandler] Processing ${action} reaction from ${session.mattermostUsername}`);

    try {
      switch (action) {
        case "approve":
          if (session.pendingPermission && this.callbacks.onApprove) {
            await this.callbacks.onApprove(session);
            session.pendingPermission = null;
          }
          break;

        case "deny":
          if (session.pendingPermission && this.callbacks.onDeny) {
            await this.callbacks.onDeny(session);
            session.pendingPermission = null;
          }
          break;

        case "cancel":
          if (session.isProcessing && this.callbacks.onCancel) {
            await this.callbacks.onCancel(session);
          }
          break;

        case "retry":
          if (session.lastPrompt && this.callbacks.onRetry) {
            await this.callbacks.onRetry(session);
          }
          break;

        case "clear":
          if (this.callbacks.onClear) {
            await this.callbacks.onClear(session);
          }
          this.sessionManager.destroySession(userId);
          await this.notifications.notifyStatus(session, {
            type: "idle",
            details: "Session cleared",
          });
          break;
      }
    } catch (error) {
      log.error(`[ReactionHandler] Error handling ${action}:`, error);
      await this.notifications.notifyError(session, error as Error);
    }
  }
}
