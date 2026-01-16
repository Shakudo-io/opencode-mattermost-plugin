import type { MattermostClient } from "./clients/mattermost-client.js";
import type { ThreadSessionMapping, ThreadRootPostContent } from "./models/index.js";
import type { ThreadMappingStore } from "./persistence/thread-mapping-store.js";
import type { OpenCodeSessionInfo } from "./opencode-session-registry.js";
import { log } from "./logger.js";

export class ThreadManager {
  private mmClient: MattermostClient;
  private store: ThreadMappingStore;

  constructor(mmClient: MattermostClient, store: ThreadMappingStore) {
    this.mmClient = mmClient;
    this.store = store;
  }

  async createThread(
    sessionInfo: OpenCodeSessionInfo,
    mattermostUserId: string,
    dmChannelId: string
  ): Promise<ThreadSessionMapping> {
    const existing = this.store.getBySessionId(sessionInfo.id);
    if (existing) {
      log.debug(`[ThreadManager] Thread already exists for session ${sessionInfo.shortId}`);
      return existing;
    }

    const content: ThreadRootPostContent = {
      projectName: sessionInfo.projectName,
      directory: sessionInfo.directory,
      sessionId: sessionInfo.id,
      shortId: sessionInfo.shortId,
      startedAt: new Date(),
      sessionTitle: sessionInfo.title,
    };

    const message = this.formatThreadRootPost(content);

    let rootPost;
    try {
      rootPost = await this.mmClient.createPost(dmChannelId, message);
    } catch (e) {
      log.warn(`[ThreadManager] First attempt failed, retrying...`);
      rootPost = await this.mmClient.createPost(dmChannelId, message);
    }

    const mapping: ThreadSessionMapping = {
      sessionId: sessionInfo.id,
      threadRootPostId: rootPost.id,
      shortId: sessionInfo.shortId,
      mattermostUserId,
      dmChannelId,
      projectName: sessionInfo.projectName,
      directory: sessionInfo.directory,
      sessionTitle: sessionInfo.title,
      status: "active",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    try {
      this.store.add(mapping);
    } catch (e) {
      log.error(`[ThreadManager] Failed to persist mapping, continuing in-memory:`, e);
    }

    log.info(`[ThreadManager] Created thread for session ${sessionInfo.shortId} (${sessionInfo.projectName})`);
    return mapping;
  }

  async endThread(sessionId: string): Promise<void> {
    const mapping = this.store.getBySessionId(sessionId);
    if (!mapping) {
      log.debug(`[ThreadManager] No mapping found for session ${sessionId}`);
      return;
    }

    if (mapping.status === "ended") {
      return;
    }

    const now = new Date();
    const duration = this.formatDuration(new Date(mapping.createdAt), now);
    const message = this.formatSessionEndedPost(duration, now);

    try {
      await this.mmClient.createPost(mapping.dmChannelId, message, mapping.threadRootPostId);
    } catch (e) {
      log.error(`[ThreadManager] Failed to post session ended message:`, e);
    }

    mapping.status = "ended";
    mapping.endedAt = now.toISOString();
    mapping.lastActivityAt = now.toISOString();
    this.store.update(mapping);

    log.info(`[ThreadManager] Ended thread for session ${mapping.shortId}`);
  }

  async reconnectThread(sessionId: string): Promise<ThreadSessionMapping | null> {
    const mapping = this.store.getBySessionId(sessionId);
    if (!mapping) {
      return null;
    }

    if (mapping.status === "disconnected") {
      mapping.status = "active";
      mapping.lastActivityAt = new Date().toISOString();
      this.store.update(mapping);

      try {
        await this.mmClient.createPost(
          mapping.dmChannelId,
          ":arrows_counterclockwise: **Session reconnected**",
          mapping.threadRootPostId
        );
      } catch (e) {
        log.warn(`[ThreadManager] Failed to post reconnect message:`, e);
      }

      log.info(`[ThreadManager] Reconnected thread for session ${mapping.shortId}`);
    }

    return mapping;
  }

  markDisconnected(sessionId: string): void {
    const mapping = this.store.getBySessionId(sessionId);
    if (!mapping || mapping.status !== "active") {
      return;
    }

    mapping.status = "disconnected";
    mapping.lastActivityAt = new Date().toISOString();
    this.store.update(mapping);

    log.info(`[ThreadManager] Marked session ${mapping.shortId} as disconnected`);
  }

  getMapping(sessionId: string): ThreadSessionMapping | null {
    return this.store.getBySessionId(sessionId);
  }

  getMappingByThreadId(threadRootPostId: string): ThreadSessionMapping | null {
    return this.store.getByThreadRootPostId(threadRootPostId);
  }

  updateActivity(sessionId: string): void {
    const mapping = this.store.getBySessionId(sessionId);
    if (mapping) {
      mapping.lastActivityAt = new Date().toISOString();
      this.store.update(mapping);
    }
  }

  private formatThreadRootPost(content: ThreadRootPostContent): string {
    const lines = [
      `:rocket: **OpenCode Session Started**`,
      ``,
      `**Project**: ${content.projectName}`,
      `**Directory**: ${content.directory}`,
      `**Session**: ${content.shortId}`,
      `**Started**: ${content.startedAt.toISOString()}`,
    ];

    if (content.sessionTitle) {
      lines.splice(2, 0, `**Title**: ${content.sessionTitle}`);
    }

    lines.push(``, `_Reply in this thread to send prompts to this session._`);

    return lines.join("\n");
  }

  private formatSessionEndedPost(duration: string, endedAt: Date): string {
    return [
      `:checkered_flag: **Session Ended**`,
      ``,
      `**Duration**: ${duration}`,
      `**Ended**: ${endedAt.toISOString()}`,
      ``,
      `_This thread is now read-only. Start a new session for a new thread._`,
    ].join("\n");
  }

  private formatDuration(start: Date, end: Date): string {
    const ms = end.getTime() - start.getTime();
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) {
      return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) {
      return `${hours} hour${hours !== 1 ? "s" : ""} ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}`;
    }
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days} day${days !== 1 ? "s" : ""} ${remainingHours} hour${remainingHours !== 1 ? "s" : ""}`;
  }
}
