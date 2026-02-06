/**
 * Command Card Builder for MS Teams
 *
 * Base card for displaying command responses in Teams.
 * Used by !help and other command outputs.
 */

import { CardFactory, type Attachment } from "botbuilder";
import {
  CardBuilder,
  type AdaptiveCardContent,
  type AdaptiveCardElement,
  type TextBlockElement,
} from "./card-builder.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Command definition for help display
 */
export interface CommandDefinition {
  command: string;
  description: string;
  usage?: string;
  examples?: string[];
}

/**
 * Command card configuration
 */
export interface CommandCardConfig {
  title: string;
  icon?: string;
  description?: string;
  commands?: CommandDefinition[];
  content?: AdaptiveCardElement[];
  footer?: string;
}

// =============================================================================
// Command Card Builder
// =============================================================================

export class CommandCardBuilder extends CardBuilder {
  private readonly title: string;
  private readonly icon: string;
  private readonly description?: string;
  private readonly commands: CommandDefinition[];
  private readonly content: AdaptiveCardElement[];
  private readonly footer?: string;

  constructor(config: CommandCardConfig) {
    super();
    this.title = config.title;
    this.icon = config.icon ?? "⚡";
    this.description = config.description;
    this.commands = config.commands ?? [];
    this.content = config.content ?? [];
    this.footer = config.footer;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    // Header with icon and title
    card.body.push(this.buildHeader());

    // Description (if provided)
    if (this.description) {
      card.body.push(
        this.textBlock(this.description, {
          wrap: true,
          spacing: "medium",
          isSubtle: true,
        })
      );
    }

    // Commands list (if provided)
    if (this.commands.length > 0) {
      card.body.push(this.buildCommandsList());
    }

    // Custom content (if provided)
    if (this.content.length > 0) {
      for (const element of this.content) {
        card.body.push(element);
      }
    }

    // Footer (if provided)
    if (this.footer) {
      card.body.push(
        this.textBlock(this.footer, {
          size: "small",
          isSubtle: true,
          separator: true,
          spacing: "medium",
        })
      );
    }

    return card;
  }

  /**
   * Build header with icon and title
   */
  private buildHeader(): AdaptiveCardElement {
    return this.columnSet([
      this.column("auto", [
        this.textBlock(this.icon, {
          size: "large",
        }),
      ]),
      this.column("stretch", [
        this.textBlock(this.title, {
          size: "large",
          weight: "bolder",
          color: "accent",
        }),
      ]),
    ]);
  }

  /**
   * Build commands list section
   */
  private buildCommandsList(): AdaptiveCardElement {
    const items: AdaptiveCardElement[] = [];

    for (const cmd of this.commands) {
      // Command name and description
      items.push(
        this.textBlock(`**\`${cmd.command}\`** - ${cmd.description}`, {
          wrap: true,
          spacing: "small",
        })
      );

      // Usage (if provided)
      if (cmd.usage) {
        items.push(
          this.textBlock(`Usage: \`${cmd.usage}\``, {
            size: "small",
            isSubtle: true,
            spacing: "none",
          })
        );
      }

      // Examples (if provided)
      if (cmd.examples && cmd.examples.length > 0) {
        const exampleText = cmd.examples.map((e) => `\`${e}\``).join(", ");
        items.push(
          this.textBlock(`Examples: ${exampleText}`, {
            size: "small",
            isSubtle: true,
            spacing: "none",
          })
        );
      }
    }

    return this.container(items, {
      spacing: "medium",
      separator: true,
    });
  }
}

// =============================================================================
// Help Card Builder
// =============================================================================

export interface HelpCardConfig {
  botName?: string;
  version?: string;
  commands: CommandDefinition[];
}

export class HelpCardBuilder extends CardBuilder {
  private readonly botName: string;
  private readonly botVersion?: string;
  private readonly commands: CommandDefinition[];

