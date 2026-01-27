import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { log } from "../logger.js";

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

export class TeamStore {
  private config: TeamConfig | null = null;
  private memberCache: Set<string> = new Set();
  private cacheLastLoaded: number = 0;
  private cacheTtlMs: number = 300000; // 5 minutes default
  private filePath: string;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs: number = 1000;

  constructor(cacheTtlMs?: number) {
    this.filePath = this.resolveFilePath();
    if (cacheTtlMs !== undefined) {
      this.cacheTtlMs = cacheTtlMs;
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

  /**
   * Load team configuration from disk
   */
  load(): TeamConfig | null {
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
      log.info(`[TeamStore] Loaded team "${this.config.name}" with ${this.config.members.length} member(s)`);
      return this.config;
    } catch (e) {
      log.error("[TeamStore] Failed to load team config:", e);
      return null;
    }
  }

  /**
   * Save team configuration to disk
   */
  save(): void {
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
      log.debug(`[TeamStore] Saved team config with ${this.config.members.length} member(s)`);
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
      this.save();
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
      this.load();
    }
  }

  /**
   * Create a new team with the given owner
   */
  createTeam(ownerId: string, name: string = "My Team"): TeamConfig {
    const now = new Date().toISOString();
    this.config = {
      id: this.generateUUID(),
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
    this.scheduleSave();
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
  addMember(userId: string, username: string, addedBy: string, role: "member" | "admin" = "member"): boolean {
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
    this.scheduleSave();
    log.info(`[TeamStore] Added @${username} (${userId}) to team`);
    return true;
  }

  /**
   * Remove a member from the team
   */
  removeMember(userId: string): boolean {
    if (!this.config) {
      return false;
    }

    const index = this.config.members.findIndex((m) => m.userId === userId);
    if (index === -1) {
      return false;
    }

    const removed = this.config.members.splice(index, 1)[0];
    this.memberCache.delete(userId);
    this.scheduleSave();
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
  clearMembers(): number {
    if (!this.config) {
      return 0;
    }

    const count = this.config.members.length;
    this.config.members = [];
    this.memberCache.clear();
    this.scheduleSave();
    log.info(`[TeamStore] Cleared ${count} member(s) from team`);
    return count;
  }

  /**
   * Update team settings
   */
  updateSettings(settings: Partial<TeamSettings>): void {
    if (!this.config) {
      return;
    }

    this.config.settings = { ...this.config.settings, ...settings };
    this.scheduleSave();
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
  updateOwnerId(newOwnerId: string): void {
    if (!this.config) {
      return;
    }

    const oldOwnerId = this.config.ownerId;
    this.config.ownerId = newOwnerId;
    
    // Remove new owner from members if they were a member
    this.removeMember(newOwnerId);
    
    this.scheduleSave();
    log.info(`[TeamStore] Updated team owner from ${oldOwnerId} to ${newOwnerId}`);
  }

  /**
   * Rename the team
   */
  setTeamName(name: string): void {
    if (!this.config) {
      return;
    }
    this.config.name = name;
    this.scheduleSave();
    log.debug(`[TeamStore] Renamed team to "${name}"`);
  }

  /**
   * Shutdown - save any pending changes
   */
  shutdown(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    if (this.config) {
      this.save();
    }
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
