import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { ThreadSessionMapping } from "../models/index.js";
import { ThreadMappingFileSchema, type ThreadMappingFileV1 } from "../models/thread-mapping.js";
import { log } from "../logger.js";
import type { UnifiedStore } from "./unified-store.js";
import { createThreadMappingPgStore, type ThreadMappingPgStore } from "./postgres/thread-mapping-pg.js";

const PRIMARY_DIR = join(homedir(), ".config", "opencode");
const FALLBACK_DIR = join(homedir(), ".opencode");
const FILENAME = "mattermost-threads.json";

export type ThreadMappingStoreOptions = {
  unifiedStore?: UnifiedStore;
};

export class ThreadMappingStore {
  private mappings: Map<string, ThreadSessionMapping> = new Map();
  private byThreadRootPostId: Map<string, ThreadSessionMapping> = new Map();
  private byMattermostUserId: Map<string, ThreadSessionMapping[]> = new Map();
  private byChannelId: Map<string, ThreadSessionMapping[]> = new Map();
  private filePath: string;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs: number = 2000;

  private unifiedStore: UnifiedStore | null = null;
  private pgStore: ThreadMappingPgStore | null = null;

  constructor(options?: ThreadMappingStoreOptions) {
    this.filePath = this.resolveFilePath();
    this.unifiedStore = options?.unifiedStore ?? null;

    if (this.unifiedStore) {
      const clientManager = this.unifiedStore.getClientManager();
      if (clientManager) {
        this.pgStore = createThreadMappingPgStore(clientManager);
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

  async load(): Promise<ThreadSessionMapping[]> {
    if (this.shouldReadFromPostgres() && this.pgStore) {
      try {
        const mappings = await this.pgStore.listAll();
        this.setMappings(mappings);
        log.info(`[ThreadMappingStore] Loaded ${mappings.length} mappings from Postgres`);

        if (this.unifiedStore?.getMigrationPhase() === "2") {
          const jsonMappings = await this.loadFromJson();
          if (jsonMappings.length > 0) {
            this.mergeFromJson(jsonMappings);
          }
        }

        return Array.from(this.mappings.values());
      } catch (e) {
        log.error("[ThreadMappingStore] Failed to load from Postgres, falling back to JSON:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    return this.loadFromJson();
  }

  private async loadFromJson(): Promise<ThreadSessionMapping[]> {
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
      log.info(`[ThreadMappingStore] Loaded ${validated.data.mappings.length} mappings from JSON`);
      return validated.data.mappings;
    } catch (e) {
      log.error("[ThreadMappingStore] Failed to load from JSON:", e);
      return [];
    }
  }

  private mergeFromJson(jsonMappings: ThreadSessionMapping[]): void {
    let merged = 0;
    for (const jsonMapping of jsonMappings) {
      const existing = this.mappings.get(jsonMapping.sessionId);
      if (!existing) {
        this.addToIndexes(jsonMapping);
        merged++;

        if (this.shouldWriteToPostgres() && this.pgStore) {
          this.pgStore.create(jsonMapping).catch((e) => {
            log.warn(`[ThreadMappingStore] Failed to sync JSON mapping to Postgres: ${e}`);
          });
        }
      }
    }

    if (merged > 0) {
      log.info(`[ThreadMappingStore] Merged ${merged} mappings from JSON into memory`);
    }
  }

  async save(): Promise<void> {
    if (!this.shouldWriteToJson()) {
      return;
    }

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
      log.debug(`[ThreadMappingStore] Saved ${this.mappings.size} mappings to JSON`);
    } catch (e) {
      log.error("[ThreadMappingStore] Failed to save to JSON:", e);
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
    this.byChannelId.clear();

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

    const channelId = mapping.channelId || mapping.dmChannelId;
    const channelMappings = this.byChannelId.get(channelId) || [];
    channelMappings.push(mapping);
    this.byChannelId.set(channelId, channelMappings);
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

    const channelId = mapping.channelId || mapping.dmChannelId;
    const channelMappings = this.byChannelId.get(channelId);
    if (channelMappings) {
      const filtered = channelMappings.filter((m) => m.sessionId !== mapping.sessionId);
      if (filtered.length > 0) {
        this.byChannelId.set(channelId, filtered);
      } else {
        this.byChannelId.delete(channelId);
      }
    }
  }

  async add(mapping: ThreadSessionMapping): Promise<void> {
    this.addToIndexes(mapping);

    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.create(mapping);
      } catch (e) {
        log.error("[ThreadMappingStore] Failed to write to Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }
  }

  async update(mapping: ThreadSessionMapping): Promise<void> {
    const existing = this.mappings.get(mapping.sessionId);
    if (existing) {
      this.removeFromIndexes(existing);
    }
    this.addToIndexes(mapping);

    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.update(mapping);
      } catch (e) {
        log.error("[ThreadMappingStore] Failed to update in Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }
  }

  async remove(sessionId: string): Promise<void> {
    const existing = this.mappings.get(sessionId);
    if (existing) {
      this.removeFromIndexes(existing);

      if (this.shouldWriteToPostgres() && this.pgStore) {
        try {
          await this.pgStore.delete(sessionId);
        } catch (e) {
          log.error("[ThreadMappingStore] Failed to delete from Postgres:", e);
          this.unifiedStore?.getDegradedModeManager().enter(String(e));
        }
      }

      if (this.shouldWriteToJson()) {
        this.scheduleSave();
      }
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

  getByChannelId(channelId: string): ThreadSessionMapping[] {
    return this.byChannelId.get(channelId) || [];
  }

  getActiveMappingsForChannel(channelId: string): ThreadSessionMapping[] {
    return this.getByChannelId(channelId).filter((m) => m.status === "active");
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

  async merge(diskMappings: ThreadSessionMapping[]): Promise<void> {
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

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }
  }

  async cleanOrphaned(validSessionIds: Set<string>): Promise<number> {
    let cleaned = 0;
    for (const mapping of this.listAll()) {
      if (mapping.status === "active" && !validSessionIds.has(mapping.sessionId)) {
        mapping.status = "orphaned";
        await this.update(mapping);
        cleaned++;
      }
    }
    return cleaned;
  }

  async reactivate(threadRootPostId: string): Promise<boolean> {
    const mapping = this.byThreadRootPostId.get(threadRootPostId);
    if (mapping && mapping.status === "orphaned") {
      mapping.status = "active";
      mapping.lastActivityAt = new Date().toISOString();
      await this.update(mapping);
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

  getPgStore(): ThreadMappingPgStore | null {
    return this.pgStore;
  }

  getInstanceId(): string {
    return this.unifiedStore?.getInstanceId() ?? "local";
  }
}
