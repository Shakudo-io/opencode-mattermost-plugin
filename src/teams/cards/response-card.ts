/**
 * Response Card for MS Teams
 *
 * Displays the final response from OpenCode after processing completes.
 * Supports markdown rendering with code blocks and proper formatting.
 *
 * Features:
 * - Markdown content rendering
 * - Code block support
 * - Session metadata (elapsed time, tools used)
 * - Pagination support for large responses (>28KB)
 * - Copy action for response content
 */

import { CardFactory, type Attachment } from "botbuilder";
import {
  CardBuilder,
  type AdaptiveCardContent,
  type AdaptiveCardElement,
  type CardAction,
  type TextBlockElement,
} from "./card-builder.js";
import type { ToolStatus } from "./status-card.js";

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum card size in bytes (~28KB, with buffer)
 * Teams has a hard limit around 28-30KB for Adaptive Cards
 */
export const MAX_CARD_SIZE_BYTES = 25000;

/**
 * Maximum content length for a single card (characters)
 * This is a conservative estimate to stay under the byte limit
 */
export const MAX_CONTENT_LENGTH = 20000;

// =============================================================================
// Types
// =============================================================================

/**
 * Response card configuration
 */
export interface ResponseCardConfig {
  sessionId: string;
  content: string;
  startTime: number;
  endTime?: number;
  tools?: ToolStatus[];
  prompt?: string;
  pageNumber?: number;
  totalPages?: number;
  isError?: boolean;
  errorMessage?: string;
}

export interface ResponseMetaCardConfig {
  sessionId: string;
  elapsedSeconds: number;
  contentLength: number;
  tools?: ToolStatus[];
}

/**
 * Pagination result for large responses
 */
export interface PaginatedResponse {
  pages: string[];
  totalPages: number;
}

// =============================================================================
// Response Card Builder
// =============================================================================

export class ResponseCardBuilder extends CardBuilder {
  private readonly sessionId: string;
  private readonly content: string;
  private readonly startTime: number;
  private readonly endTime: number;
  private readonly tools: ToolStatus[];
  private readonly prompt?: string;
  private readonly pageNumber: number;
  private readonly totalPages: number;
  private readonly isError: boolean;
  private readonly errorMessage?: string;

  constructor(config: ResponseCardConfig) {
    super();
    this.sessionId = config.sessionId;
    this.content = config.content;
    this.startTime = config.startTime;
    this.endTime = config.endTime ?? Date.now();
    this.tools = config.tools ?? [];
    this.prompt = config.prompt;
    this.pageNumber = config.pageNumber ?? 1;
    this.totalPages = config.totalPages ?? 1;
    this.isError = config.isError ?? false;
    this.errorMessage = config.errorMessage;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    // Header
    card.body.push(this.buildHeader());

    // Error message if present
    if (this.isError && this.errorMessage) {
      card.body.push(this.buildErrorSection());
    }

    // Main content
    if (this.content.trim()) {
      card.body.push(this.buildContentSection());
    }

    // Metadata footer
    card.body.push(this.buildFooter());

    // Pagination indicator
    if (this.totalPages > 1) {
      card.body.push(this.buildPaginationIndicator());
    }

    // Actions (if needed)
    const actions = this.buildActions();
    if (actions.length > 0) {
      card.actions = actions;
    }

    return card;
  }

  /**
   * Build header section with completion status
   */
  private buildHeader(): AdaptiveCardElement {
    const icon = this.isError ? "❌" : "✅";
    const title = this.isError ? "Error" : "Response";
    const color = this.isError ? "attention" : "good";

    const duration = this.formatDuration(this.endTime - this.startTime);

    return this.columnSet([
      this.column("auto", [
        this.textBlock(`${icon} ${title}`, {
          size: "medium",
          weight: "bolder",
          color: color as TextBlockElement["color"],
        }),
      ]),
      this.column("stretch", [
        this.textBlock(`⏱️ ${duration}`, {
          size: "small",
          horizontalAlignment: "right",
          isSubtle: true,
        } as Partial<Omit<TextBlockElement, "type" | "text">>),
      ]),
    ]);
  }

  /**
   * Build error section
   */
  private buildErrorSection(): AdaptiveCardElement {
    return this.container(
      [
        this.textBlock(this.errorMessage ?? "An error occurred", {
          color: "attention",
          wrap: true,
        }),
      ],
      {
        style: "attention",
        spacing: "medium",
      }
    );
  }

  /**
   * Build main content section with markdown
   */
  private buildContentSection(): AdaptiveCardElement {
    // Process content for Adaptive Card markdown compatibility
    const processedContent = this.processMarkdownContent(this.content);

    return this.container(
      [
        this.textBlock(processedContent, {
          wrap: true,
          spacing: "medium",
        }),
      ],
      {
        spacing: "medium",
      }
    );
  }

  /**
   * Build footer with metadata
   */
  private buildFooter(): AdaptiveCardElement {
    const facts: { title: string; value: string }[] = [];

    // Add tool count if tools were used
    if (this.tools.length > 0) {
      const completedTools = this.tools.filter((t) => t.status === "completed").length;
      facts.push({
        title: "Tools Used",
        value: `${completedTools}/${this.tools.length}`,
      });
    }

    // Add prompt preview if available
    if (this.prompt) {
      facts.push({
        title: "Prompt",
        value: this.truncateText(this.prompt, 100),
      });
    }

    // Add session ID
    facts.push({
      title: "Session",
      value: this.sessionId.split("_")[1]?.substring(0, 6) || this.sessionId.substring(0, 8),
    });

    return this.factSet(facts, {
      separator: true,
      spacing: "medium",
    });
  }

