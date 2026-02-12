/**
 * Session Card Builder for MS Teams
 *
 * Displays OpenCode session information and lists.
 * Used by !sessions command.
 */

import { CardFactory, type Attachment } from "botbuilder";
import {
  CardBuilder,
  type AdaptiveCardContent,
  type AdaptiveCardElement,
  type CardAction,
} from "./card-builder.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Session information for display
 */
export interface SessionInfo {
  id: string;
  projectName: string;
  projectDirectory: string;
  status: "active" | "idle" | "ended";
  lastActivityAt: string;
  model?: string;
  description?: string;
  threadId?: string;
  costs?: {
    totalCost: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Session list card configuration
 */
export interface SessionListCardConfig {
  sessions: SessionInfo[];
  currentSessionId?: string;
}

/**
 * Session detail card configuration
 */
export interface SessionDetailCardConfig {
  session: SessionInfo;
  includeActions?: boolean;
}

/**
 * Model selection card configuration
 */
export interface ModelSelectionCardConfig {
  providers: {
    name: string;
    models: {
      id: string;
      name: string;
      isSelected?: boolean;
    }[];
  }[];
  currentModel?: string;
}

/**
 * Cost card configuration
 */
export interface CostCardConfig {
  sessionId: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  sessionDuration?: number;
}

// =============================================================================
// Session List Card Builder
// =============================================================================

export class SessionListCardBuilder extends CardBuilder {
  private readonly sessions: SessionInfo[];
  private readonly currentSessionId?: string;

  constructor(config: SessionListCardConfig) {
    super();
    this.sessions = config.sessions;
    this.currentSessionId = config.currentSessionId;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    // Header
    card.body.push(
      this.textBlock(`📋 Available Sessions (${this.sessions.length})`, {
        size: "large",
        weight: "bolder",
        color: "accent",
      })
    );

    if (this.sessions.length === 0) {
      card.body.push(
        this.textBlock("No active sessions found. Start a conversation to create a session.", {
          wrap: true,
          spacing: "medium",
          isSubtle: true,
        })
      );
      return card;
    }

    // Sessions list
    for (let i = 0; i < this.sessions.length; i++) {
      const session = this.sessions[i];
      const isCurrent = session.id === this.currentSessionId;

      card.body.push(this.buildSessionItem(session, i + 1, isCurrent));
    }

    // Footer
    card.body.push(
      this.textBlock("Use `!use <number>` to select a session.", {
        size: "small",
        isSubtle: true,
        separator: true,
        spacing: "medium",
      })
    );

    return card;
  }

  /**
   * Build a single session item
   */
  private buildSessionItem(
    session: SessionInfo,
    index: number,
    isCurrent: boolean
  ): AdaptiveCardElement {
    const statusIcon = this.getStatusIcon(session.status);
    const timeSince = this.formatTimeSince(session.lastActivityAt);
    const currentMarker = isCurrent ? " 👈" : "";

    const items: AdaptiveCardElement[] = [];

    if (session.description) {
      items.push(
        this.textBlock(
          `${index}. ${statusIcon} ${session.description}${currentMarker}`,
          {
            weight: "bolder",
            wrap: true,
            spacing: index === 1 ? "medium" : "small",
          }
        )
      );
      items.push(
        this.textBlock(`${session.projectName} · \`${session.id}\``, {
          size: "small",
          isSubtle: true,
          spacing: "none",
        })
      );
    } else {
      items.push(
        this.textBlock(
          `${index}. ${statusIcon} ${session.projectName}${currentMarker}`,
          {
            weight: "bolder",
            wrap: true,
            spacing: index === 1 ? "medium" : "small",
          }
        )
      );
      items.push(
        this.textBlock(`\`${session.id}\``, {
          size: "small",
          isSubtle: true,
          spacing: "none",
        })
      );
    }

    const metaParts = [`📁 ${session.projectDirectory}`, `⏱️ ${timeSince}`];
    if (session.model) {
      metaParts.push(`🤖 ${session.model}`);
    }
    items.push(
      this.textBlock(metaParts.join("  ·  "), {
        size: "small",
        isSubtle: true,
        spacing: "none",
      })
    );

    return this.container(items, {
      style: isCurrent ? "emphasis" : "default",
      separator: index > 1,
    });
  }

  /**
   * Get status icon for session
   */
  private getStatusIcon(status: SessionInfo["status"]): string {
    switch (status) {
      case "active":
        return "🟢";
      case "idle":
        return "🟡";
      case "ended":
        return "🔴";
    }
  }

  /**
   * Format time since last activity
   */
  private formatTimeSince(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }
}

// =============================================================================
// Model Selection Card Builder
// =============================================================================

export class ModelSelectionCardBuilder extends CardBuilder {
  private readonly providers: ModelSelectionCardConfig["providers"];
  private readonly currentModel?: string;

  constructor(config: ModelSelectionCardConfig) {
    super();
    this.providers = config.providers;
    this.currentModel = config.currentModel;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    // Header
    card.body.push(
      this.textBlock("🤖 Available Models", {
        size: "large",
        weight: "bolder",
        color: "accent",
      })
    );

    // Current model
    if (this.currentModel) {
      card.body.push(
        this.textBlock(`Current model: **${this.currentModel}**`, {
          wrap: true,
          spacing: "medium",
        })
      );
    }

    // Build model list with numbered options
    let modelIndex = 1;

    for (const provider of this.providers) {
      // Provider header
      card.body.push(
        this.textBlock(`**${provider.name}**`, {
          separator: true,
          spacing: "medium",
        })
      );

      // Models under this provider
      const modelItems: AdaptiveCardElement[] = [];

      for (const model of provider.models) {
        const isSelected = model.isSelected || model.id === this.currentModel;
        const selectedMarker = isSelected ? " ✓" : "";

        modelItems.push(
          this.textBlock(`  ${modelIndex}. ${model.name}${selectedMarker}`, {
            spacing: "small",
            color: isSelected ? "accent" : "default",
          })
        );

        modelIndex++;
      }

      card.body.push(this.container(modelItems, { spacing: "none" }));
    }

    // Instructions
    card.body.push(
      this.textBlock("Reply with a number to select a model.", {
        size: "small",
        isSubtle: true,
        separator: true,
        spacing: "medium",
      })
    );

    return card;
  }
}

// =============================================================================
// Cost Card Builder
// =============================================================================

export class CostCardBuilder extends CardBuilder {
  private readonly sessionId: string;
  private readonly totalCost: number;
  private readonly inputTokens: number;
  private readonly outputTokens: number;
  private readonly model?: string;
  private readonly sessionDuration?: number;

  constructor(config: CostCardConfig) {
    super();
    this.sessionId = config.sessionId;
    this.totalCost = config.totalCost;
    this.inputTokens = config.inputTokens;
    this.outputTokens = config.outputTokens;
    this.model = config.model;
    this.sessionDuration = config.sessionDuration;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    // Header
    card.body.push(
      this.textBlock(`💰 Session Costs (${this.sessionId})`, {
        size: "large",
        weight: "bolder",
        color: "accent",
      })
    );

    // Cost facts
    const facts: { title: string; value: string }[] = [
      { title: "Total Cost", value: `$${this.totalCost.toFixed(4)}` },
      { title: "Input Tokens", value: this.formatTokens(this.inputTokens) },
      { title: "Output Tokens", value: this.formatTokens(this.outputTokens) },
    ];

    if (this.model) {
      facts.push({ title: "Model", value: this.model });
    }

    if (this.sessionDuration !== undefined) {
      facts.push({ title: "Duration", value: this.formatDuration(this.sessionDuration) });
    }

    card.body.push(this.factSet(facts, { spacing: "medium" }));

    // Token breakdown visualization
    const totalTokens = this.inputTokens + this.outputTokens;
    const inputPercent = totalTokens > 0 ? Math.round((this.inputTokens / totalTokens) * 100) : 50;
    const outputPercent = 100 - inputPercent;

    card.body.push(
      this.container(
        [
          this.textBlock("Token Distribution:", {
            size: "small",
            weight: "bolder",
            spacing: "none",
          }),
          this.textBlock(`Input: ${inputPercent}% | Output: ${outputPercent}%`, {
            size: "small",
            isSubtle: true,
            spacing: "none",
          }),
        ],
        {
          spacing: "medium",
          separator: true,
        }
      )
    );

    return card;
  }

  /**
   * Format token count with K/M suffix
   */
  private formatTokens(count: number): string {
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 1_000) {
      return `${(count / 1_000).toFixed(1)}K`;
    }
    return count.toLocaleString();
  }

  /**
   * Format duration in seconds to human readable
   */
  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    return `${hours}h ${remainingMins}m`;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a session list card
 */
export function createSessionListCard(config: SessionListCardConfig): Attachment {
  return new SessionListCardBuilder(config).toAttachment();
}

/**
 * Create a model selection card
 */
export function createModelSelectionCard(config: ModelSelectionCardConfig): Attachment {
  return new ModelSelectionCardBuilder(config).toAttachment();
}

/**
 * Create a cost tracking card
 */
export function createCostCard(config: CostCardConfig): Attachment {
  return new CostCardBuilder(config).toAttachment();
}

/**
 * Create a simple card showing current model
 */
export function createCurrentModelCard(model: string, sessionId: string): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      card.body.push(
        this.textBlock(`🤖 Current Model`, {
          size: "large",
          weight: "bolder",
          color: "accent",
        })
      );
      card.body.push(
        this.textBlock(`Session: ${sessionId}`, {
          size: "small",
          isSubtle: true,
        })
      );
      card.body.push(
        this.textBlock(`**${model}**`, {
          size: "medium",
          spacing: "medium",
        })
      );
      card.body.push(
        this.textBlock("Use `!models` to see all available models.", {
          size: "small",
          isSubtle: true,
          separator: true,
          spacing: "medium",
        })
      );
      return card;
    }
  })();

  return builder.toAttachment();
}

