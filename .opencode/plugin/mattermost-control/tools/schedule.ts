import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { PluginState } from "../state.js";
import { MattermostClient } from "../../../../src/clients/mattermost-client.js";
import { getSchedulerService } from "../../../../src/scheduler/scheduler-service.js";
import { loadConfig } from "../../../../src/config.js";
import { log } from "../../../../src/logger.js";

export interface ScheduleToolContext {
  client: any;
  directory: string;
  projectName: string;
}

export function createScheduleAddTool(ctx: ScheduleToolContext): ToolDefinition {
  return tool({
    description: "Create a scheduled task that runs a prompt at specified times and DMs you the response. The prompt is injected into the current session at each scheduled time.",
    args: {
      name: tool.schema.string().describe("Unique name for this schedule (e.g., 'morning-todos', 'pr-check')"),
      cron: tool.schema.string().describe("Cron expression for when to run (e.g., '0 8,20 * * *' for 8am and 8pm, '0 */4 * * *' for every 4 hours)"),
      prompt: tool.schema.string().describe("The prompt to send to the LLM at each scheduled time"),
      timezone: tool.schema.string().optional().describe("Timezone for the schedule (default: UTC). Examples: 'America/New_York', 'Europe/London'"),
      targetUser: tool.schema.string().optional().describe("Mattermost username to DM results to. Defaults to current user if connected."),
    },
    async execute(args) {
      const config = loadConfig();
      const scheduler = getSchedulerService();

      if (!config.mattermost.token) {
        return "MATTERMOST_TOKEN environment variable is required.";
      }

      let sessionId: string | undefined;
      
      if (PluginState.openCodeSessionRegistry) {
        const defaultSession = PluginState.openCodeSessionRegistry.getDefault();
        if (defaultSession) {
          sessionId = defaultSession.id;
        }
      }
      
      if (!sessionId) {
        try {
          const sessions = await ctx.client.session.list();
          if (sessions.data && sessions.data.length > 0) {
            const dirSessions = sessions.data.filter((s: any) => s.directory === ctx.directory);
            const session = dirSessions[0] || sessions.data[0];
            sessionId = session.id;
          }
        } catch (e) {
          log.warn("[ScheduleTool] Failed to get session:", e);
        }
      }

      if (!sessionId) {
        return "Could not determine current session. Please ensure an OpenCode session is active.";
      }

      let targetUserId: string;
      let targetUsername: string;

      if (args.targetUser) {
        try {
          const tempClient = new MattermostClient(config.mattermost);
          const user = await tempClient.getUserByUsername(args.targetUser.replace(/^@/, ""));
          targetUserId = user.id;
          targetUsername = user.username;
        } catch (e) {
          return `Could not find Mattermost user: ${args.targetUser}`;
        }
      } else if (PluginState.sessionManager) {
        const sessions = Array.from((PluginState.sessionManager as any).sessions?.values() || []);
        const userSession = sessions[0] as any;
        if (userSession) {
          targetUserId = userSession.mattermostUserId;
          targetUsername = userSession.mattermostUsername;
        } else {
          return "No user session found. Please specify targetUser or ensure you're connected via Mattermost.";
        }
      } else {
        return "targetUser is required when session manager is not available.";
      }

      try {
        const schedule = await scheduler.addSchedule({
          name: args.name,
          cron: args.cron,
          timezone: args.timezone,
          prompt: args.prompt,
          sessionId,
          targetUserId,
          targetUsername,
        });

        const lines = [
          `Schedule created: **${schedule.name}**`,
          "",
          `| Property | Value |`,
          `|----------|-------|`,
          `| Cron | \`${schedule.cron}\` |`,
          `| Timezone | ${schedule.timezone} |`,
          `| Session | \`${schedule.sessionId.slice(0, 8)}\` |`,
          `| Notify | @${schedule.targetUsername} |`,
          "",
          `**Prompt:** ${schedule.prompt.slice(0, 100)}${schedule.prompt.length > 100 ? "..." : ""}`,
        ];

        return lines.join("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Failed to create schedule: ${msg}`;
      }
    },
  });
}

export function createScheduleListTool(): ToolDefinition {
  return tool({
    description: "List all scheduled tasks with their status and next run time.",
    args: {},
    async execute() {
      const scheduler = getSchedulerService();
      const schedules = scheduler.listSchedules();

      if (schedules.length === 0) {
        return "No schedules configured. Use `mattermost_schedule_add` to create one.";
      }

      const lines = [
        `**Scheduled Tasks (${schedules.length})**`,
        "",
        "| Name | Cron | Status | Last Run | Notify |",
        "|------|------|--------|----------|--------|",
      ];

      for (const s of schedules) {
        const status = s.enabled ? (scheduler.isRunning(s.id) ? ":green_circle: Active" : ":yellow_circle: Pending") : ":red_circle: Disabled";
        const lastRun = s.lastRunAt 
          ? new Date(s.lastRunAt).toLocaleString() + (s.lastRunSuccess === false ? " :x:" : " :white_check_mark:")
          : "Never";
        lines.push(`| ${s.name} | \`${s.cron}\` | ${status} | ${lastRun} | @${s.targetUsername} |`);
      }

      return lines.join("\n");
    },
  });
}

export function createScheduleRemoveTool(): ToolDefinition {
  return tool({
    description: "Remove a scheduled task by name or ID.",
    args: {
      name: tool.schema.string().describe("Name or ID of the schedule to remove"),
    },
    async execute(args) {
      const scheduler = getSchedulerService();
      
      let removed = scheduler.removeScheduleByName(args.name);
      if (!removed) {
        removed = scheduler.removeSchedule(args.name);
      }

      if (removed) {
        return `Schedule "${args.name}" removed.`;
      } else {
        return `Schedule "${args.name}" not found.`;
      }
    },
  });
}

export function createScheduleEnableTool(): ToolDefinition {
  return tool({
    description: "Enable a disabled scheduled task.",
    args: {
      name: tool.schema.string().describe("Name or ID of the schedule to enable"),
    },
    async execute(args) {
      const scheduler = getSchedulerService();
      
      let schedule = scheduler.getScheduleByName(args.name);
      if (!schedule) {
        schedule = scheduler.getSchedule(args.name);
      }

      if (!schedule) {
        return `Schedule "${args.name}" not found.`;
      }

      if (schedule.enabled) {
        return `Schedule "${schedule.name}" is already enabled.`;
      }

      scheduler.enableSchedule(schedule.id);
      return `Schedule "${schedule.name}" enabled.`;
    },
  });
}

export function createScheduleDisableTool(): ToolDefinition {
  return tool({
    description: "Disable a scheduled task without deleting it.",
    args: {
      name: tool.schema.string().describe("Name or ID of the schedule to disable"),
    },
    async execute(args) {
      const scheduler = getSchedulerService();
      
      let schedule = scheduler.getScheduleByName(args.name);
      if (!schedule) {
        schedule = scheduler.getSchedule(args.name);
      }

      if (!schedule) {
        return `Schedule "${args.name}" not found.`;
      }

      if (!schedule.enabled) {
        return `Schedule "${schedule.name}" is already disabled.`;
      }

      scheduler.disableSchedule(schedule.id);
      return `Schedule "${schedule.name}" disabled.`;
    },
  });
}

export function createScheduleRunTool(): ToolDefinition {
  return tool({
    description: "Run a scheduled task immediately for testing purposes.",
    args: {
      name: tool.schema.string().describe("Name or ID of the schedule to run"),
    },
    async execute(args) {
      const scheduler = getSchedulerService();
      
      let schedule = scheduler.getScheduleByName(args.name);
      if (!schedule) {
        schedule = scheduler.getSchedule(args.name);
      }

      if (!schedule) {
        return `Schedule "${args.name}" not found.`;
      }

      const ran = await scheduler.runNow(schedule.id);
      if (ran) {
        return `Schedule "${schedule.name}" executed. Check your Mattermost DMs for the result.`;
      } else {
        return `Failed to execute schedule "${schedule.name}".`;
      }
    },
  });
}
