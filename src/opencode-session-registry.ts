import { log } from "./logger.js";

/**
 * Information about an available OpenCode session
 */
export interface OpenCodeSessionInfo {
  id: string;
  projectName: string;
  directory: string;
  shortId: string;
  title: string;
  lastUpdated: Date;
  isAvailable: boolean;
}

/**
 * OpenCode SDK Session type (matches SDK types.gen.d.ts Session type)
 */
export interface OpenCodeSession {
  id: string;
  slug?: string;
  projectID?: string;
  directory: string;
  parentID?: string;
  title?: string;
  time: {
    created: number;
    updated: number;
  };
}

/**
 * Interface for OpenCode client session operations
 */
export interface OpenCodeClientSession {
  list(): Promise<{ data: OpenCodeSession[] | undefined }>;
}

/**
 * Registry for tracking available OpenCode sessions.
 * Provides session discovery, lookup, and availability tracking.
 */
export class OpenCodeSessionRegistry {
  private sessions: Map<string, OpenCodeSessionInfo> = new Map();
  private defaultSessionId: string | null = null;
  private refreshIntervalMs: number;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private client: OpenCodeClientSession | null = null;

  constructor(refreshIntervalMs: number = 60000) {
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Initialize the registry with an OpenCode client
   */
  initialize(client: OpenCodeClientSession): void {
    this.client = client;
  }

  /**
   * Start automatic background refresh of session list
   */
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    
    this.refreshTimer = setInterval(async () => {
      try {
        await this.refresh();
      } catch (e) {
        log.error("[OpenCodeSessionRegistry] Auto-refresh failed:", e);
      }
    }, this.refreshIntervalMs);
    
    log.debug(`[OpenCodeSessionRegistry] Auto-refresh started (interval: ${this.refreshIntervalMs}ms)`);
  }

  /**
   * Stop automatic background refresh
   */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      log.debug("[OpenCodeSessionRegistry] Auto-refresh stopped");
    }
  }

  /**
   * Refresh the session list from OpenCode API
   */
  async refresh(): Promise<void> {
    if (!this.client) {
      throw new Error("Registry not initialized - call initialize() first");
    }

    try {
      const result = await this.client.list();
      const sessions = result.data;

      if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
        log.debug("[OpenCodeSessionRegistry] No sessions found");
        this.sessions.clear();
        this.defaultSessionId = null;
        return;
      }

      const currentIds = new Set<string>();

      for (const session of sessions) {
        if (session.parentID) {
          continue;
        }
        
        currentIds.add(session.id);
        
        const projectName = this.extractProjectName(session.directory);
        const shortId = session.slug || session.id.substring(0, 8);
        
        const existing = this.sessions.get(session.id);
        
        this.sessions.set(session.id, {
          id: session.id,
          projectName,
          directory: session.directory,
          shortId,
          title: session.title || projectName,
          lastUpdated: new Date(session.time.updated),
          isAvailable: true,
        });

        if (!existing) {
          log.info(`[OpenCodeSessionRegistry] New session discovered: ${shortId} (${projectName})`);
        }
      }

      for (const [id, info] of this.sessions.entries()) {
        if (!currentIds.has(id) && info.isAvailable) {
          info.isAvailable = false;
          log.info(`[OpenCodeSessionRegistry] Session no longer available: ${info.shortId} (${info.projectName})`);
        }
      }

      const available = this.list().filter(s => s.isAvailable);
      if (available.length > 0) {
        const sorted = available.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
        this.defaultSessionId = sorted[0].id;
      } else {
        this.defaultSessionId = null;
      }

      log.debug(`[OpenCodeSessionRegistry] Refreshed: ${available.length} available sessions`);
    } catch (e) {
      log.error("[OpenCodeSessionRegistry] Failed to refresh sessions:", e);
      throw e;
    }
  }

  /**
   * Get all tracked sessions
   */
  list(): OpenCodeSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get all available sessions (excludes unavailable ones)
   */
  listAvailable(): OpenCodeSessionInfo[] {
    return this.list().filter(s => s.isAvailable);
  }

  /**
   * Get session by full ID or short ID (first 6 chars)
   */
  get(idOrShortId: string): OpenCodeSessionInfo | null {
    const exactMatch = this.sessions.get(idOrShortId);
    if (exactMatch) return exactMatch;

    const normalized = idOrShortId.toLowerCase();
    
    for (const session of this.sessions.values()) {
      const matchesShortId = session.shortId.toLowerCase() === normalized;
      const matchesIdPrefix = session.id.toLowerCase().startsWith(normalized);
      if (matchesShortId || matchesIdPrefix) {
        return session;
      }
    }

    for (const session of this.sessions.values()) {
      if (session.projectName.toLowerCase().includes(normalized)) {
        return session;
      }
    }

    return null;
  }

  /**
   * Get the default session (most recently updated available session)
   */
  getDefault(): OpenCodeSessionInfo | null {
    if (!this.defaultSessionId) return null;
    return this.sessions.get(this.defaultSessionId) || null;
  }

  /**
   * Explicitly set the default session
   */
  setDefault(sessionId: string): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    
    this.defaultSessionId = session.id;
    log.info(`[OpenCodeSessionRegistry] Default session set to: ${session.shortId} (${session.projectName})`);
    return true;
  }

  /**
   * Mark a session as unavailable (e.g., when a prompt fails)
   */
  markUnavailable(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isAvailable = false;
      log.info(`[OpenCodeSessionRegistry] Session marked unavailable: ${session.shortId} (${session.projectName})`);
      
      if (this.defaultSessionId === sessionId) {
        const available = this.listAvailable();
        this.defaultSessionId = available.length > 0 ? available[0].id : null;
      }
    }
  }

  handleSessionCreated(session: OpenCodeSession): void {
    if (session.parentID) {
      return;
    }
    
    const projectName = this.extractProjectName(session.directory);
    const shortId = session.slug || session.id.substring(0, 8);
    
    this.sessions.set(session.id, {
      id: session.id,
      projectName,
      directory: session.directory,
      shortId,
      title: session.title || projectName,
      lastUpdated: new Date(session.time.updated),
      isAvailable: true,
    });

    log.info(`[OpenCodeSessionRegistry] Session created: ${shortId} (${projectName})`);

    if (!this.defaultSessionId) {
      this.defaultSessionId = session.id;
    }
  }

  /**
   * Handle session.deleted event from OpenCode
   */
  handleSessionDeleted(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      log.info(`[OpenCodeSessionRegistry] Session deleted: ${session.shortId} (${session.projectName})`);
      
      if (this.defaultSessionId === sessionId) {
        const available = this.listAvailable();
        this.defaultSessionId = available.length > 0 ? available[0].id : null;
      }
    }
  }

  /**
   * Check if a session exists and is available
   */
  isAvailable(sessionId: string): boolean {
    const session = this.get(sessionId);
    return session?.isAvailable ?? false;
  }

  /**
   * Get session count
   */
  count(): number {
    return this.sessions.size;
  }

  /**
   * Get available session count
   */
  countAvailable(): number {
    return this.listAvailable().length;
  }

  /**
   * Clear all sessions (for disconnect)
   */
  clear(): void {
    this.sessions.clear();
    this.defaultSessionId = null;
    this.stopAutoRefresh();
  }

  /**
   * Extract project name from directory path
   */
  private extractProjectName(directory: string): string {
    const parts = directory.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
}
