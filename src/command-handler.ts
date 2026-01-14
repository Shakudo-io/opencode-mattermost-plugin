import type { MattermostClient } from "./clients/mattermost-client.js";
import type { OpenCodeSessionRegistry, OpenCodeSessionInfo } from "./opencode-session-registry.js";
import type { UserSession } from "./session-manager.js";
import type { ParsedCommand } from "./message-router.js";
import { log } from "./logger.js";

export interface CommandContext {
  userSession: UserSession;
  registry: OpenCodeSessionRegistry;
  mmClient: MattermostClient;
}

export type CommandResult = {
  success: boolean;
  message: string;
};

type CommandExecutor = (
  command: ParsedCommand,
  context: CommandContext
) => Promise<CommandResult>;

export class CommandHandler {
  private commands: Map<string, CommandExecutor> = new Map();
  private commandPrefix: string;

  constructor(commandPrefix: string = "!") {
    this.commandPrefix = commandPrefix;
    this.registerBuiltinCommands();
  }

  private registerBuiltinCommands(): void {
    this.commands.set("sessions", this.handleSessions.bind(this));
    this.commands.set("use", this.handleUse.bind(this));
    this.commands.set("current", this.handleCurrent.bind(this));
    this.commands.set("help", this.handleHelp.bind(this));
  }

  async execute(command: ParsedCommand, context: CommandContext): Promise<CommandResult> {
    const executor = this.commands.get(command.name);
    
    if (!executor) {
      return {
        success: false,
        message: `Unknown command: \`${this.commandPrefix}${command.name}\`\n\nType \`${this.commandPrefix}help\` for available commands.`,
      };
    }

    try {
      return await executor(command, context);
    } catch (e) {
      log.error(`[CommandHandler] Error executing command ${command.name}:`, e);
      return {
        success: false,
        message: `Error executing command: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private async handleSessions(
    _command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { registry, userSession } = context;
    
    try {
      await registry.refresh();
    } catch (e) {
      log.warn("[CommandHandler] Failed to refresh sessions:", e);
    }

    const sessions = registry.listAvailable();
    
    if (sessions.length === 0) {
      return {
        success: true,
        message: "No active OpenCode sessions found.\n\nStart OpenCode in a project directory to create a session.",
      };
    }

    const currentTarget = userSession.targetOpenCodeSessionId;
    const lines = this.formatSessionList(sessions, currentTarget);

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private formatSessionList(sessions: OpenCodeSessionInfo[], currentTargetId: string | null): string[] {
    const defaultSession = sessions.find(s => s.id === currentTargetId);
    
    const lines: string[] = [
      ":clipboard: **Available OpenCode Sessions:**",
      "",
    ];

    sessions.forEach((session, index) => {
      const isCurrent = session.id === currentTargetId;
      const marker = isCurrent ? " :white_check_mark:" : "";
      const truncatedTitle = this.truncateString(session.title, 50);
      const relativeTime = this.formatRelativeTime(session.lastUpdated);
      
      lines.push(`**${index + 1}.** \`${session.shortId}\`${marker}`);
      lines.push(`   ${truncatedTitle}`);
      lines.push(`   _${session.projectName}_ • ${relativeTime}`);
      lines.push("");
    });

    if (defaultSession) {
      lines.push(`:white_check_mark: = current target (\`${defaultSession.shortId}\`)`);
    }
    lines.push("");
    lines.push(`**Commands:** \`${this.commandPrefix}use <id>\` to switch, \`${this.commandPrefix}current\` for details`);

    return lines;
  }

  private truncateString(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + "...";
  }

  private formatRelativeTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  private truncateDirectory(dir: string, maxLen: number): string {
    if (dir.length <= maxLen) return dir;
    return "..." + dir.slice(-(maxLen - 3));
  }

  private async handleUse(
    command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { registry, userSession } = context;
    const targetId = command.rawArgs.trim();

    if (!targetId) {
      return {
        success: false,
        message: `Usage: \`${this.commandPrefix}use <session-id>\`\n\nUse \`${this.commandPrefix}sessions\` to see available sessions.`,
      };
    }

    const session = registry.get(targetId);
    
    if (!session) {
      return {
        success: false,
        message: `Session not found: \`${targetId}\`\n\nUse \`${this.commandPrefix}sessions\` to see available sessions.`,
      };
    }

    if (!session.isAvailable) {
      return {
        success: false,
        message: `Session \`${session.shortId}\` (${session.projectName}) is no longer available.\n\nUse \`${this.commandPrefix}sessions\` to see current sessions.`,
      };
    }

    userSession.targetOpenCodeSessionId = session.id;
    log.info(`[CommandHandler] User ${userSession.mattermostUsername} switched to session ${session.shortId} (${session.projectName})`);

    return {
      success: true,
      message: [
        `:white_check_mark: **Session Changed**`,
        "",
        `Now targeting: **${session.projectName}** (\`${session.shortId}\`)`,
        `Directory: \`${session.directory}\``,
        "",
        "All your prompts will go to this session.",
      ].join("\n"),
    };
  }

  private async handleCurrent(
    _command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { registry, userSession } = context;
    const targetId = userSession.targetOpenCodeSessionId;

    if (!targetId) {
      const defaultSession = registry.getDefault();
      if (defaultSession) {
        return {
          success: true,
          message: [
            `:information_source: **No explicit session selected**`,
            "",
            `Using default: **${defaultSession.projectName}** (\`${defaultSession.shortId}\`)`,
            "",
            `Use \`${this.commandPrefix}use <id>\` to select a specific session.`,
          ].join("\n"),
        };
      }
      return {
        success: true,
        message: `No session selected and no default available.\n\nUse \`${this.commandPrefix}sessions\` to see available sessions.`,
      };
    }

    const session = registry.get(targetId);
    
    if (!session || !session.isAvailable) {
      userSession.targetOpenCodeSessionId = null;
      return {
        success: false,
        message: `:warning: Previously selected session is no longer available.\n\nUse \`${this.commandPrefix}sessions\` to select a new one.`,
      };
    }

    return {
      success: true,
      message: [
        `:dart: **Current Session**`,
        "",
        `Project: **${session.projectName}**`,
        `ID: \`${session.shortId}\``,
        `Directory: \`${session.directory}\``,
        `Last updated: ${session.lastUpdated.toISOString()}`,
      ].join("\n"),
    };
  }

  private async handleHelp(
    _command: ParsedCommand,
    _context: CommandContext
  ): Promise<CommandResult> {
    return {
      success: true,
      message: [
        `:question: **Available Commands**`,
        "",
        `| Command | Description |`,
        `|---------|-------------|`,
        `| \`${this.commandPrefix}sessions\` | List available OpenCode sessions |`,
        `| \`${this.commandPrefix}use <id>\` | Switch to a different session |`,
        `| \`${this.commandPrefix}current\` | Show currently targeted session |`,
        `| \`${this.commandPrefix}help\` | Show this help message |`,
        "",
        "Any message not starting with `" + this.commandPrefix + "` is sent as a prompt to OpenCode.",
      ].join("\n"),
    };
  }

  isKnownCommand(name: string): boolean {
    return this.commands.has(name);
  }

  getAvailableCommands(): string[] {
    return Array.from(this.commands.keys());
  }
}
