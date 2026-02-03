import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { log } from "../logger.js";
import type { UnifiedStore } from "./unified-store.js";
import {
  createTeamPgStore,
  type TeamPgStore,
  type LocalTeamConfig,
  type LocalTeamMember,
  type LocalTeamSettings,
} from "./postgres/team-pg.js";

export interface TeamMember {
  userId: string;
  username: string;
  addedAt: string;
  addedBy: string;
  role: "member" | "admin";
}

export interface TeamSettings {
  allowMembersToCreateSessions: boolean;
  allowMembersToApproveGuests: boolean;
  syncWithMattermostTeam: boolean;
  mattermostTeamId?: string;
}

export interface TeamConfig {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  members: TeamMember[];
  settings: TeamSettings;
}

export interface TeamConfigFile {
  version: 1;
  team: TeamConfig;
}

const PRIMARY_DIR = join(homedir(), ".config", "opencode");
const FALLBACK_DIR = join(homedir(), ".opencode");
const FILENAME = "mattermost-team.json";

export type TeamStoreOptions = {
  cacheTtlMs?: number;
  unifiedStore?: UnifiedStore;
};

export class TeamStore {
  private config: TeamConfig | null = null;
  private memberCache: Set<string> = new Set();
  private cacheLastLoaded: number = 0;
  private cacheTtlMs: number = 300000; // 5 minutes default
  private filePath: string;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs: number = 1000;

  private unifiedStore: UnifiedStore | null = null;
  private pgStore: TeamPgStore | null = null;

  constructor(options?: TeamStoreOptions | number) {
    this.filePath = this.resolveFilePath();

    // Handle legacy constructor signature (cacheTtlMs?: number)
    if (typeof options === "number") {
      this.cacheTtlMs = options;
    } else if (options) {
      if (options.cacheTtlMs !== undefined) {
        this.cacheTtlMs = options.cacheTtlMs;
      }
      this.unifiedStore = options.unifiedStore ?? null;

      if (this.unifiedStore) {
        const clientManager = this.unifiedStore.getClientManager();
        if (clientManager) {
          this.pgStore = createTeamPgStore(clientManager);
        }
      }
    }
  }