  constructor(config: HelpCardConfig) {
    super();
    this.botName = config.botName ?? "OpenCode Bot";
    this.botVersion = config.version;
    this.commands = config.commands;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    // Header
    card.body.push(
      this.textBlock(`❓ ${this.botName} Help`, {
        size: "large",
        weight: "bolder",
        color: "accent",
      })
    );

    if (this.botVersion) {
      card.body.push(
        this.textBlock(`Version: ${this.botVersion}`, {
          size: "small",
          isSubtle: true,
        })
      );
    }

    // Description
    card.body.push(
      this.textBlock(
        "Control OpenCode AI coding assistant directly from Microsoft Teams. " +
          "Send prompts, manage sessions, and view results in real-time.",
        {
          wrap: true,
          spacing: "medium",
        }
      )
    );

    // Commands section header
    card.body.push(
      this.textBlock("**Available Commands:**", {
        separator: true,
        spacing: "large",
      })
    );

    // Group commands by category
    const sessionCommands = this.commands.filter(
      (c) =>
        c.command.includes("sessions") ||
        c.command.includes("models") ||
        c.command.includes("model")
    );
    const actionCommands = this.commands.filter(
      (c) =>
        c.command.includes("stop") ||
        c.command.includes("costs") ||
        c.command.includes("reject")
    );
    const helpCommands = this.commands.filter((c) => c.command.includes("help"));
    const otherCommands = this.commands.filter(
      (c) =>
        !sessionCommands.includes(c) &&
        !actionCommands.includes(c) &&
        !helpCommands.includes(c)
    );

    // Session Management
    if (sessionCommands.length > 0) {
      card.body.push(
        this.textBlock("📋 **Session Management**", {
          spacing: "medium",
        })
      );
      card.body.push(this.buildCommandGroup(sessionCommands));
    }

    // Actions
    if (actionCommands.length > 0) {
      card.body.push(
        this.textBlock("⚡ **Actions**", {
          spacing: "medium",
        })
      );
      card.body.push(this.buildCommandGroup(actionCommands));
    }

    // Help
    if (helpCommands.length > 0) {
      card.body.push(
        this.textBlock("❓ **Help**", {
          spacing: "medium",
        })
      );
      card.body.push(this.buildCommandGroup(helpCommands));
    }

    // Other
    if (otherCommands.length > 0) {
      card.body.push(
        this.textBlock("🔧 **Other**", {
          spacing: "medium",
        })
      );
      card.body.push(this.buildCommandGroup(otherCommands));
    }

    // Footer with usage tips
    card.body.push(
      this.container(
        [
          this.textBlock("💡 **Tips:**", { spacing: "none" }),
          this.textBlock(
            "• Type your message directly to send prompts to OpenCode\n" +
              "• Each thread maps to an OpenCode session\n" +
              "• Use reactions for quick actions (✅ approve, ❌ deny, 🛑 stop)",
            {
              size: "small",
              wrap: true,
              spacing: "small",
            }
          ),
        ],
        {
          style: "emphasis",
          separator: true,
          spacing: "large",
        }
      )
    );

    return card;
  }

  /**
   * Build a command group as a fact set
   */
  private buildCommandGroup(commands: CommandDefinition[]): AdaptiveCardElement {
    const facts = commands.map((cmd) => ({
      title: `\`${cmd.command}\``,
      value: cmd.description,
    }));

    return this.factSet(facts, { spacing: "small" });
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a generic command card
 */
export function createCommandCard(config: CommandCardConfig): Attachment {
  return new CommandCardBuilder(config).toAttachment();
}

/**
 * Create a help card with all available commands
 */
export function createHelpCard(config: HelpCardConfig): Attachment {
  return new HelpCardBuilder(config).toAttachment();
}

/**
 * Create a simple message card (for command responses)
 */
export function createMessageCard(
  title: string,
  message: string,
  icon?: string
): Attachment {
  return createCommandCard({
    title,
    icon: icon ?? "ℹ️",
    description: message,
  });
}

/**
 * Create an error card
 */
export function createErrorCard(title: string, error: string): Attachment {
  return createCommandCard({
    title: `❌ ${title}`,
    icon: "⚠️",
    description: error,
  });
}

/**
 * Create a success card
 */
export function createSuccessCard(title: string, message: string): Attachment {
  return createCommandCard({
    title: `✅ ${title}`,
    icon: "🎉",
    description: message,
  });
}

/**
 * Get the default command definitions for help
 */
export function getDefaultCommands(): CommandDefinition[] {
  return [
    {
      command: "!help",
      description: "Show this help message",
    },
    {
      command: "!sessions",
      description: "List all available OpenCode sessions",
    },
    {
      command: "!models",
      description: "List and select available AI models",
    },
    {
      command: "!model",
      description: "Show the currently selected model",
    },
    {
      command: "!costs",
      description: "Show token usage and costs for the session",
    },
    {
      command: "!stop",
      description: "Cancel the current operation",
    },
    {
      command: "!reject",
      description: "Skip/cancel a pending question",
    },
  ];
}