  /**
   * Build pagination indicator
   */
  private buildPaginationIndicator(): AdaptiveCardElement {
    return this.textBlock(`Page ${this.pageNumber} of ${this.totalPages}`, {
      size: "small",
      horizontalAlignment: "center",
      isSubtle: true,
      separator: true,
      spacing: "medium",
    } as Partial<Omit<TextBlockElement, "type" | "text">>);
  }

  /**
   * Build action buttons
   */
  private buildActions(): CardAction[] {
    const actions: CardAction[] = [];

    // Add navigation buttons for paginated responses
    if (this.totalPages > 1) {
      if (this.pageNumber > 1) {
        actions.push(
          this.submitAction("◀ Previous", {
            verb: "response_page",
            action: "response_page",
            sessionId: this.sessionId,
            page: this.pageNumber - 1,
          })
        );
      }
      if (this.pageNumber < this.totalPages) {
        actions.push(
          this.submitAction("Next ▶", {
            verb: "response_page",
            action: "response_page",
            sessionId: this.sessionId,
            page: this.pageNumber + 1,
          })
        );
      }
    }

    return actions;
  }

  /**
   * Process markdown content for Adaptive Card compatibility
   * Adaptive Cards support a subset of markdown
   */
  private processMarkdownContent(content: string): string {
    // Adaptive Cards support:
    // - **bold**
    // - _italic_
    // - [links](url)
    // - Lists (- item)
    // - Headers are NOT supported, convert to bold

    let processed = content;

    // Convert headers to bold
    processed = processed.replace(/^#{1,6}\s+(.+)$/gm, "**$1**\n");

    // Ensure code blocks are preserved (they'll render as monospace-ish)
    // Adaptive Cards don't have true code block support, but ``` works reasonably

    // Truncate if needed to fit card size
    if (processed.length > MAX_CONTENT_LENGTH) {
      processed = processed.substring(0, MAX_CONTENT_LENGTH - 100);
      processed += "\n\n*[Content truncated - response too large]*";
    }

    return processed;
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
// Utility Functions
// =============================================================================

/**
 * Paginate content for large responses
 */
export function paginateContent(content: string): PaginatedResponse {
  if (content.length <= MAX_CONTENT_LENGTH) {
    return { pages: [content], totalPages: 1 };
  }

  const pages: string[] = [];
  let remaining = content;
  const pageSize = MAX_CONTENT_LENGTH - 200; // Buffer for pagination text

  while (remaining.length > 0) {
    if (remaining.length <= pageSize) {
      pages.push(remaining);
      break;
    }

    // Find a good break point (newline, space, or forced)
    let breakPoint = remaining.lastIndexOf("\n\n", pageSize);
    if (breakPoint < pageSize * 0.5) {
      breakPoint = remaining.lastIndexOf("\n", pageSize);
    }
    if (breakPoint < pageSize * 0.5) {
      breakPoint = remaining.lastIndexOf(" ", pageSize);
    }
    if (breakPoint < pageSize * 0.5) {
      breakPoint = pageSize;
    }

    pages.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trimStart();
  }

  return { pages, totalPages: pages.length };
}

/**
 * Estimate card size in bytes (rough approximation)
 */
export function estimateCardSize(card: AdaptiveCardContent): number {
  return JSON.stringify(card).length * 2; // UTF-16 encoding approximation
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a response card attachment
 */
export function createResponseCard(config: ResponseCardConfig): Attachment {
  return new ResponseCardBuilder(config).toAttachment();
}

/**
 * Create a simple response card
 */
export function createSimpleResponseCard(
  sessionId: string,
  content: string,
  startTime: number
): Attachment {
  return createResponseCard({
    sessionId,
    content,
    startTime,
    endTime: Date.now(),
  });
}

/**
 * Create an error response card
 */
export function createErrorResponseCard(
  sessionId: string,
  errorMessage: string,
  startTime: number,
  details?: string
): Attachment {
  return createResponseCard({
    sessionId,
    content: details ?? "",
    startTime,
    endTime: Date.now(),
    isError: true,
    errorMessage,
  });
}

/**
 * Create a complete response card with tools and metadata
 */
export function createCompleteResponseCard(
  sessionId: string,
  content: string,
  startTime: number,
  prompt: string,
  tools: ToolStatus[]
): Attachment {
  return createResponseCard({
    sessionId,
    content,
    startTime,
    endTime: Date.now(),
    prompt,
    tools,
  });
}

/**
 * Create paginated response cards for large content
 */
export function createPaginatedResponseCards(
  config: Omit<ResponseCardConfig, "pageNumber" | "totalPages" | "content">,
  content: string
): Attachment[] {
  const { pages, totalPages } = paginateContent(content);

  return pages.map((pageContent, index) =>
    createResponseCard({
      ...config,
      content: pageContent,
      pageNumber: index + 1,
      totalPages,
    })
  );
}

export function createResponseMetaCard(config: ResponseMetaCardConfig): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      const toolsSummary = (config.tools ?? [])
        .filter((tool) => tool.status === "completed")
        .map((tool) => tool.name)
        .slice(0, 5)
        .join(", ");

      const metaParts = [
        `⏱️ ${config.elapsedSeconds}s`,
        `📊 ${config.contentLength} chars`,
      ];

      if (toolsSummary) {
        metaParts.push(`🔧 ${toolsSummary}`);
      }

      card.body.push(
        this.textBlock(metaParts.join("  ·  "), {
          size: "small",
          isSubtle: true,
          spacing: "none",
        })
      );

      return card;
    }
  })();

  return builder.toAttachment();
}
