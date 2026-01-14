import type { MattermostClient } from "./clients/mattermost-client.js";
import type { SessionsConfig } from "./config.js";
import type { Post } from "./models/index.js";
import { log } from "./logger.js";

export interface PermissionRequest {
  id: string;
  tool: string;
  args: Record<string, any>;
  risk: "low" | "medium" | "high";
  description: string;
}

export interface UserSession {
  id: string;
  mattermostUserId: string;
  mattermostUsername: string;
  dmChannelId: string;
  createdAt: Date;
  lastActivityAt: Date;
  isProcessing: boolean;
  currentPromptPostId: string | null;
  currentResponsePostId: string | null;
  pendingPermission: PermissionRequest | null;
  lastPrompt: Post | null;
  targetOpenCodeSessionId: string | null;
}

export class SessionManager {
  private sessions: Map<string, UserSession> = new Map();
  private mmClient: MattermostClient;
  private config: SessionsConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private botUserId: string | null = null;

  constructor(mmClient: MattermostClient, config: SessionsConfig) {
    this.mmClient = mmClient;
    this.config = config;
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000);
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [userId, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() > this.config.timeout) {
        log.debug(`[SessionManager] Cleaning up expired session for user ${session.mattermostUsername}`);
        this.sessions.delete(userId);
      }
    }
  }

  async setBotUserId(botUserId: string): Promise<void> {
    this.botUserId = botUserId;
  }

  async getOrCreateSession(mattermostUserId: string): Promise<UserSession> {
    let session = this.sessions.get(mattermostUserId);
    
    if (session) {
      session.lastActivityAt = new Date();
      return session;
    }

    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(mattermostUserId)) {
      throw new Error("User not authorized to use this plugin");
    }

    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error("Maximum number of sessions reached");
    }

    const user = await this.mmClient.getUserById(mattermostUserId);
    const dmChannel = await this.mmClient.createDirectChannel(mattermostUserId);

    session = {
      id: mattermostUserId,
      mattermostUserId,
      mattermostUsername: user.username,
      dmChannelId: dmChannel.id,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      isProcessing: false,
      currentPromptPostId: null,
      currentResponsePostId: null,
      pendingPermission: null,
      lastPrompt: null,
      targetOpenCodeSessionId: null,
    };

    this.sessions.set(mattermostUserId, session);
    log.info(`[SessionManager] Created session for user ${user.username}`);

    return session;
  }

  getSession(mattermostUserId: string): UserSession | null {
    const session = this.sessions.get(mattermostUserId);
    if (session) {
      session.lastActivityAt = new Date();
    }
    return session || null;
  }

  destroySession(mattermostUserId: string): void {
    const session = this.sessions.get(mattermostUserId);
    if (session) {
      log.debug(`[SessionManager] Destroying session for user ${session.mattermostUsername}`);
      this.sessions.delete(mattermostUserId);
    }
  }

  listSessions(): UserSession[] {
    return Array.from(this.sessions.values());
  }

  getSessionById(sessionId: string): UserSession | null {
    return this.sessions.get(sessionId) || null;
  }

  getSessionByDmChannel(channelId: string): UserSession | null {
    for (const session of this.sessions.values()) {
      if (session.dmChannelId === channelId) {
        return session;
      }
    }
    return null;
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }
}
