import type { MattermostClient } from "./clients/mattermost-client.js";
import type { OpenCodeSessionRegistry, OpenCodeSessionInfo } from "./opencode-session-registry.js";
import type { UserSession } from "./session-manager.js";
import type { ParsedCommand } from "./message-router.js";
import type { ThreadMappingStore } from "./persistence/thread-mapping-store.js";
import type { ModelSelection } from "./models/index.js";
import { log } from "./logger.js";

export interface ProviderModel {
  id: string;
  name: string;
  providerID: string;
  providerName: string;
}

export interface CommandContext {
  userSession: UserSession;
  registry: OpenCodeSessionRegistry;
  mmClient: MattermostClient;
  threadMappingStore?: ThreadMappingStore | null;
  opencodeClient?: any;
  sessionId?: string;
  threadRootPostId?: string;
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
    this.commands.set("models", this.handleModels.bind(this));
    this.commands.set("model", this.handleModel.bind(this));
  }

  private cachedModels: ProviderModel[] = [];
  private modelsCacheTime: number = 0;
  private MODEL_CACHE_TTL_MS = 60000; // 1 minute

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
    const { registry, userSession, threadMappingStore } = context;
    
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
    const lines = this.formatSessionList(sessions, currentTarget, threadMappingStore);

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private formatSessionList(
    sessions: OpenCodeSessionInfo[], 
    currentTargetId: string | null,
    threadMappingStore?: ThreadMappingStore | null
  ): string[] {
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
      
      const mapping = threadMappingStore?.getBySessionId(session.id);
      const threadLink = mapping ? ` [:thread: thread](/_redirect/pl/${mapping.threadRootPostId})` : "";
      
      lines.push(`**${index + 1}.** \`${session.shortId}\`${marker}${threadLink}`);
      lines.push(`   ${truncatedTitle}`);
      lines.push(`   _${session.projectName}_ • ${relativeTime}`);
      lines.push("");
    });

    if (defaultSession) {
      lines.push(`:white_check_mark: = current target (\`${defaultSession.shortId}\`)`);
    }
    
    if (threadMappingStore) {
      lines.push(":thread: = click to open session thread");
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
    context: CommandContext
  ): Promise<CommandResult> {
    const hasThreads = !!context.threadMappingStore;
    
    const lines = [
      `:question: **Available Commands**`,
      "",
      `| Command | Description |`,
      `|---------|-------------|`,
      `| \`${this.commandPrefix}sessions\` | List available OpenCode sessions |`,
      `| \`${this.commandPrefix}use <id>\` | Switch to a different session |`,
      `| \`${this.commandPrefix}current\` | Show currently targeted session |`,
      `| \`${this.commandPrefix}models\` | List available AI models (use in thread) |`,
      `| \`${this.commandPrefix}model\` | Show current model for this session |`,
      `| \`${this.commandPrefix}help\` | Show this help message |`,
      "",
    ];
    
    if (hasThreads) {
      lines.push("**Thread-Based Workflow:**");
      lines.push("- Each OpenCode session has its own thread");
      lines.push("- Send prompts by replying in a session's thread");
      lines.push("- Use `" + this.commandPrefix + "sessions` to see thread links");
      lines.push("- Commands work in main DM, prompts must go in threads");
      lines.push("");
      lines.push("**Model Switching:**");
      lines.push("- Use `" + this.commandPrefix + "models` in a thread to see available models");
      lines.push("- Reply with a number to select a model for that session");
    } else {
      lines.push("Any message not starting with `" + this.commandPrefix + "` is sent as a prompt to OpenCode.");
    }
    
    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private async fetchModels(opencodeClient: any): Promise<ProviderModel[]> {
    const now = Date.now();
    if (this.cachedModels.length > 0 && (now - this.modelsCacheTime) < this.MODEL_CACHE_TTL_MS) {
      return this.cachedModels;
    }

    try {
      const result = await opencodeClient.provider.list();
      const providers = result.data;
      
      if (!providers?.all || !providers?.connected) {
        log.warn("[CommandHandler] No providers data returned");
        return [];
      }

      const models: ProviderModel[] = [];
      const connectedProviders = new Set(providers.connected);

      for (const provider of providers.all) {
        if (!connectedProviders.has(provider.id)) continue;
        
        for (const [modelId, model] of Object.entries(provider.models || {})) {
          const m = model as any;
          models.push({
            id: modelId,
            name: m.name || modelId,
            providerID: provider.id,
            providerName: provider.name,
          });
        }
      }

      models.sort((a, b) => {
        if (a.providerID !== b.providerID) {
          return a.providerID.localeCompare(b.providerID);
        }
        return a.name.localeCompare(b.name);
      });

      this.cachedModels = models;
      this.modelsCacheTime = now;
      
      log.debug(`[CommandHandler] Cached ${models.length} models from ${connectedProviders.size} providers`);
      return models;
    } catch (e) {
      log.error("[CommandHandler] Failed to fetch models:", e);
      return this.cachedModels;
    }
  }

  private async handleModels(
    _command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { threadMappingStore, opencodeClient, sessionId, threadRootPostId } = context;

    if (!opencodeClient) {
      return {
        success: false,
        message: "OpenCode client not available.",
      };
    }

    if (!sessionId || !threadRootPostId) {
      return {
        success: false,
        message: `Use \`${this.commandPrefix}models\` inside a session thread to switch models for that session.`,
      };
    }

    const models = await this.fetchModels(opencodeClient);
    
    if (models.length === 0) {
      return {
        success: false,
        message: "No models available. Check that providers are configured in OpenCode.",
      };
    }

    const mapping = threadMappingStore?.getBySessionId(sessionId);
    const currentModel = mapping?.model;

    let currentProvider = "";
    const lines: string[] = [
      `:robot_face: **Available Models**`,
      "",
    ];

    models.forEach((model, index) => {
      if (model.providerID !== currentProvider) {
        currentProvider = model.providerID;
        lines.push(`**${model.providerName}**`);
      }
      
      const isCurrent = currentModel?.providerID === model.providerID && 
                        currentModel?.modelID === model.id;
      const marker = isCurrent ? " :white_check_mark:" : "";
      lines.push(`  \`${index + 1}\` ${model.name}${marker}`);
    });

    lines.push("");
    lines.push("Reply with a **number** to select a model for this session.");
    
    if (currentModel) {
      lines.push("");
      lines.push(`:white_check_mark: Current: **${currentModel.displayName || currentModel.modelID}**`);
    }

    if (mapping && threadMappingStore) {
      mapping.pendingModelSelection = true;
      threadMappingStore.update(mapping);
    }

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private async handleModel(
    _command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { threadMappingStore, sessionId } = context;

    if (!sessionId) {
      return {
        success: false,
        message: `Use \`${this.commandPrefix}model\` inside a session thread to see the current model.`,
      };
    }

    const mapping = threadMappingStore?.getBySessionId(sessionId);
    
    if (!mapping?.model) {
      return {
        success: true,
        message: `:information_source: No model explicitly set for this session. Using OpenCode default.\n\nUse \`${this.commandPrefix}models\` to select a specific model.`,
      };
    }

    return {
      success: true,
      message: [
        `:robot_face: **Current Model**`,
        "",
        `Provider: **${mapping.model.providerID}**`,
        `Model: **${mapping.model.displayName || mapping.model.modelID}**`,
        "",
        `Use \`${this.commandPrefix}models\` to change.`,
      ].join("\n"),
    };
  }

  async handleModelSelection(
    selection: number,
    context: CommandContext
  ): Promise<CommandResult | null> {
    const { threadMappingStore, opencodeClient, sessionId } = context;

    if (!sessionId || !threadMappingStore || !opencodeClient) {
      return null;
    }

    const mapping = threadMappingStore.getBySessionId(sessionId);
    if (!mapping?.pendingModelSelection) {
      return null;
    }

    const models = await this.fetchModels(opencodeClient);
    
    if (selection < 1 || selection > models.length) {
      return {
        success: false,
        message: `Invalid selection. Enter a number between 1 and ${models.length}.`,
      };
    }

    const selectedModel = models[selection - 1];
    
    mapping.model = {
      providerID: selectedModel.providerID,
      modelID: selectedModel.id,
      displayName: selectedModel.name,
    };
    mapping.pendingModelSelection = false;
    threadMappingStore.update(mapping);

    log.info(`[CommandHandler] Model set for session ${mapping.shortId}: ${selectedModel.providerID}/${selectedModel.id}`);

    return {
      success: true,
      message: [
        `:white_check_mark: **Model Changed**`,
        "",
        `Now using: **${selectedModel.name}**`,
        `Provider: ${selectedModel.providerName}`,
        "",
        "All prompts in this thread will use this model.",
      ].join("\n"),
    };
  }

  isPendingModelSelection(sessionId: string, threadMappingStore: ThreadMappingStore | null): boolean {
    if (!threadMappingStore) return false;
    const mapping = threadMappingStore.getBySessionId(sessionId);
    return mapping?.pendingModelSelection === true;
  }

  isKnownCommand(name: string): boolean {
    return this.commands.has(name);
  }

  getAvailableCommands(): string[] {
    return Array.from(this.commands.keys());
  }
}
