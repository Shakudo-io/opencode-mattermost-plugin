import type { ConversationReference } from "botbuilder";

export type TeamsThreadMode = "normal" | "ended" | "merged";

export type PendingQuestionStatus = "pending" | "answered" | "rejected" | "expired";

export type PendingPermissionStatus = "pending" | "approved" | "denied" | "expired";

export type PendingGuestApprovalStatus =
  | "pending"
  | "approved_once"
  | "approved_permanent"
  | "approved_all"
  | "denied"
  | "expired";

export type PermissionType = "bash" | "file_write" | "file_delete" | "other";

export interface TeamsThreadMapping {
  id: string;
  threadRootMessageId: string;
  conversationId: string;
  openCodeSessionId: string;
  teamsUserId: string;
  conversationReference: ConversationReference;
  mode: TeamsThreadMode;
  metadata: {
    projectName?: string;
    projectDirectory?: string;
    startedAt: string;
    endedAt?: string;
    lastActivityAt: string;
    mergedFrom?: string;
    mergedInto?: string;
  };
  approvedUsers: string[];
  approveAll: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsUserSession {
  teamsUserId: string;
  displayName: string;
  email?: string;
  isAuthorized: boolean;
  lastAuthCheckAt: string;
  activeThreadIds: string[];
  selectedModel?: string;
  firstSeenAt: string;
  lastActivityAt: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface PendingQuestion {
  id: string;
  sessionId: string;
  threadRootMessageId: string;
  questionCardId?: string;
  questionData: {
    header: string;
    question: string;
    options: QuestionOption[];
    multiple: boolean;
  };
  status: PendingQuestionStatus;
  createdAt: string;
  expiresAt: string;
  answeredAt?: string;
  answer?: {
    selectedOptions: string[];
    customAnswer?: string;
  };
}

export interface PendingPermission {
  id: string;
  sessionId: string;
  threadRootMessageId: string;
  permissionCardId?: string;
  permissionData: {
    type: PermissionType;
    command?: string;
    filePath?: string;
    description: string;
  };
  status: PendingPermissionStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface PendingGuestApproval {
  id: string;
  threadRootMessageId: string;
  requesterUserId: string;
  ownerUserId: string;
  originalMessage: string;
  approvalCardId?: string;
  status: PendingGuestApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  prompt: string;
  targetUser?: string;
  lastRunAt?: string;
  lastRunBy?: string;
  nextRunAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function createDefaultTeamsThreadMapping(
  partial: Pick<
    TeamsThreadMapping,
    "threadRootMessageId" | "conversationId" | "openCodeSessionId" | "teamsUserId" | "conversationReference"
  > &
    Partial<TeamsThreadMapping>
): TeamsThreadMapping {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    threadRootMessageId: partial.threadRootMessageId,
    conversationId: partial.conversationId,
    openCodeSessionId: partial.openCodeSessionId,
    teamsUserId: partial.teamsUserId,
    conversationReference: partial.conversationReference,
    mode: partial.mode ?? "normal",
    metadata: {
      startedAt: now,
      lastActivityAt: now,
      ...partial.metadata,
    },
    approvedUsers: partial.approvedUsers ?? [],
    approveAll: partial.approveAll ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultPendingQuestion(
  partial: Pick<PendingQuestion, "sessionId" | "threadRootMessageId" | "questionData"> &
    Partial<PendingQuestion>
): PendingQuestion {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
  return {
    id: crypto.randomUUID(),
    sessionId: partial.sessionId,
    threadRootMessageId: partial.threadRootMessageId,
    questionData: partial.questionData,
    status: partial.status ?? "pending",
    createdAt: now.toISOString(),
    expiresAt: partial.expiresAt ?? expiresAt.toISOString(),
  };
}

export function createDefaultPendingPermission(
  partial: Pick<PendingPermission, "sessionId" | "threadRootMessageId" | "permissionData"> &
    Partial<PendingPermission>
): PendingPermission {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  return {
    id: crypto.randomUUID(),
    sessionId: partial.sessionId,
    threadRootMessageId: partial.threadRootMessageId,
    permissionData: partial.permissionData,
    status: partial.status ?? "pending",
    createdAt: now.toISOString(),
    expiresAt: partial.expiresAt ?? expiresAt.toISOString(),
  };
}

export function createDefaultPendingGuestApproval(
  partial: Pick<
    PendingGuestApproval,
    "threadRootMessageId" | "requesterUserId" | "ownerUserId" | "originalMessage"
  > &
    Partial<PendingGuestApproval>
): PendingGuestApproval {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
  return {
    id: crypto.randomUUID(),
    threadRootMessageId: partial.threadRootMessageId,
    requesterUserId: partial.requesterUserId,
    ownerUserId: partial.ownerUserId,
    originalMessage: partial.originalMessage,
    status: partial.status ?? "pending",
    createdAt: now.toISOString(),
    expiresAt: partial.expiresAt ?? expiresAt.toISOString(),
  };
}
