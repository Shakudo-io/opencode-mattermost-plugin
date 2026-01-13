import type { MattermostClient } from "./clients/mattermost-client.js";
import type { NotificationsConfig } from "./config.js";
import type { UserSession, PermissionRequest } from "./session-manager.js";
import { log } from "./logger.js";

export type StatusType = "thinking" | "tool_execution" | "waiting" | "idle";

export interface StatusUpdate {
  type: StatusType;
  details?: string;
}

export class NotificationService {
  private mmClient: MattermostClient;
  private config: NotificationsConfig;

  constructor(mmClient: MattermostClient, config: NotificationsConfig) {
    this.mmClient = mmClient;
    this.config = config;
  }

  async notifyCompletion(session: UserSession, summary: string): Promise<void> {
    if (!this.config.onCompletion) return;

    const message = `:white_check_mark: **Task Completed**\n\n> ${summary}`;

    try {
      await this.mmClient.createPost(session.dmChannelId, message);
    } catch (error) {
      log.error("[NotificationService] Failed to send completion notification:", error);
    }
  }

  async notifyPermissionRequest(session: UserSession, request: PermissionRequest): Promise<void> {
    if (!this.config.onPermissionRequest) return;

    const riskEmoji = {
      low: ":large_blue_circle:",
      medium: ":warning:",
      high: ":red_circle:",
    }[request.risk];

    const argsDisplay = JSON.stringify(request.args, null, 2);
    const message = `:warning: **Permission Required**

OpenCode wants to execute:
\`\`\`
${request.tool}(${argsDisplay})
\`\`\`

**Risk Level**: ${request.risk} ${riskEmoji}
**Description**: ${request.description}

React to respond:
- :white_check_mark: Approve
- :x: Deny`;

    try {
      const post = await this.mmClient.createPost(session.dmChannelId, message);
      session.pendingPermission = request;
      session.currentResponsePostId = post.id;
    } catch (error) {
      log.error("[NotificationService] Failed to send permission request:", error);
    }
  }

  async notifyError(session: UserSession, error: Error): Promise<void> {
    if (!this.config.onError) return;

    const message = `:x: **Error Occurred**

\`\`\`
${error.message}
\`\`\`

React :arrows_counterclockwise: to retry or send a new message.`;

    try {
      await this.mmClient.createPost(session.dmChannelId, message);
    } catch (err) {
      log.error("[NotificationService] Failed to send error notification:", err);
    }
  }

  async notifyStatus(session: UserSession, status: StatusUpdate): Promise<void> {
    if (!this.config.onStatusUpdate) return;

    const statusEmoji = {
      thinking: ":thought_balloon:",
      tool_execution: ":hammer_and_wrench:",
      waiting: ":hourglass_flowing_sand:",
      idle: ":zzz:",
    }[status.type];

    const message = `${statusEmoji} **${status.type.replace("_", " ")}**${status.details ? `\n${status.details}` : ""}`;

    try {
      await this.mmClient.createPost(session.dmChannelId, message);
    } catch (error) {
      log.error("[NotificationService] Failed to send status notification:", error);
    }
  }

  async notifySessionTakeover(session: UserSession, newProject: string): Promise<void> {
    const message = `:information_source: **Session Transferred**

Mattermost control has been transferred to another OpenCode instance.
New project: \`${newProject}\`

DMs will now be handled by the new session.`;

    try {
      await this.mmClient.createPost(session.dmChannelId, message);
    } catch (error) {
      log.error("[NotificationService] Failed to send takeover notification:", error);
    }
  }
}
