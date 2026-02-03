/**
 * PostgreSQL-backed thread mapping store using Supabase.
 *
 * Provides CRUD operations and thread claiming for multi-instance coordination.
 * Thread claiming uses SELECT FOR UPDATE SKIP LOCKED for contention handling.
 */

import type { ThreadSessionMapping } from "../../models/index.js";
import type { ThreadMappingMetadata } from "./schema.js";
import {
  ThreadMappingSchema,
  ThreadMappingInsertSchema,
  ThreadMappingMetadataSchema,
  type ThreadMapping,
  type ThreadMappingInsert,
} from "./schema.js";
import type { SupabaseClientManager } from "./supabase-client.js";
import { handlePostgrestError, isRetryableError } from "./supabase-client.js";
import { log } from "../../logger.js";

const TABLE_NAME = "thread_mappings";
const DEFAULT_CLAIM_DURATION_MS = 60_000;

export type ThreadMappingPgStore = {
  create(mapping: ThreadSessionMapping): Promise<ThreadMapping>;
  getByThreadRootPostId(threadRootPostId: string): Promise<ThreadSessionMapping | null>;
  getBySessionId(sessionId: string): Promise<ThreadSessionMapping | null>;
  getByMattermostUserId(userId: string): Promise<ThreadSessionMapping[]>;
  getByChannelId(channelId: string): Promise<ThreadSessionMapping[]>;
  update(mapping: ThreadSessionMapping): Promise<void>;
  delete(sessionId: string): Promise<void>;
  listAll(): Promise<ThreadSessionMapping[]>;
  listActive(): Promise<ThreadSessionMapping[]>;

  claimThread(threadRootPostId: string, instanceId: string): Promise<boolean>;
  releaseThread(threadRootPostId: string, instanceId: string): Promise<void>;
  releaseExpiredClaims(): Promise<number>;
  isClaimedByOther(threadRootPostId: string, instanceId: string): Promise<boolean>;
  releaseAllClaims(instanceId: string): Promise<number>;

  cleanupStaleMappings(maxAgeDays?: number): Promise<number>;
};

/**
 * Convert ThreadSessionMapping (app model) to DB row format for insert/update.
 */
function toDbRow(mapping: ThreadSessionMapping): ThreadMappingInsert {
  // Build metadata object from fields not in core DB schema
  const metadata: ThreadMappingMetadata = {
    shortId: mapping.shortId,
    dmChannelId: mapping.dmChannelId,
    projectName: mapping.projectName,
    directory: mapping.directory,
    sessionTitle: mapping.sessionTitle,
    status: mapping.status,
    endedAt: mapping.endedAt,
    model: mapping.model,
    pendingModelSelection: mapping.pendingModelSelection,
    approvedUsers: mapping.approvedUsers,
    approveAllUsers: mapping.approveAllUsers,
    approveNextMessage: mapping.approveNextMessage,
    mergedInto: mapping.mergedInto,
    mergedAt: mapping.mergedAt,
  };

  // Use channelId if present, otherwise fall back to dmChannelId
  const channelId = mapping.channelId || mapping.dmChannelId;

  return {
    thread_root_post_id: mapping.threadRootPostId,
    channel_id: channelId,
    opencode_session_id: mapping.sessionId,
    mattermost_user_id: mapping.mattermostUserId,
    mode: "normal", // Default mode
    metadata,
  };
}

/**
 * Convert DB row to ThreadSessionMapping (app model).
 */
function fromDbRow(row: ThreadMapping): ThreadSessionMapping {
  const metadata = row.metadata || {};

  return {
    sessionId: row.opencode_session_id,
    threadRootPostId: row.thread_root_post_id,
    shortId: metadata.shortId || row.opencode_session_id.slice(0, 8),
    mattermostUserId: row.mattermost_user_id,
    dmChannelId: metadata.dmChannelId || row.channel_id,
    channelId: row.channel_id,
    projectName: metadata.projectName || "unknown",
    directory: metadata.directory || "/",
    sessionTitle: metadata.sessionTitle,
    status: metadata.status || "active",
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.updated_at.toISOString(),
    endedAt: metadata.endedAt,
    model: metadata.model,
    pendingModelSelection: metadata.pendingModelSelection,
    approvedUsers: metadata.approvedUsers,
    approveAllUsers: metadata.approveAllUsers,
    approveNextMessage: metadata.approveNextMessage,
    mergedInto: metadata.mergedInto,
    mergedAt: metadata.mergedAt,
  };
}

