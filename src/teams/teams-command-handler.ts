/**
 * Teams Command Handler for MS Teams
 *
 * Parses and routes !commands from Teams messages.
 * Implements command handlers for session management, model selection,
 * cost tracking, and operation control.
 */

import type { TurnContext, Attachment } from "botbuilder";
import { teamsLog } from "./teams-logger.js";
import type { TeamsConfig } from "./teams-config.js";
import { OpenCodeBridge, type OpenCodeBridge as OpenCodeBridgeType } from "./opencode-bridge.js";
import type { OpenCodeSessionInfo } from "../opencode-session-registry.js";

// Card builders
import {
  createHelpCard,
  createErrorCard,
  createSuccessCard,
  createMessageCard,
  getDefaultCommands,
  type CommandDefinition,
} from "./cards/command-card.js";
import {
  createSessionListCard,
  createModelSelectionCard,
  createCostCard,
  createCurrentModelCard,
  createModelSelectedCard,
  createStoppedCard,
  createNoSessionsCard,
  type SessionInfo,
  type ModelSelectionCardConfig,
} from "./cards/session-card.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Command result returned by handlers
 */
export interface CommandResult {
  handled: boolean;
  card?: Attachment;
  text?: string;
  error?: string;
}

/**
 * Command context for handlers
 */
export interface CommandContext {
  turnContext: TurnContext;
  userId: string;
  userName: string;
  conversationId: string;
  threadId?: string;
  sessionId?: string;
}

/**
 * Command handler function signature
 */
type CommandHandler = (
  args: string[],
  context: CommandContext
) => Promise<CommandResult>;

/**
 * Command definition with handler
 */
interface CommandRegistration {
  command: string;
  aliases: string[];
  handler: CommandHandler;
}

// =============================================================================
// Teams Command Handler Implementation
// =============================================================================

export class TeamsCommandHandler {
  private readonly log = teamsLog.withContext("TeamsCommandHandler");
  private readonly config: TeamsConfig;
  private readonly bridge: OpenCodeBridgeType;
  private readonly commands: Map<string, CommandRegistration> = new Map();

  // Track per-conversation state for model selection
  private pendingModelSelections: Map<string, {
    models: { id: string; name: string; provider: string }[];
    expiresAt: number;
  }> = new Map();

  // Track selected models per session/conversation
  private sessionModels: Map<string, string> = new Map();

  constructor(config: TeamsConfig, bridge: OpenCodeBridgeType) {
    this.config = config;
    this.bridge = bridge;
    this.registerCommands();
    this.log.info("TeamsCommandHandler initialized");
  }

  // ===========================================================================
  // Command Registration
  // ===========================================================================

  /**
   * Register all available commands
   */
  private registerCommands(): void {
    // Help command
    this.register({
      command: "!help",
      aliases: ["!h", "!?"],
      handler: this.handleHelp.bind(this),
    });

    // Session commands
    this.register({
      command: "!sessions",
      aliases: ["!session", "!list"],
      handler: this.handleSessions.bind(this),
    });

    // Model commands
    this.register({
      command: "!models",
      aliases: [],
      handler: this.handleModels.bind(this),
    });

    this.register({
      command: "!model",
      aliases: [],
      handler: this.handleModel.bind(this),
    });

    // Cost tracking
    this.register({
      command: "!costs",
      aliases: ["!cost", "!usage"],
      handler: this.handleCosts.bind(this),
    });

    // Operation control
    this.register({
      command: "!stop",
      aliases: ["!cancel", "!abort"],
      handler: this.handleStop.bind(this),
    });

    this.register({
      command: "!reject",
      aliases: ["!skip"],
      handler: this.handleReject.bind(this),
    });
  }

