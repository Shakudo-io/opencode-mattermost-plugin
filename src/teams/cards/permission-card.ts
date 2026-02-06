/**
 * Permission Card Builder for MS Teams
 *
 * Displays permission requests with Approve/Deny buttons.
 * Used when OpenCode requests permission for file operations or shell commands.
 */

import { CardFactory, type Attachment } from "botbuilder";
import {
  CardBuilder,
  type AdaptiveCardContent,
  type AdaptiveCardElement,
  type ActionSetElement,
  type FactSetElement,
} from "./card-builder.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Permission card configuration
 */
export interface PermissionCardConfig {
  permissionId: string;
  sessionId: string;
  type: "bash" | "file_write" | "file_delete" | "other";
  command?: string;
  filePath?: string;
  description: string;
}

// =============================================================================
// Permission Card Builder
// =============================================================================

export class PermissionCardBuilder extends CardBuilder {
  private readonly permissionId: string;
  private readonly sessionId: string;
  private readonly type: PermissionCardConfig["type"];
  private readonly command?: string;
  private readonly filePath?: string;
  private readonly description: string;

  constructor(config: PermissionCardConfig) {
    super();
    this.permissionId = config.permissionId;
    this.sessionId = config.sessionId;
    this.type = config.type;
    this.command = config.command;
    this.filePath = config.filePath;
    this.description = config.description;
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    // Header
    card.body.push(
      this.textBlock("⚠️ Permission Required", {
        size: "medium",
        weight: "bolder",
        color: "warning",
      })
    );

    // Description
    card.body.push(
      this.textBlock(this.description, {
        wrap: true,
        spacing: "medium",
      })
    );

    // Command/File details
    if (this.type === "bash" && this.command) {
      const facts: { title: string; value: string }[] = [
        { title: "Command", value: `\`${this.command}\`` },
      ];
      card.body.push(this.factSet(facts, { spacing: "medium" }));
    } else if ((this.type === "file_write" || this.type === "file_delete") && this.filePath) {
      const facts: { title: string; value: string }[] = [
        { title: "File", value: this.filePath },
      ];
      card.body.push(this.factSet(facts, { spacing: "medium" }));
    }

    // Type indicator
    const typeLabel = this.getTypeLabel(this.type);
    card.body.push(
      this.container(
        [
          this.textBlock(typeLabel, {
            size: "small",
            weight: "bolder",
            spacing: "none",
          }),
        ],
        {
          style: "attention",
          spacing: "medium",
        }
      )
    );

    // Action buttons
    const actionSet: ActionSetElement = {
      type: "ActionSet",
      actions: [
        this.submitAction("✅ Approve", {
          verb: "approve_permission",
          permissionId: this.permissionId,
          sessionId: this.sessionId,
        }),
        this.submitAction("❌ Deny", {
          verb: "deny_permission",
          permissionId: this.permissionId,
          sessionId: this.sessionId,
        }),
      ],
    };
    card.body.push(actionSet);

    // Expiration notice
    card.body.push(
      this.textBlock("⏰ Expires in 5 minutes", {
        size: "small",
        isSubtle: true,
        spacing: "medium",
      })
    );

    return card;
  }

  /**
   * Get human-readable type label
   */
  private getTypeLabel(type: PermissionCardConfig["type"]): string {
    switch (type) {
      case "bash":
        return "Shell Command";
      case "file_write":
        return "File Write";
      case "file_delete":
        return "File Delete";
      case "other":
        return "Permission Request";
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a permission request card
 */
export function createPermissionCard(config: PermissionCardConfig): Attachment {
  return new PermissionCardBuilder(config).toAttachment();
}

/**
 * Create a permission approved confirmation card
 */
export function createPermissionApprovedCard(description: string): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      card.body.push(
        this.textBlock("✅ Permission Approved", {
          size: "medium",
          weight: "bolder",
          color: "good",
        })
      );
      card.body.push(
        this.textBlock(description, {
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
 * Create a permission denied confirmation card
 */
export function createPermissionDeniedCard(description: string): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      card.body.push(
        this.textBlock("❌ Permission Denied", {
          size: "medium",
          weight: "bolder",
          color: "attention",
        })
      );
      card.body.push(
        this.textBlock(description, {
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
 * Create a permission expired card
 */
export function createPermissionExpiredCard(description: string): Attachment {
  const builder = new (class extends CardBuilder {
    build(): AdaptiveCardContent {
      const card = this.createBaseCard();
      card.body.push(
        this.textBlock("⏰ Permission Expired", {
          size: "medium",
          weight: "bolder",
          color: "warning",
        })
      );
      card.body.push(
        this.textBlock(description, {
          wrap: true,
          spacing: "medium",
        })
      );
      card.body.push(
        this.textBlock("This permission request has expired and was not resolved in time.", {
          size: "small",
          isSubtle: true,
          spacing: "medium",
        })
      );
      return card;
    }
  })();

  return builder.toAttachment();
}