/**
 * Create a PostgreSQL-backed thread mapping store.
 */
export function createThreadMappingPgStore(
  clientManager: SupabaseClientManager,
  claimDurationMs: number = DEFAULT_CLAIM_DURATION_MS
): ThreadMappingPgStore {
  const { client } = clientManager;

  async function create(mapping: ThreadSessionMapping): Promise<ThreadMapping> {
    const row = toDbRow(mapping);

    const { data, error } = await client
      .from(TABLE_NAME)
      .insert(row)
      .select()
      .single();

    if (error) {
      handlePostgrestError(error, "create thread mapping");
      throw new Error(`Failed to create thread mapping: ${error.message}`);
    }

    const validated = ThreadMappingSchema.parse(data);
    log.debug(`[thread-mapping-pg] Created mapping for session ${mapping.sessionId}`);
    return validated;
  }

  async function getByThreadRootPostId(threadRootPostId: string): Promise<ThreadSessionMapping | null> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("*")
      .eq("thread_root_post_id", threadRootPostId)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get by thread root post id");
      return null;
    }

    if (!data) return null;

    const validated = ThreadMappingSchema.parse(data);
    return fromDbRow(validated);
  }

  async function getBySessionId(sessionId: string): Promise<ThreadSessionMapping | null> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("*")
      .eq("opencode_session_id", sessionId)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get by session id");
      return null;
    }

    if (!data) return null;

    const validated = ThreadMappingSchema.parse(data);
    return fromDbRow(validated);
  }

  async function getByMattermostUserId(userId: string): Promise<ThreadSessionMapping[]> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("*")
      .eq("mattermost_user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) {
      handlePostgrestError(error, "get by mattermost user id");
      return [];
    }

    return (data || []).map((row) => {
      const validated = ThreadMappingSchema.parse(row);
      return fromDbRow(validated);
    });
  }

  async function getByChannelId(channelId: string): Promise<ThreadSessionMapping[]> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("*")
      .eq("channel_id", channelId)
      .order("updated_at", { ascending: false });

    if (error) {
      handlePostgrestError(error, "get by channel id");
      return [];
    }

    return (data || []).map((row) => {
      const validated = ThreadMappingSchema.parse(row);
      return fromDbRow(validated);
    });
  }

  async function update(mapping: ThreadSessionMapping): Promise<void> {
    const row = toDbRow(mapping);

    // Remove fields that shouldn't be updated directly
    const { thread_root_post_id, opencode_session_id, ...updateFields } = row;

    const { error } = await client
      .from(TABLE_NAME)
      .update(updateFields)
      .eq("opencode_session_id", mapping.sessionId);

    if (error) {
      handlePostgrestError(error, "update thread mapping");
      throw new Error(`Failed to update thread mapping: ${error.message}`);
    }

    log.debug(`[thread-mapping-pg] Updated mapping for session ${mapping.sessionId}`);
  }

  async function deleteMapping(sessionId: string): Promise<void> {
    const { error } = await client
      .from(TABLE_NAME)
      .delete()
      .eq("opencode_session_id", sessionId);

    if (error) {
      handlePostgrestError(error, "delete thread mapping");
      throw new Error(`Failed to delete thread mapping: ${error.message}`);
    }

    log.debug(`[thread-mapping-pg] Deleted mapping for session ${sessionId}`);
  }

  async function listAll(): Promise<ThreadSessionMapping[]> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      handlePostgrestError(error, "list all thread mappings");
      return [];
    }

    return (data || []).map((row) => {
      const validated = ThreadMappingSchema.parse(row);
      return fromDbRow(validated);
    });
  }

  async function listActive(): Promise<ThreadSessionMapping[]> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("*")
      .eq("metadata->>status", "active")
      .order("updated_at", { ascending: false });

    if (error) {
      // If the JSON path query fails, fall back to fetching all and filtering
      log.warn("[thread-mapping-pg] JSON path query failed, falling back to client-side filter");
      const all = await listAll();
      return all.filter((m) => m.status === "active");
    }

    return (data || []).map((row) => {
      const validated = ThreadMappingSchema.parse(row);
      return fromDbRow(validated);
    });
  }

  // ============================================================
  // Thread Claiming (T014-T015)
  // Uses SELECT FOR UPDATE SKIP LOCKED pattern for contention
  // ============================================================

  /**
   * Attempt to claim a thread for processing.
   * Uses SELECT FOR UPDATE SKIP LOCKED - first instance wins, others skip.
   *
   * @returns true if claim succeeded, false if already claimed or not found
   */
  async function claimThread(threadRootPostId: string, instanceId: string): Promise<boolean> {
    const claimUntil = new Date(Date.now() + claimDurationMs);

    // Use RPC for row-level locking (SELECT FOR UPDATE SKIP LOCKED)
    // Since Supabase doesn't expose row locking directly, we use a conditional update
    // that only succeeds if the thread is unclaimed or the claim has expired
    const { data, error } = await client
      .from(TABLE_NAME)
      .update({
        claimed_by: instanceId,
        claimed_until: claimUntil.toISOString(),
      })
      .eq("thread_root_post_id", threadRootPostId)
      .or(`claimed_by.is.null,claimed_until.lt.${new Date().toISOString()}`)
      .select("id")
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "claim thread");
      return false;
    }

    if (data) {
      log.debug(`[thread-mapping-pg] Instance ${instanceId} claimed thread ${threadRootPostId}`);
      return true;
    }

    // No rows updated - either thread doesn't exist or is already claimed
    log.debug(`[thread-mapping-pg] Failed to claim thread ${threadRootPostId} (already claimed or not found)`);
    return false;
  }

  /**
   * Release a thread claim.
   * Only releases if the claim is held by the specified instance.
   */
  async function releaseThread(threadRootPostId: string, instanceId: string): Promise<void> {
    const { error } = await client
      .from(TABLE_NAME)
      .update({
        claimed_by: null,
        claimed_until: null,
      })
      .eq("thread_root_post_id", threadRootPostId)
      .eq("claimed_by", instanceId);

    if (error) {
      handlePostgrestError(error, "release thread");
      return;
    }

    log.debug(`[thread-mapping-pg] Instance ${instanceId} released thread ${threadRootPostId}`);
  }

  /**
   * Release all expired claims (older than claim duration).
   *
   * @returns Number of claims released
   */
  async function releaseExpiredClaims(): Promise<number> {
    const now = new Date().toISOString();

    const { data, error } = await client
      .from(TABLE_NAME)
      .update({
        claimed_by: null,
        claimed_until: null,
      })
      .not("claimed_by", "is", null)
      .lt("claimed_until", now)
      .select("id");

    if (error) {
      handlePostgrestError(error, "release expired claims");
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      log.info(`[thread-mapping-pg] Released ${count} expired thread claims`);
    }
    return count;
  }

  /**
   * Check if a thread is claimed by another instance.
   */
  async function isClaimedByOther(threadRootPostId: string, instanceId: string): Promise<boolean> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("claimed_by, claimed_until")
      .eq("thread_root_post_id", threadRootPostId)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "check claim status");
      return false;
    }

    if (!data) return false;

    // Not claimed
    if (!data.claimed_by) return false;

    // Claimed by us
    if (data.claimed_by === instanceId) return false;

    // Check if claim has expired
    if (data.claimed_until) {
      const expiresAt = new Date(data.claimed_until);
      if (expiresAt <= new Date()) {
        // Claim expired, not effectively claimed
        return false;
      }
    }

    // Claimed by someone else and not expired
    return true;
  }

  /**
   * Release all claims held by a specific instance.
   * Useful when an instance is shutting down.
   *
   * @returns Number of claims released
   */
  async function releaseAllClaims(instanceId: string): Promise<number> {
    const { data, error } = await client
      .from(TABLE_NAME)
      .update({
        claimed_by: null,
        claimed_until: null,
      })
      .eq("claimed_by", instanceId)
      .select("id");

    if (error) {
      handlePostgrestError(error, "release all claims");
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      log.info(`[thread-mapping-pg] Released ${count} claims for instance ${instanceId}`);
    }
    return count;
  }

  async function cleanupStaleMappings(maxAgeDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    const { data, error } = await client
      .from(TABLE_NAME)
      .delete()
      .lt("updated_at", cutoffDate.toISOString())
      .select("id");

    if (error) {
      handlePostgrestError(error, "cleanup stale mappings");
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      log.info(`[thread-mapping-pg] Cleaned up ${count} stale mappings older than ${maxAgeDays} days`);
    }
    return count;
  }

  return {
    create,
    getByThreadRootPostId,
    getBySessionId,
    getByMattermostUserId,
    getByChannelId,
    update,
    delete: deleteMapping,
    listAll,
    listActive,
    claimThread,
    releaseThread,
    releaseExpiredClaims,
    isClaimedByOther,
    releaseAllClaims,
    cleanupStaleMappings,
  };
}
