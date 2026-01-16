import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { ThreadSessionMapping } from "../models/index.js";
import { ThreadMappingFileSchema, type ThreadMappingFileV1 } from "../models/thread-mapping.js";
import { log } from "../logger.js";

const PRIMARY_DIR = join(homedir(), ".config", "opencode");
const FALLBACK_DIR = join(homedir(), ".opencode");
const FILENAME = "mattermost-threads.json";

export class ThreadMappingStore {
  private mappings: Map<string, ThreadSessionMapping> = new Map();
  private byThreadRootPostId: Map<string, ThreadSessionMapping> = new Map();
  private byMattermostUserId: Map<string, ThreadSessionMapping[]> = new Map();
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

  async load(): Promise<ThreadSessionMapping[]> {
    try {
      if (!existsSync(this.filePath)) {
        log.debug("[ThreadMappingStore] No existing file, starting fresh");
        return [];
      }

      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const validated = ThreadMappingFileSchema.safeParse(parsed);

      if (!validated.success) {
        log.warn("[ThreadMappingStore] Invalid file format, filtering invalid entries");
        const mappings: ThreadSessionMapping[] = [];
        if (Array.isArray(parsed?.mappings)) {
          for (const m of parsed.mappings) {
            if (m?.sessionId && m?.threadRootPostId) {
              mappings.push(m as ThreadSessionMapping);
            }
          }
        }
        this.setMappings(mappings);
        return mappings;
      }

      this.setMappings(validated.data.mappings);
      log.info(`[ThreadMappingStore] Loaded ${validated.data.mappings.length} mappings`);
      return validated.data.mappings;
    } catch (e) {
      log.error("[ThreadMappingStore] Failed to load:", e);
      return [];
    }
  }

  async save(): Promise<void> {
    try {
      const data: ThreadMappingFileV1 = {
        version: 1,
        mappings: Array.from(this.mappings.values()),
        lastModified: new Date().toISOString(),
      };

      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      writeFileSync(tempPath, JSON.stringify(data, null, 2));
      renameSync(tempPath, this.filePath);
      log.debug(`[ThreadMappingStore] Saved ${this.mappings.size} mappings`);
    } catch (e) {
      log.error("[ThreadMappingStore] Failed to save:", e);
    }
  }

  scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.save().catch((e) => log.error("[ThreadMappingStore] Debounced save failed:", e));
    }, this.saveDebounceMs);
  }

  private setMappings(mappings: ThreadSessionMapping[]): void {
    this.mappings.clear();
    this.byThreadRootPostId.clear();
    this.byMattermostUserId.clear();

    for (const m of mappings) {
      this.addToIndexes(m);
    }
  }

  private addToIndexes(mapping: ThreadSessionMapping): void {
    this.mappings.set(mapping.sessionId, mapping);
    this.byThreadRootPostId.set(mapping.threadRootPostId, mapping);

    const userMappings = this.byMattermostUserId.get(mapping.mattermostUserId) || [];
    userMappings.push(mapping);
    this.byMattermostUserId.set(mapping.mattermostUserId, userMappings);
  }

  private removeFromIndexes(mapping: ThreadSessionMapping): void {
    this.mappings.delete(mapping.sessionId);
    this.byThreadRootPostId.delete(mapping.threadRootPostId);

    const userMappings = this.byMattermostUserId.get(mapping.mattermostUserId);
    if (userMappings) {
      const filtered = userMappings.filter((m) => m.sessionId !== mapping.sessionId);
      if (filtered.length > 0) {
        this.byMattermostUserId.set(mapping.mattermostUserId, filtered);
      } else {
        this.byMattermostUserId.delete(mapping.mattermostUserId);
      }
    }
  }

  add(mapping: ThreadSessionMapping): void {
    this.addToIndexes(mapping);
    this.scheduleSave();
  }

  update(mapping: ThreadSessionMapping): void {
    const existing = this.mappings.get(mapping.sessionId);
    if (existing) {
      this.removeFromIndexes(existing);
    }
    this.addToIndexes(mapping);
    this.scheduleSave();
  }

  remove(sessionId: string): void {
    const existing = this.mappings.get(sessionId);
    if (existing) {
      this.removeFromIndexes(existing);
      this.scheduleSave();
    }
  }

  getBySessionId(sessionId: string): ThreadSessionMapping | null {
    return this.mappings.get(sessionId) || null;
  }

  getByThreadRootPostId(threadRootPostId: string): ThreadSessionMapping | null {
    return this.byThreadRootPostId.get(threadRootPostId) || null;
  }

  getByMattermostUserId(mattermostUserId: string): ThreadSessionMapping[] {
    return this.byMattermostUserId.get(mattermostUserId) || [];
  }

  getActiveMappingsForUser(mattermostUserId: string): ThreadSessionMapping[] {
    return this.getByMattermostUserId(mattermostUserId).filter((m) => m.status === "active");
  }

  listAll(): ThreadSessionMapping[] {
    return Array.from(this.mappings.values());
  }

  listActive(): ThreadSessionMapping[] {
    return this.listAll().filter((m) => m.status === "active");
  }

  count(): number {
    return this.mappings.size;
  }

  merge(diskMappings: ThreadSessionMapping[]): void {
    for (const disk of diskMappings) {
      const existing = this.mappings.get(disk.sessionId);
      if (!existing) {
        this.addToIndexes(disk);
      } else {
        const diskTime = new Date(disk.lastActivityAt).getTime();
        const memTime = new Date(existing.lastActivityAt).getTime();
        if (diskTime > memTime) {
          this.removeFromIndexes(existing);
          this.addToIndexes(disk);
        }
      }
    }
    this.scheduleSave();
  }

  cleanOrphaned(validSessionIds: Set<string>): number {
    let cleaned = 0;
    for (const mapping of this.listAll()) {
      if (mapping.status === "active" && !validSessionIds.has(mapping.sessionId)) {
        mapping.status = "orphaned";
        this.update(mapping);
        cleaned++;
      }
    }
    return cleaned;
  }

  shutdown(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.save().catch((e) => log.error("[ThreadMappingStore] Shutdown save failed:", e));
  }
}
