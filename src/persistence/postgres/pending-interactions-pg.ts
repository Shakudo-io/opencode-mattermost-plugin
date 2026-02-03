/**
 * Postgres Pending Interactions Store
 *
 * Provides CRUD operations for pending questions, approvals, and ownership confirmations.
 * Supports multi-instance deployments with real-time sync and TTL expiration.
 *
 * TTL Values:
 * - Questions: 30 minutes (1800000 ms)
 * - Approvals: 30 minutes (1800000 ms)
 * - Ownership: 5 minutes (300000 ms)
 */

import { log } from "../../logger.js";
import {
  type PendingQuestion,
  type PendingQuestionInsert,
  type PendingApproval,
  type PendingApprovalInsert,
  type PendingOwnership,
  type PendingOwnershipInsert,
  type QuestionData,
  PendingQuestionSchema,
  PendingApprovalSchema,
  PendingOwnershipSchema,
} from "./schema.js";
import { handlePostgrestError, type SupabaseClientManager } from "./supabase-client.js";

const SCHEMA = "opencode_mm_plugin";
const PENDING_QUESTIONS_TABLE = "pending_questions";
const PENDING_APPROVALS_TABLE = "pending_approvals";
const PENDING_OWNERSHIPS_TABLE = "pending_ownerships";

// TTL constants in milliseconds
const QUESTION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const APPROVAL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const OWNERSHIP_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * PostgreSQL Pending Interactions Store Interface
 */
export interface PendingInteractionsPgStore {
  // ========== Pending Questions ==========
  createQuestion(question: PendingQuestionInsert): Promise<PendingQuestion>;
  getQuestion(id: string): Promise<PendingQuestion | null>;
  getQuestionByPostId(postId: string): Promise<PendingQuestion | null>;
  getQuestionBySessionId(sessionId: string): Promise<PendingQuestion | null>;
  answerQuestion(id: string, answer: string): Promise<PendingQuestion | null>;
  expireQuestion(id: string): Promise<boolean>;
  cancelQuestion(id: string): Promise<boolean>;
  listPendingQuestions(): Promise<PendingQuestion[]>;

  // ========== Pending Approvals ==========
  createApproval(approval: PendingApprovalInsert): Promise<PendingApproval>;
  getApproval(id: string): Promise<PendingApproval | null>;
  getApprovalByPostId(postId: string): Promise<PendingApproval | null>;
  getApprovalBySessionId(sessionId: string): Promise<PendingApproval | null>;
  decideApproval(
    id: string,
    status: "approved" | "denied",
    decidedBy: string
  ): Promise<PendingApproval | null>;
  expireApproval(id: string): Promise<boolean>;
  listPendingApprovals(): Promise<PendingApproval[]>;

  // ========== Pending Ownership ==========
  createOwnership(ownership: PendingOwnershipInsert): Promise<PendingOwnership>;
  getOwnership(id: string): Promise<PendingOwnership | null>;
  getOwnershipByPostId(postId: string): Promise<PendingOwnership | null>;
  getOwnershipByThreadId(
    threadRootPostId: string
  ): Promise<PendingOwnership | null>;
  resolveOwnership(
    id: string,
    status: "confirmed" | "rejected"
  ): Promise<PendingOwnership | null>;
  updateOwnershipStep(
    id: string,
    step: "confirm_create" | "select_approval"
  ): Promise<PendingOwnership | null>;
  expireOwnership(id: string): Promise<boolean>;
  listPendingOwnerships(): Promise<PendingOwnership[]>;

  // ========== Cleanup ==========
  expireOldPending(): Promise<{
    questions: number;
    approvals: number;
    ownerships: number;
  }>;
}

/**
 * Create a PostgreSQL pending interactions store instance
 */
