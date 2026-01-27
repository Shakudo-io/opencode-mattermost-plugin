import type { MattermostClient } from "./clients/mattermost-client.js";
import type { OpenCodeSessionRegistry, OpenCodeSessionInfo } from "./opencode-session-registry.js";
import type { UserSession } from "./session-manager.js";
import type { ParsedCommand } from "./message-router.js";
import type { ThreadMappingStore } from "./persistence/thread-mapping-store.js";
import type { TeamStore } from "./persistence/team-store.js";
import type { QuestionHandler } from "./question-handler.js";
import type { ModelSelection } from "./models/index.js";
import { MergeHandler } from "./merge-handler.js";
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
  teamStore?: TeamStore | null;
  ownerUserId?: string | null;
  questionHandler?: QuestionHandler | null;
  opencodeClient?: any;
  sessionId?: string;
  threadRootPostId?: string;
  channelId?: string;
  mattermostBaseUrl?: string;
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
    this.commands.set("costs", this.handleCosts.bind(this));
    this.commands.set("stop", this.handleStop.bind(this));
    this.commands.set("merge", this.handleMerge.bind(this));
    this.commands.set("team", this.handleTeam.bind(this));
    this.commands.set("reject", this.handleReject.bind(this));
    this.commands.set("cancel", this.handleReject.bind(this)); // alias
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
    const { registry, userSession, threadMappingStore, channelId } = context;
    
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
    const lines = this.formatSessionList(sessions, currentTarget, threadMappingStore, channelId);

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private formatSessionList(
    sessions: OpenCodeSessionInfo[], 
    currentTargetId: string | null,
    threadMappingStore?: ThreadMappingStore | null,
    channelId?: string
  ): string[] {
    const defaultSession = sessions.find(s => s.id === currentTargetId);
    
    const filteredSessions = channelId && threadMappingStore
      ? sessions.filter(session => {
          const mapping = threadMappingStore.getBySessionId(session.id);
          if (!mapping) return false;
          const mappingChannelId = mapping.channelId || mapping.dmChannelId;
          return mappingChannelId === channelId;
        })
      : sessions;
    
    const lines: string[] = [
      `:clipboard: **Sessions in this channel** (${filteredSessions.length}):`,
      "",
    ];

    if (filteredSessions.length === 0) {
      lines.push("_No sessions in this channel yet._");
      lines.push("");
      lines.push("Send a message to start a new session.");
      return lines;
    }

    filteredSessions.forEach((session, index) => {
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

    if (defaultSession && filteredSessions.some(s => s.id === defaultSession.id)) {
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
      `| \`${this.commandPrefix}costs\` | Show LLM costs for all active sessions |`,
      `| \`${this.commandPrefix}models\` | List available AI models (use in thread) |`,
      `| \`${this.commandPrefix}model\` | Show current model for this session |`,
      `| \`${this.commandPrefix}merge <url>\` | Merge another thread into this session |`,
      `| \`${this.commandPrefix}stop\` | Stop/abort the current session (use in thread) |`,
      `| \`${this.commandPrefix}reject\` | Skip/reject a pending AI question |`,
      `| \`${this.commandPrefix}team\` | Manage team members (owner only) |`,
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
      lines.push("");
      lines.push("**AI Questions:**");
      lines.push("- When the AI asks a question, reply with a number or type your answer");
      lines.push("- Use `" + this.commandPrefix + "reject` or `" + this.commandPrefix + "cancel` to skip the question");
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

  private async handleCosts(
    _command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { registry, opencodeClient, threadMappingStore } = context;

    if (!opencodeClient) {
      return {
        success: false,
        message: "OpenCode client not available.",
      };
    }

    try {
      await registry.refresh();
    } catch (e) {
      log.warn("[CommandHandler] Failed to refresh sessions:", e);
    }

    const allSessions = registry.listAvailable();

    if (allSessions.length === 0) {
      return {
        success: true,
        message: "No active OpenCode sessions found.",
      };
    }

    // Filter to only sessions with thread mappings (active DM sessions)
    // This avoids fetching costs for orphaned or unused sessions
    const sessionsWithMappings = threadMappingStore
      ? allSessions.filter(s => threadMappingStore.getBySessionId(s.id))
      : allSessions;

    // Limit to max 30 sessions to avoid timeout
    const MAX_SESSIONS = 30;
    const sessions = sessionsWithMappings.slice(0, MAX_SESSIONS);
    const totalAvailable = allSessions.length;
    const limited = sessionsWithMappings.length > MAX_SESSIONS;

    log.info(`[CommandHandler] !costs: Fetching costs for ${sessions.length} sessions (${totalAvailable} total available, ${sessionsWithMappings.length} with mappings)`);

    // Fetch costs in parallel for speed
    const costPromises = sessions.map(async (session) => {
      let totalCost = 0;
      try {
        const messagesResult = await opencodeClient.session.messages({ path: { id: session.id } });
        const messages = messagesResult.data || [];
        for (const message of messages) {
          if (message.info.role === "assistant") {
            totalCost += (message.info as any).cost || 0;
          }
        }
      } catch (e) {
        log.debug(`[CommandHandler] Could not fetch messages for session ${session.shortId}: ${e}`);
      }

      const mapping = threadMappingStore?.getBySessionId(session.id);
      const threadLink = mapping ? `/_redirect/pl/${mapping.threadRootPostId}` : null;

      return { session, cost: totalCost, threadLink };
    });

    const sessionCosts = await Promise.all(costPromises);
    
    log.info(`[CommandHandler] !costs: Fetched costs for ${sessionCosts.length} sessions`);

    sessionCosts.sort((a, b) => b.cost - a.cost);

    const grandTotal = sessionCosts.reduce((sum, sc) => sum + sc.cost, 0);

    const lines: string[] = [
      `:moneybag: **Session Costs**`,
      "",
      `| Session | Title | Cost |`,
      `|---------|-------|------|`,
    ];

    for (const { session, cost, threadLink } of sessionCosts) {
      const title = this.truncateString(session.title || session.projectName, 40);
      const costStr = this.formatCost(cost);
      const sessionLink = threadLink 
        ? `[\`${session.shortId}\`](${threadLink})`
        : `\`${session.shortId}\``;
      lines.push(`| ${sessionLink} | ${title} | ${costStr} |`);
    }

    lines.push(`| | **Total** | **${this.formatCost(grandTotal)}** |`);
    lines.push("");
    
    if (limited) {
      lines.push(`_Showing ${sessions.length} of ${sessionsWithMappings.length} sessions with threads (${totalAvailable} total)_`);
    } else {
      lines.push(`_${sessions.length} session(s) with threads (${totalAvailable} total available)_`);
    }

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private formatCost(cost: number): string {
    if (cost >= 1) return `$${cost.toFixed(2)}`;
    if (cost >= 0.01) return `$${cost.toFixed(2)}`;
    if (cost >= 0.001) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(4)}`;
  }

  private async handleStop(
    _command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { opencodeClient, sessionId, threadMappingStore } = context;

    if (!opencodeClient) {
      return {
        success: false,
        message: "OpenCode client not available.",
      };
    }

    if (!sessionId) {
      return {
        success: false,
        message: `Use \`${this.commandPrefix}stop\` inside a session thread to stop that session.`,
      };
    }

    try {
      await opencodeClient.session.abort({ path: { id: sessionId } });
      log.info(`[CommandHandler] Aborted session ${sessionId.substring(0, 8)}`);

      const mapping = threadMappingStore?.getBySessionId(sessionId);
      const shortId = mapping?.shortId || sessionId.substring(0, 8);

      return {
        success: true,
        message: [
          `:stop_sign: **Session Stopped**`,
          "",
          `Session \`${shortId}\` has been interrupted.`,
          "",
          "The AI will stop processing and any running tools will be cancelled.",
        ].join("\n"),
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      log.error(`[CommandHandler] Failed to abort session ${sessionId.substring(0, 8)}: ${errorMsg}`);
      
      return {
        success: false,
        message: `Failed to stop session: ${errorMsg}`,
      };
    }
  }

  private async handleReject(
    _command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { sessionId, questionHandler } = context;

    if (!sessionId) {
      return {
        success: false,
        message: `Use \`${this.commandPrefix}reject\` inside a session thread to reject a pending question.`,
      };
    }

    if (!questionHandler) {
      return {
        success: false,
        message: "Question handler not available.",
      };
    }

    if (!questionHandler.hasPendingQuestion(sessionId)) {
      return {
        success: false,
        message: "No pending question to reject for this session.",
      };
    }

    const questionInfo = questionHandler.getPendingQuestionInfo(sessionId);
    questionHandler.cancelSessionQuestions(sessionId);

    const questionHeader = questionInfo?.request.questions[0]?.header || "Unknown";
    
    return {
      success: true,
      message: [
        `:x: **Question Rejected**`,
        "",
        `Skipped question: "${questionHeader}"`,
        "",
        "The AI will continue without your input (using default or making its own choice).",
      ].join("\n"),
    };
  }

  private async handleMerge(
    command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { mmClient, threadMappingStore, opencodeClient, sessionId, threadRootPostId, channelId, userSession, mattermostBaseUrl } = context;

    if (!opencodeClient) {
      return {
        success: false,
        message: "OpenCode client not available.",
      };
    }

    if (!threadMappingStore) {
      return {
        success: false,
        message: "Thread mapping store not available.",
      };
    }

    if (!sessionId || !threadRootPostId || !channelId) {
      return {
        success: false,
        message: `Use \`${this.commandPrefix}merge <thread-url>\` inside a session thread to merge another thread's context into this one.`,
      };
    }

    const url = command.rawArgs.trim();
    if (!url) {
      return {
        success: false,
        message: [
          `**Usage:** \`${this.commandPrefix}merge <thread-url>\``,
          "",
          "Merge another Mattermost thread's conversation into this session.",
          "",
          "**Example:**",
          `\`${this.commandPrefix}merge https://mattermost.example.com/team/pl/abc123xyz\``,
          "",
          "The source thread will be summarized and the summary injected here.",
          "The source thread will be marked as merged and locked.",
        ].join("\n"),
      };
    }

    const baseUrl = mattermostBaseUrl || process.env.MATTERMOST_URL || "";
    const mergeHandler = new MergeHandler(mmClient, threadMappingStore, opencodeClient, baseUrl);

    const result = await mergeHandler.executeMerge(
      url,
      sessionId,
      threadRootPostId,
      channelId,
      userSession.mattermostUserId
    );

    return {
      success: result.success,
      message: result.message,
    };
  }

  private async handleTeam(
    command: ParsedCommand,
    context: CommandContext
  ): Promise<CommandResult> {
    const { teamStore, ownerUserId, userSession, mmClient } = context;

    if (!teamStore) {
      return {
        success: false,
        message: "Team system not available.",
      };
    }

    const isOwner = ownerUserId && userSession.mattermostUserId === ownerUserId;
    if (!isOwner) {
      return {
        success: false,
        message: "Only the owner can manage team members.",
      };
    }

    const args = command.rawArgs.trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase() || "";

    if (!subcommand || subcommand === "list") {
      return this.handleTeamList(teamStore);
    }

    if (subcommand === "add") {
      const mention = args[1];
      if (!mention) {
        return {
          success: false,
          message: `**Usage:** \`${this.commandPrefix}team add @username\``,
        };
      }
      return this.handleTeamAdd(teamStore, mmClient, mention, ownerUserId);
    }

    if (subcommand === "remove") {
      const mention = args[1];
      if (!mention) {
        return {
          success: false,
          message: `**Usage:** \`${this.commandPrefix}team remove @username\``,
        };
      }
      return this.handleTeamRemove(teamStore, mmClient, mention);
    }

    if (subcommand === "clear") {
      return this.handleTeamClear(teamStore);
    }

    return {
      success: false,
      message: [
        `:busts_in_silhouette: **Team Commands**`,
        "",
        `| Command | Description |`,
        `|---------|-------------|`,
        `| \`${this.commandPrefix}team\` | Show team members |`,
        `| \`${this.commandPrefix}team add @user\` | Add a team member |`,
        `| \`${this.commandPrefix}team remove @user\` | Remove a team member |`,
        `| \`${this.commandPrefix}team clear\` | Remove all team members |`,
        "",
        "Team members can bypass guest approval and create sessions.",
      ].join("\n"),
    };
  }

  private handleTeamList(teamStore: TeamStore): CommandResult {
    const members = teamStore.getMembers();
    const config = teamStore.getConfig();

    if (!config) {
      return {
        success: true,
        message: "No team configured yet. Use `!team add @user` to add your first team member.",
      };
    }

    const lines: string[] = [
      `:busts_in_silhouette: **Team: ${config.name}**`,
      "",
    ];

    if (members.length === 0) {
      lines.push("_No team members yet._");
      lines.push("");
      lines.push(`Use \`${this.commandPrefix}team add @username\` to add members.`);
    } else {
      lines.push(`| Member | Added | Role |`);
      lines.push(`|--------|-------|------|`);
      
      for (const member of members) {
        const addedDate = new Date(member.addedAt).toLocaleDateString();
        lines.push(`| @${member.username} | ${addedDate} | ${member.role} |`);
      }
      
      lines.push("");
      lines.push(`**${members.length}** team member(s)`);
    }

    lines.push("");
    lines.push("Team members bypass guest approval and can create sessions.");

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private async handleTeamAdd(
    teamStore: TeamStore,
    mmClient: MattermostClient,
    mention: string,
    addedBy: string
  ): Promise<CommandResult> {
    const username = mention.replace(/^@/, "");

    try {
      const user = await mmClient.getUserByUsername(username);
      
      if (teamStore.isOwner(user.id)) {
        return {
          success: false,
          message: `@${username} is the owner, not a team member.`,
        };
      }

      const added = teamStore.addMember(user.id, username, addedBy);
      
      if (!added) {
        return {
          success: false,
          message: `@${username} is already a team member.`,
        };
      }

      return {
        success: true,
        message: [
          `:white_check_mark: **Team Member Added**`,
          "",
          `@${username} can now:`,
          "- Bypass guest approval in channels",
          "- Create sessions without confirmation",
          "- Send prompts directly to the bot",
        ].join("\n"),
      };
    } catch (e) {
      log.error(`[CommandHandler] Failed to add team member @${username}:`, e);
      return {
        success: false,
        message: `Could not find user @${username}. Make sure the username is correct.`,
      };
    }
  }

  private async handleTeamRemove(
    teamStore: TeamStore,
    mmClient: MattermostClient,
    mention: string
  ): Promise<CommandResult> {
    const username = mention.replace(/^@/, "");

    try {
      const user = await mmClient.getUserByUsername(username);
      const removed = teamStore.removeMember(user.id);
      
      if (!removed) {
        return {
          success: false,
          message: `@${username} is not a team member.`,
        };
      }

      return {
        success: true,
        message: `:white_check_mark: Removed @${username} from the team.`,
      };
    } catch (e) {
      log.error(`[CommandHandler] Failed to remove team member @${username}:`, e);
      return {
        success: false,
        message: `Could not find user @${username}. Make sure the username is correct.`,
      };
    }
  }

  private handleTeamClear(teamStore: TeamStore): CommandResult {
    const count = teamStore.clearMembers();
    
    if (count === 0) {
      return {
        success: true,
        message: "No team members to remove.",
      };
    }

    return {
      success: true,
      message: `:white_check_mark: Removed **${count}** team member(s). Only the owner has access now.`,
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
