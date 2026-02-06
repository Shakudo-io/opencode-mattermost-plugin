import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { TeamsThreadMapping } from "../models/teams-types.js";
import { teamsLog } from "../teams/teams-logger.js";

const PRIMARY_DIR = join(homedir(), ".config", "opencode");
const FALLBACK_DIR = join(homedir(), ".opencode");
const FILENAME = "teams-threads.json";

const log = teamsLog.withContext("ThreadMappingStore");

interface TeamsThreadMappingFile {
  version: 1;
  mappings: TeamsThreadMapping[];
}

export class TeamsThreadMappingStore {
  private mappings: Map<string, TeamsThreadMapping> = new Map();
  private byThreadRootMessageId: Map<string, TeamsThreadMapping> = new Map();
  private byConversationId: Map<string, TeamsThreadMapping[]> = new Map();
  private byTeamsUserId: Map<string, TeamsThreadMapping[]> = new Map();
  private bySessionId: Map<string, TeamsThreadMapping> = new Map();
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

  async load(): Promise<TeamsThreadMapping[]> {
    try {
      if (!existsSync(this.filePath)) {
        log.debug("No existing file, starting fresh");
        return [];
      }

      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as TeamsThreadMappingFile;

      if (parsed.version !== 1) {
        log.warn("Unknown file version, starting fresh");
        return [];
      }

      this.setMappings(parsed.mappings);
      log.info(`Loaded ${parsed.mappings.length} thread mappings`);
      return parsed.mappings;
    } catch (error) {
      log.error("Failed to load thread mappings:", error);
      return [];
    }
  }

  private setMappings(mappings: TeamsThreadMapping[]): void {
    this.mappings.clear();
    this.byThreadRootMessageId.clear();
    this.byConversationId.clear();
    this.byTeamsUserId.clear();
    this.bySessionId.clear();

    for (const mapping of mappings) {
      this.addToIndexes(mapping);
    }
  }

  private addToIndexes(mapping: TeamsThreadMapping): void {
    this.mappings.set(mapping.id, mapping);
    this.byThreadRootMessageId.set(mapping.threadRootMessageId, mapping);
    this.bySessionId.set(mapping.openCodeSessionId, mapping);

    const byConversation = this.byConversationId.get(mapping.conversationId) ?? [];
    byConversation.push(mapping);
    this.byConversationId.set(mapping.conversationId, byConversation);

    const byUser = this.byTeamsUserId.get(mapping.teamsUserId) ?? [];
    byUser.push(mapping);
    this.byTeamsUserId.set(mapping.teamsUserId, byUser);
  }

  private removeFromIndexes(mapping: TeamsThreadMapping): void {
    this.mappings.delete(mapping.id);
    this.byThreadRootMessageId.delete(mapping.threadRootMessageId);
    this.bySessionId.delete(mapping.openCodeSessionId);

    const byConversation = this.byConversationId.get(mapping.conversationId);
    if (byConversation) {
      const filtered = byConversation.filter((m) => m.id !== mapping.id);
      if (filtered.length > 0) {
        this.byConversationId.set(mapping.conversationId, filtered);
      } else {
        this.byConversationId.delete(mapping.conversationId);
      }
    }

    const byUser = this.byTeamsUserId.get(mapping.teamsUserId);
    if (byUser) {
      const filtered = byUser.filter((m) => m.id !== mapping.id);
      if (filtered.length > 0) {
        this.byTeamsUserId.set(mapping.teamsUserId, filtered);
      } else {
        this.byTeamsUserId.delete(mapping.teamsUserId);
      }
    }
  }

  async save(mapping: TeamsThreadMapping): Promise<void> {
    const existing = this.mappings.get(mapping.id);
    if (existing) {
      this.removeFromIndexes(existing);
    }
    mapping.updatedAt = new Date().toISOString();
    this.addToIndexes(mapping);
    this.scheduleSave();
  }

  async delete(id: string): Promise<boolean> {
    const mapping = this.mappings.get(id);
    if (!mapping) return false;
    this.removeFromIndexes(mapping);
    this.scheduleSave();
    return true;
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.persistToFile();
    }, this.saveDebounceMs);
  }

  private persistToFile(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const file: TeamsThreadMappingFile = {
        version: 1,
        mappings: Array.from(this.mappings.values()),
      };

      writeFileSync(this.filePath, JSON.stringify(file, null, 2), "utf-8");
      log.debug(`Persisted ${file.mappings.length} mappings to ${this.filePath}`);
    } catch (error) {
      log.error("Failed to persist thread mappings:", error);
    }
  }

  async forceSave(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.persistToFile();
  }

  getById(id: string): TeamsThreadMapping | undefined {
    return this.mappings.get(id);
  }

  getByThreadRootMessageId(threadRootMessageId: string): TeamsThreadMapping | undefined {
    return this.byThreadRootMessageId.get(threadRootMessageId);
  }

  getBySessionId(sessionId: string): TeamsThreadMapping | undefined {
    return this.bySessionId.get(sessionId);
  }

  getByConversationId(conversationId: string): TeamsThreadMapping[] {
    return this.byConversationId.get(conversationId) ?? [];
  }

  getByTeamsUserId(teamsUserId: string): TeamsThreadMapping[] {
    return this.byTeamsUserId.get(teamsUserId) ?? [];
  }

  getAll(): TeamsThreadMapping[] {
    return Array.from(this.mappings.values());
  }

  getActive(): TeamsThreadMapping[] {
    return this.getAll().filter((m) => m.mode === "normal");
  }

  getByMode(mode: TeamsThreadMapping["mode"]): TeamsThreadMapping[] {
    return this.getAll().filter((m) => m.mode === mode);
  }

  async updateActivity(id: string): Promise<void> {
    const mapping = this.mappings.get(id);
    if (mapping) {
      mapping.metadata.lastActivityAt = new Date().toISOString();
      mapping.updatedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  async setMode(id: string, mode: TeamsThreadMapping["mode"]): Promise<void> {
    const mapping = this.mappings.get(id);
    if (mapping) {
      mapping.mode = mode;
      if (mode === "ended") {
        mapping.metadata.endedAt = new Date().toISOString();
      }
      mapping.updatedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  async addApprovedUser(id: string, userId: string): Promise<void> {
    const mapping = this.mappings.get(id);
    if (mapping && !mapping.approvedUsers.includes(userId)) {
      mapping.approvedUsers.push(userId);
      mapping.updatedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  async setApproveAll(id: string, approveAll: boolean): Promise<void> {
    const mapping = this.mappings.get(id);
    if (mapping) {
      mapping.approveAll = approveAll;
      mapping.updatedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  isUserApproved(mapping: TeamsThreadMapping, userId: string): boolean {
    if (mapping.teamsUserId === userId) return true;
    if (mapping.approveAll) return true;
    return mapping.approvedUsers.includes(userId);
  }
}

let storeInstance: TeamsThreadMappingStore | null = null;

export function getTeamsThreadMappingStore(): TeamsThreadMappingStore {
  if (!storeInstance) {
    storeInstance = new TeamsThreadMappingStore();
  }
  return storeInstance;
}

export function resetTeamsThreadMappingStore(): void {
  storeInstance = null;
}
