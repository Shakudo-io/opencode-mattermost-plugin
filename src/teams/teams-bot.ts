/**
 * MS Teams Bot - TeamsActivityHandler implementation
 *
 * Handles incoming activities from Teams users including messages,
 * card actions, and conversation events.
 */

import {
  TeamsActivityHandler,
  TurnContext,
  Activity,
  MessageFactory,
  ConversationReference,
  AdaptiveCardInvokeValue,
  AdaptiveCardInvokeResponse,
} from "botbuilder";
import { teamsLog } from "./teams-logger.js";
import type { TeamsConfig } from "./teams-config.js";

export type MessageHandler = (context: TurnContext, text: string) => Promise<void>;
export type CardActionHandler = (context: TurnContext, actionData: Record<string, unknown>) => Promise<void>;

export interface TeamsBotOptions {
  config: TeamsConfig;
  onMessage?: MessageHandler;
  onCardAction?: CardActionHandler;
}

/**
 * Teams bot that handles incoming activities.
 *
 * This bot responds to:
 * - Direct messages from users
 * - Card action submissions (Action.Submit from Adaptive Cards)
 * - Conversation updates (member added/removed)
 */
export class TeamsBot extends TeamsActivityHandler {
  private readonly log = teamsLog.withContext("TeamsBot");
  private readonly config: TeamsConfig;
  private messageHandler?: MessageHandler;
  private cardActionHandler?: CardActionHandler;

  constructor(options: TeamsBotOptions) {
    super();

    this.config = options.config;
    this.messageHandler = options.onMessage;
    this.cardActionHandler = options.onCardAction;

    this.registerHandlers();

    this.log.info("TeamsBot initialized");
  }

  private registerHandlers(): void {
    this.onMessage(async (context: TurnContext, next: () => Promise<void>): Promise<void> => {
      await this.handleMessage(context);
      await next();
    });

    this.onMembersAdded(async (context: TurnContext, next: () => Promise<void>): Promise<void> => {
      await this.handleMembersAdded(context);
      await next();
    });

    this.onMembersRemoved(async (context: TurnContext, next: () => Promise<void>): Promise<void> => {
      await this.handleMembersRemoved(context);
      await next();
    });
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    const activity = context.activity;
    const text = activity.text?.trim() ?? "";
    const userId = activity.from?.id ?? "unknown";
    const userName = activity.from?.name ?? "unknown";
    const conversationId = activity.conversation?.id ?? "unknown";

    this.log.info(`Message received from ${userName} (${userId}) in conversation ${conversationId}`);
    this.log.debug(`Message length: ${text.length} chars`);

    const cleanedText = this.stripBotMentionFromTeamsMessage(activity);

    if (this.messageHandler) {
      try {
        await this.messageHandler(context, cleanedText);
      } catch (error) {
        this.log.error(`Error in message handler: ${error}`);
        await context.sendActivity(
          MessageFactory.text("Sorry, I encountered an error processing your message. Please try again.")
        );
      }
    } else {
      this.log.debug("No message handler registered, sending default response");
      await context.sendActivity(
        MessageFactory.text(`I received your message: "${cleanedText.substring(0, 50)}${cleanedText.length > 50 ? "..." : ""}"`)
      );
    }
  }

  protected async onAdaptiveCardInvoke(
    context: TurnContext,
    invokeValue: AdaptiveCardInvokeValue
  ): Promise<AdaptiveCardInvokeResponse> {
    const verb = invokeValue.action?.verb ?? "unknown";
    const actionData = (invokeValue.action?.data as Record<string, unknown>) ?? {};

    this.log.info(`Card action received: verb="${verb}"`);
    this.log.debug(`Card action data keys: ${Object.keys(actionData).join(", ")}`);

    if (this.cardActionHandler) {
      try {
        await this.cardActionHandler(context, { verb, ...actionData });
        return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: { result: "OK" } };
      } catch (error) {
        this.log.error(`Error in card action handler: ${error}`);
        return {
          statusCode: 500,
          type: "application/vnd.microsoft.error",
          value: { code: "InternalError", message: "An error occurred processing your action" },
        };
      }
    }

    return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: { result: "OK" } };
  }

  private async handleMembersAdded(context: TurnContext): Promise<void> {
    const membersAdded = context.activity.membersAdded ?? [];
    const botId = context.activity.recipient?.id;

    for (const member of membersAdded) {
      if (member.id !== botId) {
        this.log.info(`User ${member.name ?? member.id} joined the conversation`);
      } else {
        this.log.info("Bot was added to the conversation");
        await context.sendActivity(
          MessageFactory.text(
            "Hello! I'm the OpenCode bot. Send me a message to start a coding session, or type `!help` for available commands."
          )
        );
      }
    }
  }

  private async handleMembersRemoved(context: TurnContext): Promise<void> {
    const membersRemoved = context.activity.membersRemoved ?? [];

    for (const member of membersRemoved) {
      this.log.info(`User ${member.name ?? member.id} left the conversation`);
    }
  }

  private stripBotMentionFromTeamsMessage(activity: Activity): string {
    const text = activity.text ?? "";
    const mentions = activity.entities?.filter((e) => e.type === "mention") ?? [];

    let cleanedText = text;
    for (const mention of mentions) {
      if (mention.mentioned?.id === activity.recipient?.id) {
        const mentionText = mention.text as string;
        if (mentionText) {
          cleanedText = cleanedText.replace(mentionText, "").trim();
        }
      }
    }

    return cleanedText;
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  setCardActionHandler(handler: CardActionHandler): void {
    this.cardActionHandler = handler;
  }

  static getConversationReference(activity: Activity): Partial<ConversationReference> {
    return TurnContext.getConversationReference(activity);
  }
}