  private resolveFilePath(): string {
    // Check for custom path from environment
    const customPath = process.env.OPENCODE_MM_TEAM_FILE;
    if (customPath) {
      const expanded = customPath.replace(/^~/, homedir());
      return expanded;
    }

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

  private getInstanceId(): string {
    return this.unifiedStore?.getInstanceId() ?? "local";
  }

  /**
   * Load team configuration from disk or Postgres
   */
  async load(): Promise<TeamConfig | null> {
    // Try loading from Postgres first if in phase 2 or 3
    if (this.shouldReadFromPostgres() && this.pgStore) {
      try {
        const teams = await this.pgStore.listTeams();
        if (teams.length > 0) {
          // For now, we only support a single team per instance
          const team = teams[0];
          const members = await this.pgStore.listMembers(team.team_id);
          const settings = (team.settings || {}) as Record<string, unknown>;
          const ownerId = (settings.ownerId as string) || this.getInstanceId();

          this.config = this.pgStore.toLocalConfig(team, members, ownerId);
          this.rebuildCache();
          log.info(`[TeamStore] Loaded team "${this.config.name}" with ${this.config.members.length} member(s) from Postgres`);

          // In phase 2, also merge from JSON for migration
          if (this.unifiedStore?.getMigrationPhase() === "2") {
            const jsonConfig = this.loadFromJson();
            if (jsonConfig) {
              await this.mergeFromJson(jsonConfig);
            }
          }

          return this.config;
        }
      } catch (e) {
        log.error("[TeamStore] Failed to load from Postgres, falling back to JSON:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    // Fall back to JSON
    return this.loadFromJson();
  }

  /**
   * Load team configuration from JSON file (synchronous for backward compatibility)
   */
  private loadFromJson(): TeamConfig | null {
    try {
      if (!existsSync(this.filePath)) {
        log.debug("[TeamStore] No team file exists, starting fresh");
        return null;
      }

      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as TeamConfigFile;

      if (parsed.version !== 1) {
        log.warn(`[TeamStore] Unknown team config version: ${parsed.version}`);
        return null;
      }

      this.config = parsed.team;
      this.rebuildCache();
      log.info(`[TeamStore] Loaded team "${this.config.name}" with ${this.config.members.length} member(s) from JSON`);
      return this.config;
    } catch (e) {
      log.error("[TeamStore] Failed to load team config from JSON:", e);
      return null;
    }
  }

  /**
   * Merge team from JSON into memory and sync to Postgres (phase 2 migration)
   */
  private async mergeFromJson(jsonConfig: TeamConfig): Promise<void> {
    if (!this.pgStore || !this.shouldWriteToPostgres()) return;

    // Check if the team already exists in Postgres
    const existingTeam = await this.pgStore.getTeamById(jsonConfig.id);
    if (existingTeam) {
      // Team already synced, just merge members that may not be in Postgres
      const existingMembers = await this.pgStore.listMembers(jsonConfig.id);
      const existingUserIds = new Set(existingMembers.map((m) => m.mattermost_user_id));

      let addedCount = 0;
      for (const member of jsonConfig.members) {
        if (!existingUserIds.has(member.userId)) {
          try {
            await this.pgStore.addMember({
              team_id: jsonConfig.id,
              mattermost_user_id: member.userId,
              username: member.username,
              role: member.role === "admin" ? "admin" : "member",
              is_allowed: true,
            });
            addedCount++;
          } catch (e) {
            log.warn(`[TeamStore] Failed to sync member ${member.userId} to Postgres: ${e}`);
          }
        }
      }

      if (addedCount > 0) {
        log.info(`[TeamStore] Merged ${addedCount} members from JSON to Postgres`);
      }
      return;
    }

    // Create the team in Postgres
    try {
      const { team: teamInsert, members: memberInserts } = this.pgStore.fromLocalConfig(jsonConfig);
      await this.pgStore.createTeam(teamInsert);

      for (const memberInsert of memberInserts) {
        await this.pgStore.addMember(memberInsert);
      }

      log.info(`[TeamStore] Synced team "${jsonConfig.name}" with ${memberInserts.length} members from JSON to Postgres`);
    } catch (e) {
      log.error("[TeamStore] Failed to sync team from JSON to Postgres:", e);
    }
  }

  /**
   * Save team configuration to disk
   */
  async save(): Promise<void> {
    if (!this.shouldWriteToJson()) {
      return;
    }

    if (!this.config) {
      log.warn("[TeamStore] No config to save");
      return;
    }

    try {
      const data: TeamConfigFile = {
        version: 1,
        team: {
          ...this.config,
          updatedAt: new Date().toISOString(),
        },
      };

      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      writeFileSync(tempPath, JSON.stringify(data, null, 2));
      renameSync(tempPath, this.filePath);
      log.debug(`[TeamStore] Saved team config with ${this.config.members.length} member(s) to JSON`);
    } catch (e) {
      log.error("[TeamStore] Failed to save team config:", e);
    }
  }

  /**
   * Schedule a debounced save
   */
  scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.save().catch((e) => log.error("[TeamStore] Debounced save failed:", e));
    }, this.saveDebounceMs);
  }

  private rebuildCache(): void {
    this.memberCache.clear();
    if (this.config) {
      for (const member of this.config.members) {
        this.memberCache.add(member.userId);
      }
    }
    this.cacheLastLoaded = Date.now();
  }

  private ensureCacheValid(): void {
    if (Date.now() - this.cacheLastLoaded > this.cacheTtlMs) {
      // For async load, we use loadFromJson synchronously to avoid breaking existing code
      this.loadFromJson();
    }
  }

  /**
   * Invalidate the local cache (call when Realtime event received)
   */
  invalidateCache(): void {
    this.cacheLastLoaded = 0;
    log.debug("[TeamStore] Cache invalidated");
  }

  /**
   * Create a new team with the given owner
   */
  async createTeam(ownerId: string, name: string = "My Team"): Promise<TeamConfig> {
    const now = new Date().toISOString();
    const teamId = this.generateUUID();

    this.config = {
      id: teamId,
      name,
      createdAt: now,
      updatedAt: now,
      ownerId,
      members: [],
      settings: {
        allowMembersToCreateSessions: true,
        allowMembersToApproveGuests: false,
        syncWithMattermostTeam: false,
      },
    };
    this.rebuildCache();

    // Write to Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        const { team: teamInsert } = this.pgStore.fromLocalConfig(this.config);
        await this.pgStore.createTeam(teamInsert);
        log.debug(`[TeamStore] Created team in Postgres: id=${teamId}`);
      } catch (e) {
        log.error("[TeamStore] Failed to create team in Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }

    log.info(`[TeamStore] Created new team "${name}" for owner ${ownerId}`);
    return this.config;
  }

  /**
   * Check if a user is a team member (O(1) lookup with caching)
   */
  isMember(userId: string): boolean {
    this.ensureCacheValid();
    return this.memberCache.has(userId);
  }

  /**
   * Check if a user is the team owner
   */
  isOwner(userId: string): boolean {
    this.ensureCacheValid();
    return this.config?.ownerId === userId;
  }

  /**
   * Check if user has team access (owner OR member)
   */
  hasTeamAccess(userId: string): boolean {
    return this.isOwner(userId) || this.isMember(userId);
  }

  /**
   * Add a member to the team
   */
  async addMember(userId: string, username: string, addedBy: string, role: "member" | "admin" = "member"): Promise<boolean> {
    if (!this.config) {
      log.warn("[TeamStore] Cannot add member - no team exists");
      return false;
    }

    // Don't add if already a member
    if (this.memberCache.has(userId)) {
      log.debug(`[TeamStore] User ${userId} is already a team member`);
      return false;
    }

    // Don't add the owner
    if (this.config.ownerId === userId) {
      log.debug(`[TeamStore] Cannot add owner ${userId} as member`);
      return false;
    }

    const member: TeamMember = {
      userId,
      username,
      addedAt: new Date().toISOString(),
      addedBy,
      role,
    };

    this.config.members.push(member);
    this.memberCache.add(userId);

    // Write to Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.addMember({
          team_id: this.config.id,
          mattermost_user_id: userId,
          username,
          role: role === "admin" ? "admin" : "member",
          is_allowed: true,
        });
        log.debug(`[TeamStore] Added member to Postgres: userId=${userId}`);
      } catch (e) {
        log.error("[TeamStore] Failed to add member to Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }

    log.info(`[TeamStore] Added @${username} (${userId}) to team`);
    return true;
  }

  /**
   * Remove a member from the team
   */
  async removeMember(userId: string): Promise<boolean> {
    if (!this.config) {
      return false;
    }

    const index = this.config.members.findIndex((m) => m.userId === userId);
    if (index === -1) {
      return false;
    }

    const removed = this.config.members.splice(index, 1)[0];
    this.memberCache.delete(userId);

    // Remove from Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.removeMember(this.config.id, userId);
        log.debug(`[TeamStore] Removed member from Postgres: userId=${userId}`);
      } catch (e) {
        log.error("[TeamStore] Failed to remove member from Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }

    log.info(`[TeamStore] Removed @${removed.username} (${userId}) from team`);
    return true;
  }

  /**
   * Get all team members
   */
  getMembers(): TeamMember[] {
    this.ensureCacheValid();
    return this.config?.members || [];
  }

  /**
   * Get a specific member by user ID
   */
  getMember(userId: string): TeamMember | null {
    this.ensureCacheValid();
    return this.config?.members.find((m) => m.userId === userId) || null;
  }

  /**
   * Clear all members from the team
   */
  async clearMembers(): Promise<number> {
    if (!this.config) {
      return 0;
    }

    const count = this.config.members.length;
    this.config.members = [];
    this.memberCache.clear();

    // Clear from Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.clearMembers(this.config.id);
        log.debug(`[TeamStore] Cleared ${count} members from Postgres`);
      } catch (e) {
        log.error("[TeamStore] Failed to clear members from Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }

    log.info(`[TeamStore] Cleared ${count} member(s) from team`);
    return count;
  }

  /**
   * Update team settings
   */
  async updateSettings(settings: Partial<TeamSettings>): Promise<void> {
    if (!this.config) {
      return;
    }

    this.config.settings = { ...this.config.settings, ...settings };

    // Update in Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.updateTeam(this.config.id, {
          settings: {
            ownerId: this.config.ownerId,
            ...this.config.settings,
          },
        });
        log.debug(`[TeamStore] Updated team settings in Postgres`);
      } catch (e) {
        log.error("[TeamStore] Failed to update settings in Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }

    log.debug(`[TeamStore] Updated team settings`);
  }

  /**
   * Get team configuration
   */
  getConfig(): TeamConfig | null {
    this.ensureCacheValid();
    return this.config;
  }

  /**
   * Get team settings
   */
  getSettings(): TeamSettings | null {
    this.ensureCacheValid();
    return this.config?.settings || null;
  }

  /**
   * Check if team exists
   */
  hasTeam(): boolean {
    this.ensureCacheValid();
    return this.config !== null;
  }

  /**
   * Get member count
   */
  getMemberCount(): number {
    this.ensureCacheValid();
    return this.config?.members.length || 0;
  }

  /**
   * Update owner ID (for when MATTERMOST_OWNER_USER_ID changes)
   */
  async updateOwnerId(newOwnerId: string): Promise<void> {
    if (!this.config) {
      return;
    }

    const oldOwnerId = this.config.ownerId;
    this.config.ownerId = newOwnerId;

    // Remove new owner from members if they were a member
    await this.removeMember(newOwnerId);

    // Update in Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.updateTeam(this.config.id, {
          settings: {
            ownerId: newOwnerId,
            ...this.config.settings,
          },
        });
        log.debug(`[TeamStore] Updated team owner in Postgres`);
      } catch (e) {
        log.error("[TeamStore] Failed to update owner in Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }

    log.info(`[TeamStore] Updated team owner from ${oldOwnerId} to ${newOwnerId}`);
  }

  /**
   * Rename the team
   */
  async setTeamName(name: string): Promise<void> {
    if (!this.config) {
      return;
    }
    this.config.name = name;

    // Update in Postgres if enabled
    if (this.shouldWriteToPostgres() && this.pgStore) {
      try {
        await this.pgStore.updateTeam(this.config.id, {
          team_name: name,
        });
        log.debug(`[TeamStore] Updated team name in Postgres`);
      } catch (e) {
        log.error("[TeamStore] Failed to update team name in Postgres:", e);
        this.unifiedStore?.getDegradedModeManager().enter(String(e));
      }
    }

    if (this.shouldWriteToJson()) {
      this.scheduleSave();
    }

    log.debug(`[TeamStore] Renamed team to "${name}"`);
  }

  /**
   * Shutdown - save any pending changes
   */
  async shutdown(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    if (this.config) {
      await this.save();
    }
  }

  /**
   * Get the Postgres store instance (for advanced operations)
   */
  getPgStore(): TeamPgStore | null {
    return this.pgStore;
  }

  /**
   * Generate a simple UUID v4
   */
  private generateUUID(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