export function createPendingInteractionsPgStore(
  clientManager: SupabaseClientManager
): PendingInteractionsPgStore {
  const { client: supabase } = clientManager;

  // ========== Pending Questions ==========

  async function createQuestion(
    question: PendingQuestionInsert
  ): Promise<PendingQuestion> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + QUESTION_TTL_MS);

    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .insert({
        id: question.id,
        thread_root_post_id: question.thread_root_post_id,
        opencode_session_id: question.opencode_session_id,
        question_post_id: question.question_post_id,
        question_data: question.question_data,
        status: question.status ?? "pending",
        answer: question.answer ?? null,
        answered_at: question.answered_at ?? null,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (error) {
      handlePostgrestError(error, "create pending question");
    }

    const result = PendingQuestionSchema.parse(data);
    log.info(
      `[pending-pg] Created pending question: ${result.id} for session ${result.opencode_session_id}`
    );
    return result;
  }

  async function getQuestion(id: string): Promise<PendingQuestion | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending question");
    }

    return data ? PendingQuestionSchema.parse(data) : null;
  }

  async function getQuestionByPostId(
    postId: string
  ): Promise<PendingQuestion | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .select("*")
      .eq("question_post_id", postId)
      .eq("status", "pending")
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending question by post id");
    }

    return data ? PendingQuestionSchema.parse(data) : null;
  }

  async function getQuestionBySessionId(
    sessionId: string
  ): Promise<PendingQuestion | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .select("*")
      .eq("opencode_session_id", sessionId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending question by session id");
    }

    return data ? PendingQuestionSchema.parse(data) : null;
  }

  async function answerQuestion(
    id: string,
    answer: string
  ): Promise<PendingQuestion | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .update({
        status: "answered",
        answer,
        answered_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "pending")
      .select()
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "answer pending question");
    }

    if (data) {
      log.info(`[pending-pg] Answered question id=${id}`);
      return PendingQuestionSchema.parse(data);
    }

    return null;
  }

  async function expireQuestion(id: string): Promise<boolean> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .update({ status: "expired" })
      .eq("id", id)
      .eq("status", "pending");

    if (error) {
      handlePostgrestError(error, "expire pending question");
    }

    if (count && count > 0) {
      log.info(`[pending-pg] Expired question id=${id}`);
      return true;
    }

    return false;
  }

  async function cancelQuestion(id: string): Promise<boolean> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .update({ status: "expired" })
      .eq("id", id)
      .eq("status", "pending");

    if (error) {
      handlePostgrestError(error, "cancel pending question");
    }

    if (count && count > 0) {
      log.info(`[pending-pg] Cancelled question id=${id}`);
      return true;
    }

    return false;
  }

  async function listPendingQuestions(): Promise<PendingQuestion[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_QUESTIONS_TABLE)
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list pending questions");
    }

    return (data || []).map((row) => PendingQuestionSchema.parse(row));
  }

  // ========== Pending Approvals ==========

  async function createApproval(
    approval: PendingApprovalInsert
  ): Promise<PendingApproval> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);

    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_APPROVALS_TABLE)
      .insert({
        id: approval.id,
        guest_user_id: approval.guest_user_id,
        guest_username: approval.guest_username ?? null,
        approval_post_id: approval.approval_post_id,
        channel_id: approval.channel_id,
        session_id: approval.session_id,
        thread_root_post_id: approval.thread_root_post_id,
        original_message: approval.original_message ?? null,
        status: approval.status ?? "pending",
        decided_by: approval.decided_by ?? null,
        decided_at: approval.decided_at ?? null,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (error) {
      handlePostgrestError(error, "create pending approval");
    }

    const result = PendingApprovalSchema.parse(data);
    log.info(
      `[pending-pg] Created pending approval: ${result.id} for guest @${result.guest_username || result.guest_user_id}`
    );
    return result;
  }

  async function getApproval(id: string): Promise<PendingApproval | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_APPROVALS_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending approval");
    }

    return data ? PendingApprovalSchema.parse(data) : null;
  }

  async function getApprovalByPostId(
    postId: string
  ): Promise<PendingApproval | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_APPROVALS_TABLE)
      .select("*")
      .eq("approval_post_id", postId)
      .eq("status", "pending")
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending approval by post id");
    }

    return data ? PendingApprovalSchema.parse(data) : null;
  }

  async function getApprovalBySessionId(
    sessionId: string
  ): Promise<PendingApproval | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_APPROVALS_TABLE)
      .select("*")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending approval by session id");
    }

    return data ? PendingApprovalSchema.parse(data) : null;
  }

  async function decideApproval(
    id: string,
    status: "approved" | "denied",
    decidedBy: string
  ): Promise<PendingApproval | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_APPROVALS_TABLE)
      .update({
        status,
        decided_by: decidedBy,
        decided_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "pending")
      .select()
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "decide pending approval");
    }

    if (data) {
      log.info(`[pending-pg] Decided approval id=${id} as ${status}`);
      return PendingApprovalSchema.parse(data);
    }

    return null;
  }

  async function expireApproval(id: string): Promise<boolean> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(PENDING_APPROVALS_TABLE)
      .update({ status: "expired" })
      .eq("id", id)
      .eq("status", "pending");

    if (error) {
      handlePostgrestError(error, "expire pending approval");
    }

    if (count && count > 0) {
      log.info(`[pending-pg] Expired approval id=${id}`);
      return true;
    }

    return false;
  }

  async function listPendingApprovals(): Promise<PendingApproval[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_APPROVALS_TABLE)
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list pending approvals");
    }

    return (data || []).map((row) => PendingApprovalSchema.parse(row));
  }

  // ========== Pending Ownership ==========

  async function createOwnership(
    ownership: PendingOwnershipInsert
  ): Promise<PendingOwnership> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OWNERSHIP_TTL_MS);

    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .insert({
        id: ownership.id,
        thread_root_post_id: ownership.thread_root_post_id,
        claiming_user_id: ownership.claiming_user_id,
        current_owner_id: ownership.current_owner_id,
        confirmation_post_id: ownership.confirmation_post_id,
        channel_id: ownership.channel_id,
        step: ownership.step,
        status: ownership.status ?? "pending",
        resolved_at: ownership.resolved_at ?? null,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (error) {
      handlePostgrestError(error, "create pending ownership");
    }

    const result = PendingOwnershipSchema.parse(data);
    log.info(
      `[pending-pg] Created pending ownership: ${result.id} for thread ${result.thread_root_post_id}`
    );
    return result;
  }

  async function getOwnership(id: string): Promise<PendingOwnership | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending ownership");
    }

    return data ? PendingOwnershipSchema.parse(data) : null;
  }

  async function getOwnershipByPostId(
    postId: string
  ): Promise<PendingOwnership | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .select("*")
      .eq("confirmation_post_id", postId)
      .eq("status", "pending")
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending ownership by post id");
    }

    return data ? PendingOwnershipSchema.parse(data) : null;
  }

  async function getOwnershipByThreadId(
    threadRootPostId: string
  ): Promise<PendingOwnership | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .select("*")
      .eq("thread_root_post_id", threadRootPostId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get pending ownership by thread id");
    }

    return data ? PendingOwnershipSchema.parse(data) : null;
  }

  async function resolveOwnership(
    id: string,
    status: "confirmed" | "rejected"
  ): Promise<PendingOwnership | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .update({
        status,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "pending")
      .select()
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "resolve pending ownership");
    }

    if (data) {
      log.info(`[pending-pg] Resolved ownership id=${id} as ${status}`);
      return PendingOwnershipSchema.parse(data);
    }

    return null;
  }

  async function updateOwnershipStep(
    id: string,
    step: "confirm_create" | "select_approval"
  ): Promise<PendingOwnership | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .update({ step })
      .eq("id", id)
      .eq("status", "pending")
      .select()
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "update ownership step");
    }

    if (data) {
      log.info(`[pending-pg] Updated ownership id=${id} step to ${step}`);
      return PendingOwnershipSchema.parse(data);
    }

    return null;
  }

  async function expireOwnership(id: string): Promise<boolean> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .update({ status: "expired" })
      .eq("id", id)
      .eq("status", "pending");

    if (error) {
      handlePostgrestError(error, "expire pending ownership");
    }

    if (count && count > 0) {
      log.info(`[pending-pg] Expired ownership id=${id}`);
      return true;
    }

    return false;
  }

  async function listPendingOwnerships(): Promise<PendingOwnership[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(PENDING_OWNERSHIPS_TABLE)
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list pending ownerships");
    }

    return (data || []).map((row) => PendingOwnershipSchema.parse(row));
  }

  // ========== Cleanup ==========

  async function expireOldPending(): Promise<{
    questions: number;
    approvals: number;
    ownerships: number;
  }> {
    const now = new Date();
    let questions = 0;
    let approvals = 0;
    let ownerships = 0;

    // Expire old questions (past expires_at timestamp)
    try {
      const { count, error } = await supabase
        .schema(SCHEMA)
        .from(PENDING_QUESTIONS_TABLE)
        .update({ status: "expired" })
        .eq("status", "pending")
        .lt("expires_at", now.toISOString());

      if (error) {
        log.error("[pending-pg] Error expiring old questions:", error);
      } else {
        questions = count || 0;
      }
    } catch (e) {
      log.error("[pending-pg] Exception expiring old questions:", e);
    }

    // Expire old approvals (past expires_at timestamp)
    try {
      const { count, error } = await supabase
        .schema(SCHEMA)
        .from(PENDING_APPROVALS_TABLE)
        .update({ status: "expired" })
        .eq("status", "pending")
        .lt("expires_at", now.toISOString());

      if (error) {
        log.error("[pending-pg] Error expiring old approvals:", error);
      } else {
        approvals = count || 0;
      }
    } catch (e) {
      log.error("[pending-pg] Exception expiring old approvals:", e);
    }

    // Expire old ownerships (past expires_at timestamp)
    try {
      const { count, error } = await supabase
        .schema(SCHEMA)
        .from(PENDING_OWNERSHIPS_TABLE)
        .update({ status: "expired" })
        .eq("status", "pending")
        .lt("expires_at", now.toISOString());

      if (error) {
        log.error("[pending-pg] Error expiring old ownerships:", error);
      } else {
        ownerships = count || 0;
      }
    } catch (e) {
      log.error("[pending-pg] Exception expiring old ownerships:", e);
    }

    if (questions > 0 || approvals > 0 || ownerships > 0) {
      log.info(
        `[pending-pg] Expired old pending: questions=${questions}, approvals=${approvals}, ownerships=${ownerships}`
      );
    }

    return { questions, approvals, ownerships };
  }

  return {
    // Questions
    createQuestion,
    getQuestion,
    getQuestionByPostId,
    getQuestionBySessionId,
    answerQuestion,
    expireQuestion,
    cancelQuestion,
    listPendingQuestions,

    // Approvals
    createApproval,
    getApproval,
    getApprovalByPostId,
    getApprovalBySessionId,
    decideApproval,
    expireApproval,
    listPendingApprovals,

    // Ownerships
    createOwnership,
    getOwnership,
    getOwnershipByPostId,
    getOwnershipByThreadId,
    resolveOwnership,
    updateOwnershipStep,
    expireOwnership,
    listPendingOwnerships,

    // Cleanup
    expireOldPending,
  };
}
