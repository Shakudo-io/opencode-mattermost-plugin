/**
 * Status Card for MS Teams
 *
 * Displays processing progress during OpenCode response streaming.
 * Teams cards can only be updated every ~5 seconds due to rate limits.
 *
 * Features:
 * - Progress indicator with elapsed time
 * - Tool execution status display
 * - Spinner animation (text-based)
 * - Truncated preview of current output
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
 * Tool execution status
 */
export interface ToolStatus {
  name: string;
  status: "running" | "completed" | "error";
  startTime: number;
  endTime?: number;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
}

/**
 * Status card configuration
 */
export interface StatusCardConfig {
  sessionId: string;
  prompt: string;
  startTime: number;
  tools?: ToolStatus[];
  currentOutput?: string;
  maxPreviewLength?: number;
}

// =============================================================================
// Status Card Builder
// =============================================================================

export class StatusCardBuilder extends CardBuilder {
  private readonly sessionId: string;
  private readonly prompt: string;
  private readonly startTime: number;
  private readonly tools: ToolStatus[];
  private readonly currentOutput: string;
  private readonly maxPreviewLength: number;

  constructor(config: StatusCardConfig) {
    super();
    this.sessionId = config.sessionId;
    this.prompt = config.prompt;
    this.startTime = config.startTime;
    this.tools = config.tools ?? [];
    this.currentOutput = config.currentOutput ?? "";
    this.maxPreviewLength = config.maxPreviewLength ?? 500;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();
    const elapsedSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    // Header with spinner and elapsed time
    card.body.push(this.buildHeader(elapsedSeconds));

    // Prompt preview (truncated)
    card.body.push(this.buildPromptSection());

    // Tool execution status (if any tools)
    if (this.tools.length > 0) {
      card.body.push(this.buildToolsSection());
    }

    // Output preview (if any output)
    if (this.currentOutput.trim()) {
      card.body.push(this.buildOutputPreview());
    }

    // Progress indicator
    card.body.push(this.buildProgressIndicator(elapsedSeconds));

    return card;
  }

  /**
   * Build header with spinner animation and elapsed time
   */
  private buildHeader(elapsedSeconds: number): AdaptiveCardElement {
    const spinner = this.getSpinnerFrame();
    const timeDisplay = this.formatElapsedTime(elapsedSeconds);

    return this.columnSet([
      this.column("auto", [
        this.textBlock(`${spinner} Processing...`, {
          size: "medium",
          weight: "bolder",
          color: "accent",
        }),
      ]),
      this.column("stretch", [
        this.textBlock(timeDisplay, {
          size: "medium",
          horizontalAlignment: "right",
          color: "default",
          isSubtle: true,
        } as Partial<Omit<TextBlockElement, "type" | "text">>),
      ]),
    ]);
  }

  /**
   * Build prompt section showing what's being processed
   */
  private buildPromptSection(): AdaptiveCardElement {
    const truncatedPrompt = this.truncateText(this.prompt, 200);

    return this.container(
      [
        this.textBlock("📝 Prompt:", {
          size: "small",
          weight: "bolder",
          color: "default",
        }),
        this.textBlock(truncatedPrompt, {
          size: "small",
          isSubtle: true,
          wrap: true,
        }),
      ],
      {
        style: "emphasis",
        spacing: "medium",
      }
    );
  }