  /**
   * Register a command
   */
  private register(registration: CommandRegistration): void {
    this.commands.set(registration.command.toLowerCase(), registration);
    for (const alias of registration.aliases) {
      this.commands.set(alias.toLowerCase(), registration);
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Check if a message starts with a command prefix
   */
  isCommand(text: string): boolean {
    const trimmed = text.trim();
    const result = trimmed.startsWith("!");
    this.log.debug(`isCommand result=${result} textLength=${text.length}`);
    return result;
  }

  /**
   * Check if message is a numeric response (for model selection)
   */
  isNumericResponse(text: string, conversationId: string): boolean {
    const pending = this.pendingModelSelections.get(conversationId);
    if (!pending) {
      this.log.debug(`isNumericResponse=false conversationId=${conversationId} pending=false`);
      return false;
    }
    if (Date.now() > pending.expiresAt) {
      this.pendingModelSelections.delete(conversationId);
      this.log.debug(`isNumericResponse=false conversationId=${conversationId} expired=true`);
      return false;
    }
    const isNumeric = /^\d+$/.test(text.trim());
    this.log.debug(
      `isNumericResponse result=${isNumeric} conversationId=${conversationId} textLength=${text.length}`
    );
    return isNumeric;
  }

  /**
   * Handle a command message
   */
  async handleCommand(
    text: string,
    context: CommandContext
  ): Promise<CommandResult> {
    const trimmed = text.trim();

    this.log.info(
      `handleCommand entry userId=${context.userId} conversationId=${context.conversationId} textLength=${trimmed.length}`
    );

    // Check for numeric response to model selection
    if (this.isNumericResponse(trimmed, context.conversationId)) {
      this.log.info(
        `Numeric response received value=${trimmed} conversationId=${context.conversationId} sessionId=${context.sessionId}`
      );
      return this.handleModelSelection(trimmed, context);
    }

    // Parse command and arguments
    const parts = trimmed.split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    this.log.info(
      `Handling command command=${commandName} argsCount=${args.length} userId=${context.userId}`
    );

    if (["!select", "!new", "!end"].includes(commandName)) {
      this.log.warn(`Unsupported command attempted command=${commandName} userId=${context.userId}`);
    }

    // Find command registration
    const registration = this.commands.get(commandName);
    if (!registration) {
      return this.handleUnknownCommand(commandName, context);
    }

    try {
      return await registration.handler(args, context);
    } catch (error) {
      this.log.error(
        `Command handler error command=${commandName} argsCount=${args.length} userId=${context.userId} error=${error}`
      );
      return {
        handled: true,
        card: createErrorCard("Command Error", String(error)),
      };
    }
  }

  // ===========================================================================
  // Command Handlers
  // ===========================================================================

  /**
   * !help - Show help card with available commands
   */
  private async handleHelp(
    _args: string[],
    _context: CommandContext
  ): Promise<CommandResult> {
    this.log.info("Executing command !help");
    const commands = getDefaultCommands();
    const card = createHelpCard({
      botName: "Kaji",
      version: "1.0.0",
      commands,
    });

    return { handled: true, card };
  }

  /**
   * !sessions - List all available OpenCode sessions
   */
  private async handleSessions(
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> {
    this.log.info(`Executing command !sessions userId=${context.userId}`);
    if (!this.bridge.isConnected()) {
      return {
        handled: true,
        card: createErrorCard(
          "Not Connected",
          "Not connected to OpenCode server. Please wait for connection to establish."
        ),
      };
    }

    const sessions = this.bridge.getSessions();

    // Sort by most recent and limit to 10 to prevent oversized Adaptive Cards
    const recentSessions = [...sessions]
      .sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime())
      .slice(0, 10);

    if (recentSessions.length === 0) {
      return { handled: true, card: createNoSessionsCard() };
    }

    const sessionInfos: SessionInfo[] = recentSessions.map((s) => ({
      id: s.shortId,
      projectName: s.projectName,
      projectDirectory: s.directory,
      status: this.getSessionStatus(s),
      lastActivityAt: s.lastUpdated.toISOString(),
      model: this.sessionModels.get(s.id),
      description: s.title !== s.projectName ? s.title : undefined,
    }));

    // Add note if there are more sessions
    let card = createSessionListCard({
      sessions: sessionInfos,
      currentSessionId: context.sessionId,
    });

    if (sessions.length > 10) {
      // Card modification would go here if needed - for now just note it in logs
      this.log.info(
        `Showing 10 of ${sessions.length} sessions. User can use !sessions multiple times or !use <sessionId> directly.`
      );
    }

    return { handled: true, card };
  }

  /**
   * !models - List available models and prompt for selection
   */
  private async handleModels(
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> {
    this.log.info(`Executing command !models userId=${context.userId}`);
    // TODO: Get actual models from OpenCode bridge when API is available
    // For now, use mock data
    const providers = this.getMockProviders();

    // Build flat model list for selection tracking
    const flatModels: { id: string; name: string; provider: string }[] = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        flatModels.push({
          id: model.id,
          name: model.name,
          provider: provider.name,
        });
      }
    }

    // Store pending selection (expires in 5 minutes)
    this.pendingModelSelections.set(context.conversationId, {
      models: flatModels,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const currentModel = context.sessionId
      ? this.sessionModels.get(context.sessionId)
      : undefined;

    const card = createModelSelectionCard({
      providers,
      currentModel,
    });

    return { handled: true, card };
  }

  /**
   * Handle numeric response for model selection
   */
  private async handleModelSelection(
    text: string,
    context: CommandContext
  ): Promise<CommandResult> {
    this.log.info(
      `Handling model selection response value=${text} conversationId=${context.conversationId} sessionId=${context.sessionId}`
    );
    const pending = this.pendingModelSelections.get(context.conversationId);
    if (!pending) {
      return {
        handled: true,
        card: createErrorCard(
          "Selection Expired",
          "Model selection has expired. Please run `!models` again."
        ),
      };
    }

    const index = parseInt(text.trim(), 10) - 1; // Convert to 0-based
    if (index < 0 || index >= pending.models.length) {
      return {
        handled: true,
        card: createErrorCard(
          "Invalid Selection",
          `Please enter a number between 1 and ${pending.models.length}.`
        ),
      };
    }

    const selectedModel = pending.models[index];

    // Store selection for the session/conversation
    if (context.sessionId) {
      this.sessionModels.set(context.sessionId, selectedModel.id);
    }
    this.sessionModels.set(context.conversationId, selectedModel.id);

    // Clear pending selection
    this.pendingModelSelections.delete(context.conversationId);

    // TODO: Actually set the model in OpenCode when API is available

    const card = createModelSelectedCard(selectedModel.name, selectedModel.provider);
    return { handled: true, card };
  }

  /**
   * !model - Show currently selected model
   */
  private async handleModel(
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> {
    this.log.info(`Executing command !model userId=${context.userId}`);
    const model =
      (context.sessionId ? this.sessionModels.get(context.sessionId) : undefined) ||
      this.sessionModels.get(context.conversationId);

    if (!model) {
      return {
        handled: true,
        card: createMessageCard(
          "No Model Selected",
          "No model has been selected for this session. Use `!models` to select one.",
          "🤖"
        ),
      };
    }

    const sessionId = context.sessionId || context.conversationId;
    const card = createCurrentModelCard(model, sessionId);
    return { handled: true, card };
  }

  /**
   * !costs - Show token usage and costs for the session
   */
  private async handleCosts(
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> {
    this.log.info(`Executing command !costs userId=${context.userId} sessionId=${context.sessionId}`);
    // TODO: Get actual costs from OpenCode bridge when API is available
    // For now, show a placeholder or mock data

    if (!context.sessionId) {
      return {
        handled: true,
        card: createMessageCard(
          "No Active Session",
          "No active session to show costs for. Start a conversation to create a session.",
          "💰"
        ),
      };
    }

    // Mock cost data for now
    const card = createCostCard({
      sessionId: context.sessionId,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: this.sessionModels.get(context.sessionId),
    });

    return { handled: true, card };
  }

  /**
   * !stop - Cancel the current operation
   */
  private async handleStop(
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> {
    this.log.info(`Executing command !stop userId=${context.userId} sessionId=${context.sessionId}`);
    if (!context.sessionId) {
      return {
        handled: true,
        card: createErrorCard(
          "No Active Session",
          "No active session to stop. Start a conversation to create a session."
        ),
      };
    }

    // TODO: Actually cancel operation via OpenCode bridge when API is available
    this.log.info(`Stop requested for session ${context.sessionId}`);

    const card = createStoppedCard(context.sessionId);
    return { handled: true, card };
  }

  /**
   * !reject - Skip/cancel a pending question
   */
  private async handleReject(
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> {
    this.log.info(`Executing command !reject userId=${context.userId} sessionId=${context.sessionId}`);
    if (!context.sessionId) {
      return {
        handled: true,
        card: createErrorCard(
          "No Active Session",
          "No active session with a pending question."
        ),
      };
    }

    // TODO: Actually reject question via OpenCode bridge when API is available
    this.log.info(`Reject requested for session ${context.sessionId}`);

    return {
      handled: true,
      card: createSuccessCard(
        "Question Skipped",
        "The pending question has been skipped."
      ),
    };
  }

  /**
   * Handle unknown command
   */
  private async handleUnknownCommand(
    command: string,
    _context: CommandContext
  ): Promise<CommandResult> {
    this.log.warn(`Unknown command attempted command=${command}`);
    const availableCommands = Array.from(this.commands.values())
      .filter((c, i, arr) => arr.findIndex((x) => x.command === c.command) === i)
      .map((c) => c.command)
      .join(", ");

    return {
      handled: true,
      card: createErrorCard(
        "Unknown Command",
        `\`${command}\` is not a recognized command.\n\nAvailable commands: ${availableCommands}\n\nUse \`!help\` for more information.`
      ),
    };
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Get session status
   */
  private getSessionStatus(session: OpenCodeSessionInfo): "active" | "idle" | "ended" {
    // TODO: Determine actual status from session state
    // For now, all discovered sessions are considered active
    return "active";
  }

  /**
   * Get mock providers for model selection
   * TODO: Replace with actual provider data from OpenCode
   */
  private getMockProviders(): ModelSelectionCardConfig["providers"] {
    return [
      {
        name: "Anthropic",
        models: [
          { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
          { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
        ],
      },
      {
        name: "OpenAI",
        models: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "o3", name: "o3" },
        ],
      },
    ];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new Teams command handler
 */
export function createTeamsCommandHandler(
  config: TeamsConfig,
  bridge: OpenCodeBridgeType
): TeamsCommandHandler {
  return new TeamsCommandHandler(config, bridge);
}
