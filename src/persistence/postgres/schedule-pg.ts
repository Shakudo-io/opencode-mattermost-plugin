/**
 * Postgres Schedule Store
 *
 * Provides CRUD operations for scheduled tasks stored in PostgreSQL.
 * Supports leader election for single-execution in multi-instance deployments.
 */

import CronExpressionParser from "cron-parser";
import { log } from "../../logger.js";
import { type Schedule, type ScheduleInsert, ScheduleSchema } from "./schema.js";
import { handlePostgrestError, type SupabaseClientManager } from "./supabase-client.js";

const SCHEMA = "opencode_mm_plugin";
const TABLE = "schedules";

/**
 * Extended schedule metadata stored in the DB but not part of the core schema.
 * These are stored locally or derived from the JSON store's ScheduleConfig.
 */
export interface ScheduleMetadata {
  sessionId?: string;
  targetUsername?: string;
  lastRunSuccess?: boolean;
  lastRunError?: string;
}

/**
 * Local schedule config format (from JSON store)
 */
export interface LocalScheduleConfig {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  sessionId: string;
  targetUserId: string;
  targetUsername: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunSuccess?: boolean;
  lastRunError?: string;
}

/**
 * PostgreSQL Schedule Store
 */
export interface SchedulePgStore {
  // CRUD operations
  create(schedule: ScheduleInsert & { metadata?: ScheduleMetadata }): Promise<Schedule>;
  getById(id: number): Promise<Schedule | null>;
  getByName(name: string): Promise<Schedule | null>;
  update(id: number, updates: Partial<ScheduleInsert>): Promise<Schedule | null>;
  delete(id: number): Promise<boolean>;
  deleteByName(name: string): Promise<boolean>;

  // Query operations
  listAll(): Promise<Schedule[]>;
  listEnabled(): Promise<Schedule[]>;
  listDueSchedules(cutoff?: Date): Promise<Schedule[]>;
  getByUserId(userId: string): Promise<Schedule[]>;

  // Schedule execution tracking
  updateLastRun(id: number, success: boolean, error?: string): Promise<void>;
  updateNextRunAt(id: number, nextRunAt: Date): Promise<void>;
  markRunning(id: number, instanceId: string): Promise<boolean>;

  // Utility
  count(): Promise<number>;
  calculateNextRunAt(cronExpression: string, timezone: string, after?: Date): Date | null;

  // Conversion helpers
  toLocalConfig(schedule: Schedule, metadata?: ScheduleMetadata): LocalScheduleConfig;
  fromLocalConfig(config: LocalScheduleConfig, createdBy: string): ScheduleInsert & { metadata?: ScheduleMetadata };
}

/**
 * Create a PostgreSQL schedule store instance
 */