  /**
   * Build tools section showing current/completed tool executions
   */
  private buildToolsSection(): AdaptiveCardElement {
    const items: AdaptiveCardElement[] = [
      this.textBlock("🔧 Tool Execution:", {
        size: "small",
        weight: "bolder",
        separator: true,
        spacing: "medium",
      }),
    ];

    // Show last 5 tools to avoid card size issues
    const recentTools = this.tools.slice(-5);

    for (const tool of recentTools) {
      const statusIcon = this.getToolStatusIcon(tool.status);
      const duration = tool.endTime
        ? this.formatDuration(tool.endTime - tool.startTime)
        : this.formatDuration(Date.now() - tool.startTime);

      const toolText =
        tool.status === "running"
          ? `${statusIcon} **${tool.name}** (${duration})`
          : `${statusIcon} ${tool.name} (${duration})`;

      items.push(
        this.textBlock(toolText, {
          size: "small",
          wrap: true,
          spacing: "small",
        })
      );

      // Show error if present
      if (tool.status === "error" && tool.error) {
        items.push(
          this.textBlock(`    ⚠️ ${this.truncateText(tool.error, 100)}`, {
            size: "small",
            color: "attention",
            wrap: true,
            spacing: "none",
          })
        );
      }
    }

    // Indicate if there are more tools not shown
    if (this.tools.length > 5) {
      items.push(
        this.textBlock(`... and ${this.tools.length - 5} more tool(s)`, {
          size: "small",
          isSubtle: true,
          spacing: "small",
        })
      );
    }

    return this.container(items, { spacing: "small" });
  }

  /**
   * Build output preview section
   */
  private buildOutputPreview(): AdaptiveCardElement {
    const truncatedOutput = this.truncateText(this.currentOutput, this.maxPreviewLength);
    const lineCount = this.currentOutput.split("\n").length;

    return this.container(
      [
        this.textBlock(`📄 Output preview (${lineCount} lines):`, {
          size: "small",
          weight: "bolder",
          separator: true,
          spacing: "medium",
        }),
        this.textBlock(truncatedOutput, {
          size: "small",
          fontType: "monospace",
          wrap: true,
          spacing: "small",
        } as Partial<Omit<TextBlockElement, "type" | "text">>),
      ],
      {
        style: "default",
      }
    );
  }

  /**
   * Build progress indicator bar
   */
  private buildProgressIndicator(elapsedSeconds: number): AdaptiveCardElement {
    // Create a text-based progress bar that "animates" based on elapsed time
    const barLength = 20;
    const position = elapsedSeconds % barLength;
    const bar = "─".repeat(position) + "●" + "─".repeat(barLength - position - 1);

    return this.textBlock(`[${bar}]`, {
      size: "small",
      fontType: "monospace",
      horizontalAlignment: "center",
      color: "accent",
      spacing: "medium",
    } as Partial<Omit<TextBlockElement, "type" | "text">>);
  }

  /**
   * Get spinner frame based on current time (cycles through frames)
   */
  private getSpinnerFrame(): string {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const frameIndex = Math.floor(Date.now() / 100) % frames.length;
    return frames[frameIndex];
  }

  /**
   * Get icon for tool execution status
   */
  private getToolStatusIcon(status: ToolStatus["status"]): string {
    switch (status) {
      case "running":
        return "⏳";
      case "completed":
        return "✅";
      case "error":
        return "❌";
    }
  }

  /**
   * Format elapsed time as "Xm Ys" or "Xs"
   */
  private formatElapsedTime(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  /**
   * Format duration in milliseconds to human readable
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a status card attachment
 */
export function createStatusCard(config: StatusCardConfig): Attachment {
  return new StatusCardBuilder(config).toAttachment();
}

/**
 * Create a status card with minimal config (for quick updates)
 */
export function createSimpleStatusCard(
  sessionId: string,
  prompt: string,
  startTime: number,
  elapsedText?: string
): Attachment {
  return createStatusCard({
    sessionId,
    prompt,
    startTime,
  });
}

/**
 * Create a status card showing tool execution
 */
export function createToolStatusCard(
  sessionId: string,
  prompt: string,
  startTime: number,
  tools: ToolStatus[]
): Attachment {
  return createStatusCard({
    sessionId,
    prompt,
    startTime,
    tools,
  });
}

/**
 * Create a status card with output preview
 */
export function createStatusCardWithOutput(
  sessionId: string,
  prompt: string,
  startTime: number,
  output: string,
  tools?: ToolStatus[]
): Attachment {
  return createStatusCard({
    sessionId,
    prompt,
    startTime,
    tools,
    currentOutput: output,
  });
}
