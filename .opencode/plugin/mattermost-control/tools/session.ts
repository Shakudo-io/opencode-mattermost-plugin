import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { PluginState } from "../state.js";
import { log } from "../../../../src/logger.js";

export function createListSessionsTool() {
  return {
    description: "List available OpenCode sessions that can receive prompts from Mattermost",
    args: {},
    async execute() {
      const { isConnected, openCodeSessionRegistry } = PluginState;
      
      if (!isConnected || !openCodeSessionRegistry) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      try {
        await openCodeSessionRegistry.refresh();
      } catch (e) {
        log.warn("Failed to refresh sessions:", e);
      }

      const sessions = openCodeSessionRegistry.listAvailable();
      if (sessions.length === 0) {
        return "No active OpenCode sessions found.";
      }

      const defaultSession = openCodeSessionRegistry.getDefault();
      const lines = sessions.map((s, i) => {
        const isDefault = s.id === defaultSession?.id;
        return `${i + 1}. ${s.projectName} (${s.shortId})${isDefault ? " [default]" : ""}\n   Directory: ${s.directory}`;
      });

      return `Available OpenCode Sessions:\n\n${lines.join("\n\n")}`;
    },
  };
}

export function createSelectSessionTool(): ToolDefinition {
  return tool({
    description: "Select which OpenCode session should receive prompts from a Mattermost user",
    args: {
      sessionId: tool.schema.string().describe("Session ID (full or short 6-char ID) or project name"),
      mattermostUserId: tool.schema.string().optional().describe("Mattermost user ID to set session for (optional, defaults to all users)"),
    },
    async execute(args) {
      const { isConnected, openCodeSessionRegistry, sessionManager } = PluginState;
      
      if (!isConnected || !openCodeSessionRegistry || !sessionManager) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      const session = openCodeSessionRegistry.get(args.sessionId);
      if (!session) {
        return `Session not found: ${args.sessionId}. Use mattermost_list_sessions to see available sessions.`;
      }

      if (!session.isAvailable) {
        return `Session ${session.shortId} (${session.projectName}) is not available.`;
      }

      if (args.mattermostUserId) {
        const userSession = sessionManager.getSession(args.mattermostUserId);
        if (userSession) {
          userSession.targetOpenCodeSessionId = session.id;
          return `Set session ${session.shortId} (${session.projectName}) as target for Mattermost user.`;
        }
        return `Mattermost user session not found. User must DM the bot first.`;
      }

      openCodeSessionRegistry.setDefault(session.id);
      return `Set ${session.shortId} (${session.projectName}) as the default OpenCode session for all Mattermost users.`;
    },
  });
}

export function createCurrentSessionTool(): ToolDefinition {
  return tool({
    description: "Show the currently targeted OpenCode session for a Mattermost user",
    args: {
      mattermostUserId: tool.schema.string().optional().describe("Mattermost user ID to check (optional, shows default if not specified)"),
    },
    async execute(args) {
      const { isConnected, openCodeSessionRegistry, sessionManager } = PluginState;
      
      if (!isConnected || !openCodeSessionRegistry || !sessionManager) {
        return "Not connected to Mattermost. Use mattermost_connect first.";
      }

      if (args.mattermostUserId) {
        const userSession = sessionManager.getSession(args.mattermostUserId);
        if (!userSession) {
          return `No active Mattermost session for user ${args.mattermostUserId}. User must DM the bot first.`;
        }

        const targetId = userSession.targetOpenCodeSessionId;
        if (!targetId) {
          const defaultSession = openCodeSessionRegistry.getDefault();
          if (defaultSession) {
            return `User @${userSession.mattermostUsername} has no explicit session selected.\nUsing default: ${defaultSession.projectName} (${defaultSession.shortId})\nDirectory: ${defaultSession.directory}`;
          }
          return `User @${userSession.mattermostUsername} has no session selected and no default is available.`;
        }

        const session = openCodeSessionRegistry.get(targetId);
        if (!session || !session.isAvailable) {
          return `User @${userSession.mattermostUsername}'s selected session is no longer available.`;
        }

        return `User @${userSession.mattermostUsername} is targeting:\nProject: ${session.projectName}\nID: ${session.shortId}\nDirectory: ${session.directory}\nLast updated: ${session.lastUpdated.toISOString()}`;
      }

      const defaultSession = openCodeSessionRegistry.getDefault();
      if (!defaultSession) {
        return "No default OpenCode session is set. Use mattermost_list_sessions to see available sessions.";
      }

      return `Default OpenCode session:\nProject: ${defaultSession.projectName}\nID: ${defaultSession.shortId}\nDirectory: ${defaultSession.directory}\nLast updated: ${defaultSession.lastUpdated.toISOString()}`;
    },
  });
}
