import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { PluginState } from "../state.js";
import { MattermostClient } from "../../../../src/clients/mattermost-client.js";
import { MonitorService, type MonitoredSession } from "../../../../src/monitor-service.js";
import { loadConfig } from "../../../../src/config.js";
import { log } from "../../../../src/logger.js";

export interface MonitorContext {
  client: any;
  directory: string;
  projectName: string;
}

export function createMonitorTool(ctx: MonitorContext): ToolDefinition {
  return tool({
    description: "Monitor an OpenCode session for events (permission requests, idle, questions). Sends DM alerts when the session needs attention.",
    args: {
      sessionId: tool.schema.string().optional().describe("Session ID to monitor. Defaults to current session if not specified."),
      targetUser: tool.schema.string().optional().describe("Mattermost username to notify (required if not connected to Mattermost)."),
      persistent: tool.schema.boolean().optional().describe("Keep monitoring after each alert (default: true). Set to false for one-time alerts."),
    },
    async execute(args) {
      const config = loadConfig();

      if (!config.mattermost.token) {
        return "MATTERMOST_TOKEN environment variable is required.";
      }

      if (config.mattermost.baseUrl.includes("your-mattermost-instance.example.com")) {
        return "MATTERMOST_URL environment variable is required.";
      }

      let targetSessionId = args.sessionId;
      let targetProjectName = ctx.projectName;
      let targetDirectory = ctx.directory;
      let targetSessionTitle: string | undefined;

      if (!targetSessionId) {
        targetSessionId = await resolveCurrentSession(ctx.client, ctx.directory);
      } else if (PluginState.openCodeSessionRegistry) {
        const session = PluginState.openCodeSessionRegistry.get(targetSessionId);
        if (session) {
          targetSessionId = session.id;
          targetProjectName = session.projectName;
          targetDirectory = session.directory;
        }
      }

      if (!targetSessionId) {
        return "No session ID provided and could not determine current session.";
      }

      try {
        const sessionDetails = await ctx.client.session.get({ path: { id: targetSessionId } });
        if (sessionDetails.data) {
          targetSessionTitle = sessionDetails.data.title;
        }
      } catch (e) {
        log.debug(`[Monitor] Could not fetch session details: ${e}`);
      }

      if (MonitorService.isMonitored(targetSessionId)) {
        return `Session ${targetSessionId.substring(0, 8)} is already being monitored.`;
      }

      let mattermostUserId: string;
      let mattermostUsername: string;

      if (args.targetUser) {
        try {
          const tempClient = new MattermostClient(config.mattermost);
          const user = await tempClient.getUserByUsername(args.targetUser.replace(/^@/, ""));
          mattermostUserId = user.id;
          mattermostUsername = user.username;
        } catch (e) {
          return `Could not find Mattermost user: ${args.targetUser}`;
        }
      } else if (PluginState.botUser) {
        mattermostUserId = PluginState.botUser.id;
        mattermostUsername = PluginState.botUser.username;
      } else {
        return "targetUser is required when not connected to Mattermost. Specify the Mattermost username to notify.";
      }

      const isPersistent = args.persistent !== false;
      
      const monitoredSession: MonitoredSession = {
        sessionId: targetSessionId,
        shortId: targetSessionId.substring(0, 8),
        mattermostUserId,
        mattermostUsername,
        projectName: targetProjectName,
        sessionTitle: targetSessionTitle,
        directory: targetDirectory,
        registeredAt: new Date(),
        persistent: isPersistent,
      };

      MonitorService.register(monitoredSession);

      const modeText = isPersistent 
        ? "_Persistent monitoring enabled. Use `mattermost_unmonitor` to stop._"
        : "_One-time alert. After notification, monitoring stops._";
      
      return `Monitoring session ${monitoredSession.shortId} (${targetProjectName})\nWill alert @${mattermostUsername} on permission request, idle, or question\n\n${modeText}`;
    },
  });
}

export function createUnmonitorTool(client: any): ToolDefinition {
  return tool({
    description: "Stop monitoring an OpenCode session. Stops all alerts for the specified or current session.",
    args: {
      sessionId: tool.schema.string().optional().describe("Session ID to stop monitoring. Defaults to current session if not specified."),
    },
    async execute(args) {
      let targetSessionId = args.sessionId;
      
      if (!targetSessionId) {
        try {
          const statusResult = await client.session.status();
          const statusMap = statusResult.data as Record<string, { type: string }> | undefined;
          if (statusMap && Object.keys(statusMap).length > 0) {
            const activeSessionIds = Object.keys(statusMap);
            const busySessionId = activeSessionIds.find(id => statusMap[id]?.type === 'busy');
            targetSessionId = busySessionId || activeSessionIds[0];
          }
        } catch (e) {
          log.warn("Failed to get session status:", e);
        }
      }
      
      if (!targetSessionId) {
        return "No session ID provided and could not determine current session.";
      }
      
      if (!MonitorService.isMonitored(targetSessionId)) {
        return `Session ${targetSessionId.substring(0, 8)} is not being monitored.`;
      }
      
      MonitorService.unregister(targetSessionId);
      return `Stopped monitoring session ${targetSessionId.substring(0, 8)}`;
    },
  });
}

async function resolveCurrentSession(client: any, directory: string): Promise<string | undefined> {
  if (PluginState.openCodeSessionRegistry) {
    const defaultSession = PluginState.openCodeSessionRegistry.getDefault();
    if (defaultSession) {
      return defaultSession.id;
    }
  }
  
  try {
    const statusResult = await client.session.status();
    const statusMap = statusResult.data as Record<string, { type: string }> | undefined;
    
    if (statusMap && Object.keys(statusMap).length > 0) {
      const activeSessionIds = Object.keys(statusMap);
      const busySessionId = activeSessionIds.find(id => statusMap[id]?.type === 'busy');
      return busySessionId || activeSessionIds[0];
    }
    
    const sessions = await client.session.list();
    if (sessions.data && sessions.data.length > 0) {
      const sortedSessions = [...sessions.data]
        .filter((s: any) => s.directory === directory)
        .sort((a: any, b: any) => {
          const timeA = a.time?.updated || a.time?.created || 0;
          const timeB = b.time?.updated || b.time?.created || 0;
          return timeB - timeA;
        });
      
      const currentSession = sortedSessions[0] || sessions.data[0];
      return currentSession.id;
    }
  } catch (e) {
    log.warn("Failed to get session:", e);
  }
  
  return undefined;
}
