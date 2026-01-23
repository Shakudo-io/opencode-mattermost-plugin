import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { z } from "zod";
import { log } from "../logger.js";

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

export class ScheduleStore {
  private schedules: Map<string, ScheduleConfig> = new Map();
  private byUserId: Map<string, ScheduleConfig[]> = new Map();
  private bySessionId: Map<string, ScheduleConfig[]> = new Map();
  private filePath: string;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs: number = 2000;

  constructor() {
    this.filePath = this.resolveFilePath();
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

  async load(): Promise<ScheduleConfig[]> {
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
      log.info(`[ScheduleStore] Loaded ${validated.data.schedules.length} schedules`);
      return validated.data.schedules;
    } catch (e) {
      log.error("[ScheduleStore] Failed to load:", e);
      return [];
    }
  }

  async save(): Promise<void> {
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
      log.debug(`[ScheduleStore] Saved ${this.schedules.size} schedules`);
    } catch (e) {
      log.error("[ScheduleStore] Failed to save:", e);
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

  add(schedule: ScheduleConfig): void {
    this.addToIndexes(schedule);
    this.scheduleSave();
  }

  update(schedule: ScheduleConfig): void {
    const existing = this.schedules.get(schedule.id);
    if (existing) {
      this.removeFromIndexes(existing);
    }
    this.addToIndexes(schedule);
    this.scheduleSave();
  }

  remove(scheduleId: string): boolean {
    const existing = this.schedules.get(scheduleId);
    if (existing) {
      this.removeFromIndexes(existing);
      this.scheduleSave();
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

  updateLastRun(scheduleId: string, success: boolean, error?: string): void {
    const schedule = this.schedules.get(scheduleId);
    if (schedule) {
      schedule.lastRunAt = new Date().toISOString();
      schedule.lastRunSuccess = success;
      schedule.lastRunError = error;
      this.scheduleSave();
    }
  }

  setEnabled(scheduleId: string, enabled: boolean): boolean {
    const schedule = this.schedules.get(scheduleId);
    if (schedule) {
      schedule.enabled = enabled;
      this.scheduleSave();
      return true;
    }
    return false;
  }

  shutdown(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.save().catch((e) => log.error("[ScheduleStore] Shutdown save failed:", e));
  }
}

export function generateScheduleId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `sched_${timestamp}_${random}`;
}
