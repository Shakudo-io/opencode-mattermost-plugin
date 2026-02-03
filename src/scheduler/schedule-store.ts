import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { z } from "zod";
import { log } from "../logger.js";
import type { UnifiedStore } from "../persistence/unified-store.js";
import {
  createSchedulePgStore,
  type SchedulePgStore,
  type ScheduleMetadata,
} from "../persistence/postgres/schedule-pg.js";

export const ScheduleConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string().default("UTC"),
  prompt: z.string(),
  sessionId: z.string(),
  targetUserId: z.string(),
  targetUsername: z.string(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  lastRunSuccess: z.boolean().optional(),
  lastRunError: z.string().optional(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

export const ScheduleFileSchema = z.object({
  version: z.literal(1),
  schedules: z.array(ScheduleConfigSchema),
  lastModified: z.string(),
});
export type ScheduleFileV1 = z.infer<typeof ScheduleFileSchema>;

const PRIMARY_DIR = join(homedir(), ".config", "opencode");
const FALLBACK_DIR = join(homedir(), ".opencode");
const FILENAME = "mattermost-schedules.json";

export type ScheduleStoreOptions = {
  unifiedStore?: UnifiedStore;
};

export class ScheduleStore {
  private schedules: Map<string, ScheduleConfig> = new Map();
  private byUserId: Map<string, ScheduleConfig[]> = new Map();
  private bySessionId: Map<string, ScheduleConfig[]> = new Map();
  private filePath: string;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs: number = 2000;

  private unifiedStore: UnifiedStore | null = null;
  private pgStore: SchedulePgStore | null = null;
  private metadataCache: Map<string, ScheduleMetadata> = new Map();

  constructor(options?: ScheduleStoreOptions) {
    this.filePath = this.resolveFilePath();
    this.unifiedStore = options?.unifiedStore ?? null;

    if (this.unifiedStore) {
      const clientManager = this.unifiedStore.getClientManager();
      if (clientManager) {
        this.pgStore = createSchedulePgStore(clientManager);
      }
    }
  }

  private resolveFilePath(): string {
    if (existsSync(PRIMARY_DIR)) {
      return join(PRIMARY_DIR, FILENAME);
    }
    if (existsSync(FALLBACK_DIR)) {
      return join(FALLBACK_DIR, FILENAME);
    }
    mkdirSync(PRIMARY_DIR, { recursive: true });
    return join(PRIMARY_DIR, FILENAME);
  }

  private shouldWriteToPostgres(): boolean {
    return this.unifiedStore?.shouldWriteToPostgres() ?? false;
  }

  private shouldReadFromPostgres(): boolean {
    return this.unifiedStore?.shouldReadFromPostgres() ?? false;
  }

  private shouldWriteToJson(): boolean {
    return this.unifiedStore?.shouldWriteToJson() ?? true;
  }

  /**
   * Extract numeric PG ID from local ID format (e.g., "pg_123" -> 123)
   */
  private extractPgId(localId: string): number | null {
    if (localId.startsWith("pg_")) {
      const numericPart = localId.slice(3);
      const parsed = parseInt(numericPart, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  async load(): Promise<ScheduleConfig[]> {
    // Try loading from Postgres first if in phase 2 or 3
    if (this.shouldReadFromPostgres() && this.pgStore) {
      try {
        const pgSchedules = await this.pgStore.listAll();
        const configs: ScheduleConfig[] = [];

        for (const pgSchedule of pgSchedules) {
          // Retrieve metadata from cache or use defaults
          const metadata = this.metadataCache.get(`pg_${pgSchedule.id}`) || {};
          const config = this.pgStore.toLocalConfig(pgSchedule, metadata);
          configs.push(config);
        }

        this.setSchedules(configs);
        log.info(`[ScheduleStore] Loaded ${configs.length} schedules from Postgres`);

        // In phase 2, also merge from JSON for migration
        if (this.unifiedStore?.getMigrationPhase() === "2") {
          const jsonSchedules = await this.loadFromJson();
          if (jsonSchedules.length > 0) {
            await this.mergeFromJson(jsonSchedules);
          }
        }

        return Array.from(this.schedules.values());
      } catch (e) {
        log.error("[ScheduleStore] Failed to load from Postgres, falling back to JSON:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    // Fall back to JSON
    return this.loadFromJson();
  }

  private async loadFromJson(): Promise<ScheduleConfig[]> {
    try {
      if (!existsSync(this.filePath)) {
        log.debug("[ScheduleStore] No existing file, starting fresh");
        return [];
      }

      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const validated = ScheduleFileSchema.safeParse(parsed);

      if (!validated.success) {
        log.warn("[ScheduleStore] Invalid file format, filtering valid entries");
        const schedules: ScheduleConfig[] = [];
        if (Array.isArray(parsed?.schedules)) {
          for (const s of parsed.schedules) {
            const result = ScheduleConfigSchema.safeParse(s);
            if (result.success) {
              schedules.push(result.data);
            }
          }
        }
        this.setSchedules(schedules);
        return schedules;
      }

      this.setSchedules(validated.data.schedules);
      log.info(`[ScheduleStore] Loaded ${validated.data.schedules.length} schedules from JSON`);
      return validated.data.schedules;
    } catch (e) {
      log.error("[ScheduleStore] Failed to load from JSON:", e);
      return [];
    }
  }

  /**
   * Merge schedules from JSON into memory and sync to Postgres (phase 2 migration)
   */
  private async mergeFromJson(jsonSchedules: ScheduleConfig[]): Promise<void> {
    let merged = 0;
    const createdBy = this.getInstanceId();

    for (const jsonSchedule of jsonSchedules) {
      // Skip if already exists (by name, since IDs may differ)
      const existingByName = this.getByName(jsonSchedule.name);
      if (!existingByName) {
        this.addToIndexes(jsonSchedule);

        // Store metadata for this schedule
        this.metadataCache.set(jsonSchedule.id, {
          sessionId: jsonSchedule.sessionId,
          targetUsername: jsonSchedule.targetUsername,
          lastRunSuccess: jsonSchedule.lastRunSuccess,
          lastRunError: jsonSchedule.lastRunError,
        });

        // Sync to Postgres if enabled
        if (this.shouldWriteToPostgres() && this.pgStore) {
          try {
            const pgData = this.pgStore.fromLocalConfig(jsonSchedule, createdBy);
            const created = await this.pgStore.create(pgData);

            // Update the in-memory schedule with the new PG ID
            this.removeFromIndexes(jsonSchedule);
            const updatedConfig: ScheduleConfig = {
              ...jsonSchedule,
              id: `pg_${created.id}`,
            };
            this.addToIndexes(updatedConfig);

            // Move metadata to new ID
            this.metadataCache.delete(jsonSchedule.id);
            this.metadataCache.set(updatedConfig.id, {
              sessionId: jsonSchedule.sessionId,
              targetUsername: jsonSchedule.targetUsername,
              lastRunSuccess: jsonSchedule.lastRunSuccess,
              lastRunError: jsonSchedule.lastRunError,
            });

            log.debug(`[ScheduleStore] Synced JSON schedule "${jsonSchedule.name}" to Postgres as id=${created.id}`);
          } catch (e) {
            log.warn(`[ScheduleStore] Failed to sync JSON schedule to Postgres: ${e}`);
          }
        }

        merged++;
      }
    }

    if (merged > 0) {
      log.info(`[ScheduleStore] Merged ${merged} schedules from JSON into memory`);
    }
  }

  async save(): Promise<void> {
    if (!this.shouldWriteToJson()) {
      return;
    }

    try {
      const data: ScheduleFileV1 = {
        version: 1,
        schedules: Array.from(this.schedules.values()),
        lastModified: new Date().toISOString(),
      };

      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      writeFileSync(tempPath, JSON.stringify(data, null, 2));
      renameSync(tempPath, this.filePath);
      log.debug(`[ScheduleStore] Saved ${this.schedules.size} schedules to JSON`);
    } catch (e) {
      log.error("[ScheduleStore] Failed to save to JSON:", e);
    }
  }

  scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.save().catch((e) => log.error("[ScheduleStore] Debounced save failed:", e));
    }, this.saveDebounceMs);
  }

  private setSchedules(schedules: ScheduleConfig[]): void {
    this.schedules.clear();
    this.byUserId.clear();
    this.bySessionId.clear();

    for (const s of schedules) {
      this.addToIndexes(s);
    }
  }

  private addToIndexes(schedule: ScheduleConfig): void {
    this.schedules.set(schedule.id, schedule);

    const userSchedules = this.byUserId.get(schedule.targetUserId) || [];
    userSchedules.push(schedule);
    this.byUserId.set(schedule.targetUserId, userSchedules);

    const sessionSchedules = this.bySessionId.get(schedule.sessionId) || [];
    sessionSchedules.push(schedule);
    this.bySessionId.set(schedule.sessionId, sessionSchedules);
  }

  private removeFromIndexes(schedule: ScheduleConfig): void {
    this.schedules.delete(schedule.id);

    const userSchedules = this.byUserId.get(schedule.targetUserId);
    if (userSchedules) {
      const filtered = userSchedules.filter((s) => s.id !== schedule.id);
      if (filtered.length > 0) {
        this.byUserId.set(schedule.targetUserId, filtered);
      } else {
        this.byUserId.delete(schedule.targetUserId);
      }
    }

    const sessionSchedules = this.bySessionId.get(schedule.sessionId);
    if (sessionSchedules) {
      const filtered = sessionSchedules.filter((s) => s.id !== schedule.id);
      if (filtered.length > 0) {
        this.bySessionId.set(schedule.sessionId, filtered);
      } else {
        this.bySessionId.delete(schedule.sessionId);
      }
    }
  }

  async add(schedule: ScheduleConfig): Promise<void> {
    // Write to Postgres first if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        const createdBy = this.getInstanceId();
        const pgData = this.pgStore.fromLocalConfig(schedule, createdBy);
        const created = await this.pgStore.create(pgData);

        // Update schedule with Postgres ID
        schedule = {
          ...schedule,
          id: `pg_${created.id}`,
        };

        // Store metadata
        this.metadataCache.set(schedule.id, {
          sessionId: schedule.sessionId,
          targetUsername: schedule.targetUsername,
          lastRunSuccess: schedule.lastRunSuccess,
          lastRunError: schedule.lastRunError,
        });

        log.debug(`[ScheduleStore] Created schedule in Postgres: id=${created.id}`);
      } catch (e) {
        log.error("[ScheduleStore] Failed to write to Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    this.addToIndexes(schedule);

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }
  }

  async update(schedule: ScheduleConfig): Promise<void> {
    const existing = this.schedules.get(schedule.id);
    if (existing) {
      this.removeFromIndexes(existing);
    }
    this.addToIndexes(schedule);

    // Update metadata cache
    this.metadataCache.set(schedule.id, {
      sessionId: schedule.sessionId,
      targetUsername: schedule.targetUsername,
      lastRunSuccess: schedule.lastRunSuccess,
      lastRunError: schedule.lastRunError,
    });

    // Write to Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      const pgId = this.extractPgId(schedule.id);
      if (pgId !== null) {
        try {
          await this.pgStore.update(pgId, {
            name: schedule.name,
            cron_expression: schedule.cron,
            timezone: schedule.timezone,
            prompt: schedule.prompt,
            target_user_id: schedule.targetUserId,
            enabled: schedule.enabled,
          });
          log.debug(`[ScheduleStore] Updated schedule in Postgres: id=${pgId}`);
        } catch (e) {
          log.error("[ScheduleStore] Failed to update in Postgres:", e);
          this.unifiedStore?.getDegradedModeManager().enter(String(e));
        }
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }
  }

  async remove(scheduleId: string): Promise<boolean> {
    const existing = this.schedules.get(scheduleId);
    if (existing) {
      this.removeFromIndexes(existing);
      this.metadataCache.delete(scheduleId);

      // Delete from Postgres if enabled
      if (this.shouldWriteToPostgres() && this.pgStore) {
        const pgId = this.extractPgId(scheduleId);
        if (pgId !== null) {
          try {
            await this.pgStore.delete(pgId);
            log.debug(`[ScheduleStore] Deleted schedule from Postgres: id=${pgId}`);
          } catch (e) {
            log.error("[ScheduleStore] Failed to delete from Postgres:", e);
            this.unifiedStore?.getDegradedModeManager().enter(String(e));
          }
        } else {
          // Try deleting by name for JSON-originated schedules
          try {
            await this.pgStore.deleteByName(existing.name);
            log.debug(`[ScheduleStore] Deleted schedule from Postgres by name: ${existing.name}`);
          } catch (e) {
            log.warn(`[ScheduleStore] Failed to delete from Postgres by name: ${e}`);
          }
        }
      }

      if (this.shouldWriteToJson()) {
        this.scheduleSave();
      }
      return true;
    }
    return false;
  }

  getById(scheduleId: string): ScheduleConfig | null {
    return this.schedules.get(scheduleId) || null;
  }

  getByName(name: string): ScheduleConfig | null {
    for (const schedule of this.schedules.values()) {
      if (schedule.name === name) {
        return schedule;
      }
    }
    return null;
  }

  getByUserId(userId: string): ScheduleConfig[] {
    return this.byUserId.get(userId) || [];
  }

  getBySessionId(sessionId: string): ScheduleConfig[] {
    return this.bySessionId.get(sessionId) || [];
  }

  listAll(): ScheduleConfig[] {
    return Array.from(this.schedules.values());
  }

  listEnabled(): ScheduleConfig[] {
    return this.listAll().filter((s) => s.enabled);
  }

  count(): number {
    return this.schedules.size;
  }

  async updateLastRun(scheduleId: string, success: boolean, error?: string): Promise<void> {
    const schedule = this.schedules.get(scheduleId);
    if (schedule) {
      schedule.lastRunAt = new Date().toISOString();
      schedule.lastRunSuccess = success;
      schedule.lastRunError = error;

      // Update metadata cache
      this.metadataCache.set(scheduleId, {
        ...this.metadataCache.get(scheduleId),
        lastRunSuccess: success,
        lastRunError: error,
      });

      // Update in Postgres if enabled
      if (this.shouldWriteToPostgres() && this.pgStore) {
        const pgId = this.extractPgId(scheduleId);
        if (pgId !== null) {
          try {
            await this.pgStore.updateLastRun(pgId, success, error);
            log.debug(`[ScheduleStore] Updated last run in Postgres: id=${pgId}`);
          } catch (e) {
            log.error("[ScheduleStore] Failed to update last run in Postgres:", e);
            this.unifiedStore?.getDegradedModeManager().enter(String(e));
          }
        }
      }

      if (this.shouldWriteToJson()) {
        this.scheduleSave();
      }
    }
  }

  async setEnabled(scheduleId: string, enabled: boolean): Promise<boolean> {
    const schedule = this.schedules.get(scheduleId);
    if (schedule) {
      schedule.enabled = enabled;

      // Update in Postgres if enabled
      if (this.shouldWriteToPostgres() && this.pgStore) {
        const pgId = this.extractPgId(scheduleId);
        if (pgId !== null) {
          try {
            await this.pgStore.update(pgId, { enabled });
            log.debug(`[ScheduleStore] Updated enabled status in Postgres: id=${pgId}, enabled=${enabled}`);
          } catch (e) {
            log.error("[ScheduleStore] Failed to update enabled in Postgres:", e);
            this.unifiedStore?.getDegradedModeManager().enter(String(e));
          }
        }
      }

      if (this.shouldWriteToJson()) {
        this.scheduleSave();
      }
      return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    await this.save();
  }

  /**
   * Get the Postgres store instance (for advanced operations like leader election)
   */
  getPgStore(): SchedulePgStore | null {
    return this.pgStore;
  }

  /**
   * Get the instance ID from the unified store
   */
  getInstanceId(): string {
    return this.unifiedStore?.getInstanceId() ?? "local";
  }
}

export function generateScheduleId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `sched_${timestamp}_${random}`;
}