/**
 * Create a card confirming model selection
 */
export function createModelSelectedCard(model: string, provider: string): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      card.body.push(
        this.textBlock(`✅ Model Changed`, {
          size: "large",
          weight: "bolder",
          color: "good",
        })
      );
      card.body.push(
        this.textBlock(`Model set to **${model}** (${provider}) for this session.`, {
          wrap: true,
          spacing: "medium",
        })
      );
      return card;
    }
  })();

  return builder.toAttachment();
}

/**
 * Create a card confirming operation was stopped
 */
export function createStoppedCard(sessionId: string): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      card.body.push(
        this.textBlock(`🛑 Operation Cancelled`, {
          size: "large",
          weight: "bolder",
          color: "attention",
        })
      );
      card.body.push(
        this.textBlock(`The current operation in session ${sessionId} has been cancelled.`, {
          wrap: true,
          spacing: "medium",
        })
      );
      return card;
    }
  })();

  return builder.toAttachment();
}

/**
 * Create a no sessions card
 */
export function createNoSessionsCard(): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      card.body.push(
        this.textBlock(`📋 No Active Sessions`, {
          size: "large",
          weight: "bolder",
        })
      );
      card.body.push(
        this.textBlock(
          "There are no active OpenCode sessions. Start a conversation by sending a message to create a new session.",
          {
            wrap: true,
            spacing: "medium",
            isSubtle: true,
          }
        )
      );
      return card;
    }
  })();

  return builder.toAttachment();
}