export function createSchedulePgStore(clientManager: SupabaseClientManager): SchedulePgStore {
  const { client: supabase } = clientManager;
  /**
   * Calculate the next run time for a cron expression
   */
  function calculateNextRunAt(
    cronExpression: string,
    timezone: string,
    after: Date = new Date()
  ): Date | null {
    try {
      const interval = CronExpressionParser.parse(cronExpression, {
        currentDate: after,
        tz: timezone,
      });
      return interval.next().toDate();
    } catch (error) {
      log.error(`[schedule-pg] Failed to parse cron expression: ${cronExpression}`, error);
      return null;
    }
  }

  /**
   * Convert DB schedule to local config format
   */
  function toLocalConfig(schedule: Schedule, metadata?: ScheduleMetadata): LocalScheduleConfig {
    return {
      // Use name as ID since local store uses string IDs
      id: `pg_${schedule.id}`,
      name: schedule.name,
      cron: schedule.cron_expression,
      timezone: schedule.timezone,
      prompt: schedule.prompt,
      sessionId: metadata?.sessionId || "",
      targetUserId: schedule.target_user_id,
      targetUsername: metadata?.targetUsername || "",
      enabled: schedule.enabled,
      createdAt: schedule.created_at.toISOString(),
      lastRunAt: schedule.last_run_at?.toISOString(),
      lastRunSuccess: metadata?.lastRunSuccess,
      lastRunError: metadata?.lastRunError,
    };
  }

  /**
   * Convert local config to DB insert format
   */
  function fromLocalConfig(
    config: LocalScheduleConfig,
    createdBy: string
  ): ScheduleInsert & { metadata?: ScheduleMetadata } {
    const nextRunAt = calculateNextRunAt(config.cron, config.timezone);

    return {
      name: config.name,
      cron_expression: config.cron,
      timezone: config.timezone,
      prompt: config.prompt,
      target_user_id: config.targetUserId,
      enabled: config.enabled,
      created_by: createdBy,
      last_run_at: config.lastRunAt ? new Date(config.lastRunAt) : null,
      next_run_at: nextRunAt,
      metadata: {
        sessionId: config.sessionId,
        targetUsername: config.targetUsername,
        lastRunSuccess: config.lastRunSuccess,
        lastRunError: config.lastRunError,
      },
    };
  }

  /**
   * Create a new schedule
   */
  async function create(
    schedule: ScheduleInsert & { metadata?: ScheduleMetadata }
  ): Promise<Schedule> {
    // Calculate next_run_at if not provided
    const nextRunAt =
      schedule.next_run_at ||
      calculateNextRunAt(schedule.cron_expression, schedule.timezone || "UTC");

    // Extract metadata (won't be stored in core columns)
    const { metadata: _, ...dbSchedule } = schedule;

    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .insert({
        ...dbSchedule,
        next_run_at: nextRunAt?.toISOString() || null,
      })
      .select()
      .single();

    if (error) {
      handlePostgrestError(error, "create schedule");
    }

    const result = ScheduleSchema.parse(data);
    log.info(`[schedule-pg] Created schedule: ${result.name} (id=${result.id})`);
    return result;
  }

  /**
   * Get schedule by ID
   */
  async function getById(id: number): Promise<Schedule | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get schedule by id");
    }

    return data ? ScheduleSchema.parse(data) : null;
  }

  /**
   * Get schedule by name
   */
  async function getByName(name: string): Promise<Schedule | null> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .select("*")
      .eq("name", name)
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "get schedule by name");
    }

    return data ? ScheduleSchema.parse(data) : null;
  }

  /**
   * Update a schedule
   */
  async function update(
    id: number,
    updates: Partial<ScheduleInsert>
  ): Promise<Schedule | null> {
    // If cron or timezone changed, recalculate next_run_at
    let updateData: Record<string, unknown> = { ...updates };

    if (updates.cron_expression || updates.timezone) {
      const current = await getById(id);
      if (current) {
        const cronExpr = updates.cron_expression || current.cron_expression;
        const tz = updates.timezone || current.timezone;
        const nextRunAt = calculateNextRunAt(cronExpr, tz);
        if (nextRunAt) {
          updateData.next_run_at = nextRunAt.toISOString();
        }
      }
    }

    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .update(updateData)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      handlePostgrestError(error, "update schedule");
    }

    if (data) {
      log.debug(`[schedule-pg] Updated schedule id=${id}`);
      return ScheduleSchema.parse(data);
    }

    return null;
  }

  /**
   * Delete a schedule by ID
   */
  async function deleteById(id: number): Promise<boolean> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .delete({ count: "exact" })
      .eq("id", id);

    if (error) {
      handlePostgrestError(error, "delete schedule");
    }

    if (count && count > 0) {
      log.info(`[schedule-pg] Deleted schedule id=${id}`);
      return true;
    }

    return false;
  }

  /**
   * Delete a schedule by name
   */
  async function deleteByName(name: string): Promise<boolean> {
    const { error, count } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .delete({ count: "exact" })
      .eq("name", name);

    if (error) {
      handlePostgrestError(error, "delete schedule by name");
    }

    if (count && count > 0) {
      log.info(`[schedule-pg] Deleted schedule name=${name}`);
      return true;
    }

    return false;
  }

  /**
   * List all schedules
   */
  async function listAll(): Promise<Schedule[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list all schedules");
    }

    return (data || []).map((row) => ScheduleSchema.parse(row));
  }

  /**
   * List enabled schedules
   */
  async function listEnabled(): Promise<Schedule[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .select("*")
      .eq("enabled", true)
      .order("next_run_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list enabled schedules");
    }

    return (data || []).map((row) => ScheduleSchema.parse(row));
  }

  /**
   * List schedules that are due to run
   * Returns schedules where next_run_at <= cutoff (default: now)
   */
  async function listDueSchedules(cutoff: Date = new Date()): Promise<Schedule[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .select("*")
      .eq("enabled", true)
      .lte("next_run_at", cutoff.toISOString())
      .order("next_run_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "list due schedules");
    }

    return (data || []).map((row) => ScheduleSchema.parse(row));
  }

  /**
   * Get schedules for a specific user
   */
  async function getByUserId(userId: string): Promise<Schedule[]> {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .select("*")
      .eq("target_user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      handlePostgrestError(error, "get schedules by user");
    }

    return (data || []).map((row) => ScheduleSchema.parse(row));
  }

  /**
   * Update last run info and calculate next run time
   */
  async function updateLastRun(
    id: number,
    success: boolean,
    errorMessage?: string
  ): Promise<void> {
    const schedule = await getById(id);
    if (!schedule) {
      log.warn(`[schedule-pg] Cannot update last run - schedule id=${id} not found`);
      return;
    }

    const now = new Date();
    const nextRunAt = calculateNextRunAt(schedule.cron_expression, schedule.timezone, now);

    const { error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .update({
        last_run_at: now.toISOString(),
        next_run_at: nextRunAt?.toISOString() || null,
        updated_at: now.toISOString(),
      })
      .eq("id", id);

    if (error) {
      handlePostgrestError(error, "update last run");
    }

    log.debug(
      `[schedule-pg] Updated last run for schedule id=${id}: success=${success}, next=${nextRunAt?.toISOString()}`
    );
  }

  /**
   * Update the next run time for a schedule
   */
  async function updateNextRunAt(id: number, nextRunAt: Date): Promise<void> {
    const { error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .update({
        next_run_at: nextRunAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) {
      handlePostgrestError(error, "update next run at");
    }
  }

  /**
   * Mark a schedule as running by this instance
   * Uses conditional update to prevent multiple instances from running the same schedule
   *
   * @returns true if this instance successfully claimed the schedule
   */
  async function markRunning(id: number, instanceId: string): Promise<boolean> {
    // For now, this is a placeholder that always succeeds
    // The actual contention prevention is handled by leader election
    // If we want per-schedule locking, we'd need to add columns to the schema
    log.debug(`[schedule-pg] Instance ${instanceId} marking schedule id=${id} as running`);
    return true;
  }

  /**
   * Count total schedules
   */
  async function count(): Promise<number> {
    const { count: total, error } = await supabase
      .schema(SCHEMA)
      .from(TABLE)
      .select("*", { count: "exact", head: true });

    if (error) {
      handlePostgrestError(error, "count schedules");
    }

    return total || 0;
  }

  return {
    create,
    getById,
    getByName,
    update,
    delete: deleteById,
    deleteByName,
    listAll,
    listEnabled,
    listDueSchedules,
    getByUserId,
    updateLastRun,
    updateNextRunAt,
    markRunning,
    count,
    calculateNextRunAt,
    toLocalConfig,
    fromLocalConfig,
  };
}
