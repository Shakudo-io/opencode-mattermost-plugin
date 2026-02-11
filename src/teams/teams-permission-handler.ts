/**
 * Teams Permission Handler
 *
 * Manages pending permission requests with Approve/Deny buttons.
 * Handles permission lifecycle: creation, approval, denial, expiration, and cleanup.
 */

import { TurnContext, MessageFactory } from "botbuilder";
import type { TeamsConfig } from "./teams-config.js";
import { teamsLog } from "./teams-logger.js";
import type {
  PendingPermission,
  PendingPermissionStatus,
  PermissionType,
} from "../models/teams-types.js";
import { createDefaultPendingPermission } from "../models/teams-types.js";
import {
  createPermissionCard,
  createPermissionApprovedCard,
  createPermissionDeniedCard,
  createPermissionExpiredCard,
} from "./cards/permission-card.js";

export interface TeamsPermissionHandlerOptions {
  config: TeamsConfig;
  expirationMs?: number;
}

export class TeamsPermissionHandler {
  private readonly config: TeamsConfig;
  private readonly expirationMs: number;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly sessionToPermission = new Map<string, string>();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly log = teamsLog.withContext("TeamsPermissionHandler");

  constructor(options: TeamsPermissionHandlerOptions) {
    this.config = options.config;
    this.expirationMs = options.expirationMs ?? this.config.bot.permissionExpirationMs;

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 30000);
    this.log.info("Permission cleanup timer started intervalMs=30000");
  }

  async handlePermissionRequested(
    context: TurnContext,
    permissionData: {
      id: string;
      sessionId: string;
      type: PermissionType;
      command?: string;
      filePath?: string;
      description: string;
    }
  ): Promise<PendingPermission> {
    this.log.info(
      `Permission requested sessionId=${permissionData.sessionId} type=${permissionData.type} commandLength=${permissionData.command?.length ?? 0} filePath=${permissionData.filePath} descriptionLength=${permissionData.description.length}`
    );

    const threadRootMessageId = this.getRequiredThreadRootMessageId(
      context,
      "permission requested"
    );

    this.log.info(
      `Permission requested: ${permissionData.type} for session ${permissionData.sessionId}`
    );

    const pending = createDefaultPendingPermission({
      id: permissionData.id,
      sessionId: permissionData.sessionId,
      threadRootMessageId,
      permissionData: {
        type: permissionData.type,
        command: permissionData.command,
        filePath: permissionData.filePath,
        description: permissionData.description,
      },
    });

    const card = createPermissionCard({
      permissionId: pending.id,
      sessionId: pending.sessionId,
      type: permissionData.type,
      command: permissionData.command,
      filePath: permissionData.filePath,
      description: permissionData.description,
    });

    await context.sendActivity({ attachments: [card] });

    this.pendingPermissions.set(pending.id, pending);
    this.sessionToPermission.set(pending.sessionId, pending.id);

    return pending;
  }

  async handleCardAction(
    context: TurnContext,
    actionData: Record<string, unknown>
  ): Promise<
    | { approved: true; permissionId: string; sessionId: string }
    | { denied: true; permissionId: string; sessionId: string }
    | { error: string }
  > {
    const verb = actionData.verb as string;
    const permissionId = actionData.permissionId as string;
    const userId = context.activity.from?.id;
    if (!userId) {
      this.log.error("Missing Teams userId while handling permission card action");
      throw new Error("Missing Teams userId while handling permission card action");
    }

    this.log.info(
      `Permission card action entry verb=${verb} userId=${userId} permissionId=${permissionId}`
    );

    if (verb !== "approve_permission" && verb !== "deny_permission") {
      return { error: "unknown_verb" };
    }

    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      this.log.warn(`Permission not found: ${permissionId}`);
      await context.sendActivity(
        MessageFactory.text("Permission request not found or already resolved.")
      );
      return { error: "not_found" };
    }

    const now = new Date();
    const expiresAt = new Date(pending.expiresAt);
    if (now > expiresAt) {
      const ageMs = now.getTime() - new Date(pending.createdAt).getTime();
      this.log.warn(`Permission expired permissionId=${permissionId} ageMs=${ageMs}`);
      const card = createPermissionExpiredCard(pending.permissionData.description);
      await context.sendActivity({ attachments: [card] });
      this.pendingPermissions.delete(permissionId);
      this.sessionToPermission.delete(pending.sessionId);
      return { error: "expired" };
    }

    if (verb === "approve_permission") {
      pending.status = "approved";
      pending.resolvedAt = now.toISOString();
      pending.resolvedBy = userId;

      const toolName = pending.permissionData.command ?? pending.permissionData.type;
      this.log.info(
        `Permission approved permissionId=${permissionId} userId=${userId} tool=${toolName}`
      );

      const card = createPermissionApprovedCard(pending.permissionData.description);
      await context.sendActivity({ attachments: [card] });

      this.pendingPermissions.delete(permissionId);
      this.sessionToPermission.delete(pending.sessionId);

      return {
        approved: true,
        permissionId: pending.id,
        sessionId: pending.sessionId,
      };
    } else {
      pending.status = "denied";
      pending.resolvedAt = now.toISOString();
      pending.resolvedBy = userId;

      const toolName = pending.permissionData.command ?? pending.permissionData.type;
      this.log.info(
        `Permission denied permissionId=${permissionId} userId=${userId} tool=${toolName}`
      );

      const card = createPermissionDeniedCard(pending.permissionData.description);
      await context.sendActivity({ attachments: [card] });

      this.pendingPermissions.delete(permissionId);
      this.sessionToPermission.delete(pending.sessionId);

      return {
        denied: true,
        permissionId: pending.id,
        sessionId: pending.sessionId,
      };
    }
  }

  hasPendingPermission(sessionId: string): boolean {
    const permissionId = this.sessionToPermission.get(sessionId);
    return permissionId !== undefined && this.pendingPermissions.has(permissionId);
  }

  getPendingPermission(sessionId: string): PendingPermission | undefined {
    const permissionId = this.sessionToPermission.get(sessionId);
    if (!permissionId) return undefined;
    return this.pendingPermissions.get(permissionId);
  }

  cancelPermission(permissionId: string): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (pending) {
      this.log.info(`Permission cancelled: ${permissionId}`);
      this.pendingPermissions.delete(permissionId);
      this.sessionToPermission.delete(pending.sessionId);
    }
  }

  cancelSessionPermissions(sessionId: string): void {
    const permissionId = this.sessionToPermission.get(sessionId);
    if (permissionId) {
      this.log.info(`Cancelling session permissions for: ${sessionId}`);
      this.cancelPermission(permissionId);
    }
  }

  cleanupExpired(): number {
    const now = new Date();
    let expiredCount = 0;

    this.log.debug(
      `Permission cleanup timer fired pendingCount=${this.pendingPermissions.size}`
    );

    for (const [permissionId, pending] of this.pendingPermissions.entries()) {
      const expiresAt = new Date(pending.expiresAt);
      if (now > expiresAt) {
        this.log.info(`Cleaning up expired permission: ${permissionId}`);
        pending.status = "expired";
        this.pendingPermissions.delete(permissionId);
        this.sessionToPermission.delete(pending.sessionId);
        expiredCount++;
      }
    }

    this.log.info(`Permission cleanup complete expiredCount=${expiredCount}`);

    return expiredCount;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      this.log.info("Permission cleanup timer stopped");
    }
    this.pendingPermissions.clear();
    this.sessionToPermission.clear();
    this.log.info("Permission handler destroyed");
  }

  private getRequiredThreadRootMessageId(context: TurnContext, purpose: string): string {
    const threadRootMessageId = context.activity.replyToId ?? context.activity.id;
    if (!threadRootMessageId) {
      this.log.error(`Missing thread root message id purpose=${purpose}`);
      throw new Error(`Missing thread root message id (${purpose})`);
    }
    return threadRootMessageId;
  }
}

export function createTeamsPermissionHandler(config: TeamsConfig): TeamsPermissionHandler {
  return new TeamsPermissionHandler({ config });
}
