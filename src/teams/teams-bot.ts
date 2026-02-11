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

    this.log.debug("constructor entry");

    this.config = options.config;
    this.messageHandler = options.onMessage;
    this.cardActionHandler = options.onCardAction;

    this.registerHandlers();

    this.log.info("TeamsBot initialized");
    this.log.debug("constructor exit");
  }

  private registerHandlers(): void {
    this.log.debug("registerHandlers entry");
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

    this.log.debug("registerHandlers exit");
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    this.log.debug("handleMessage entry");
    const activity = context.activity;
    const text = activity.text?.trim() ?? "";
    const userId = activity.from?.id;
    if (!userId) {
      this.log.error("Missing required activity.from.id", {
        activityType: activity.type,
        conversationId: activity.conversation?.id,
      });
      throw new Error("Missing required field: activity.from.id");
    }
    const conversationId = activity.conversation?.id;
    if (!conversationId) {
      this.log.error("Missing required activity.conversation.id", {
        activityType: activity.type,
        fromId: activity.from?.id,
      });
      throw new Error("Missing required field: activity.conversation.id");
    }
    const userName = activity.from?.name ?? activity.from?.id ?? "unknown";
    const isReply = Boolean(activity.replyToId);
    const replyToId = activity.replyToId;

    this.log.info("Message received", {
      userId,
      userName,
      conversationId,
      textLength: text.length,
      isReply,
      replyToId,
    });

    const cleanedText = this.stripBotMentionFromTeamsMessage(activity);

    if (this.messageHandler) {
      try {
        await this.messageHandler(context, cleanedText);
      } catch (error) {
         this.log.error("Error in message handler", {
           error: String(error),
           userId,
           userName,
           conversationId,
           activityType: activity.type,
         });
         try {
           const result = await context.sendActivity(
             MessageFactory.text("Sorry, I encountered an error processing your message. Please try again.")
           );
           this.log.info(`sendActivity result for 'error message': ${JSON.stringify(result)}`);
         } catch (sendError) {
           this.log.error(`sendActivity FAILED for 'error message': ${sendError}`);
           throw sendError;
         }
       }
     } else {
       this.log.debug("No message handler registered, sending default response");
       try {
         const result = await context.sendActivity(
           MessageFactory.text(`I received your message: "${cleanedText.substring(0, 50)}${cleanedText.length > 50 ? "..." : ""}"`)
         );
         this.log.info(`sendActivity result for 'default response': ${JSON.stringify(result)}`);
       } catch (sendError) {
         this.log.error(`sendActivity FAILED for 'default response': ${sendError}`);
         throw sendError;
       }
     }

    this.log.debug("handleMessage exit");
  }

  protected async onAdaptiveCardInvoke(
    context: TurnContext,
    invokeValue: AdaptiveCardInvokeValue
  ): Promise<AdaptiveCardInvokeResponse> {
    this.log.debug("onAdaptiveCardInvoke entry");
    const verb = invokeValue.action?.verb ?? "unknown";
    const actionData = (invokeValue.action?.data as Record<string, unknown>) ?? {};
    const userId = context.activity.from?.id;

    this.log.info("Card action received", {
      verb,
      userId,
      dataKeys: Object.keys(actionData),
    });

    if (this.cardActionHandler) {
      try {
        await this.cardActionHandler(context, { verb, ...actionData });
        this.log.debug("onAdaptiveCardInvoke exit: handled");
        return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: { result: "OK" } };
      } catch (error) {
        this.log.error("Error in card action handler", {
          error: String(error),
          verb,
          userId,
          activityType: context.activity.type,
          conversationId: context.activity.conversation?.id,
        });
        this.log.debug("onAdaptiveCardInvoke exit: error");
        return {
          statusCode: 500,
          type: "application/vnd.microsoft.error",
          value: { code: "InternalError", message: "An error occurred processing your action" },
        };
      }
    }

    this.log.debug("onAdaptiveCardInvoke exit: no handler");
    return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: { result: "OK" } };
  }

  private async handleMembersAdded(context: TurnContext): Promise<void> {
    this.log.debug("handleMembersAdded entry");
    const membersAdded = context.activity.membersAdded ?? [];
    const botId = context.activity.recipient?.id;

    for (const member of membersAdded) {
      if (member.id !== botId) {
        this.log.info("Member added", { memberId: member.id, memberName: member.name });
       } else {
         this.log.info("Bot was added to the conversation");
         try {
           const result = await context.sendActivity(
             MessageFactory.text(
               "Hello! I'm the OpenCode bot. Send me a message to start a coding session, or type `!help` for available commands."
             )
           );
           this.log.info(`sendActivity result for 'welcome message': ${JSON.stringify(result)}`);
         } catch (sendError) {
           this.log.error(`sendActivity FAILED for 'welcome message': ${sendError}`);
           throw sendError;
         }
       }
    }

    this.log.debug("handleMembersAdded exit");
  }

  private async handleMembersRemoved(context: TurnContext): Promise<void> {
    this.log.debug("handleMembersRemoved entry");
    const membersRemoved = context.activity.membersRemoved ?? [];

    for (const member of membersRemoved) {
      this.log.info("Member removed", { memberId: member.id, memberName: member.name });
    }

    this.log.debug("handleMembersRemoved exit");
  }

  private stripBotMentionFromTeamsMessage(activity: Activity): string {
    this.log.debug("stripBotMentionFromTeamsMessage entry");
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
    this.log.info("Mention stripping", {
      originalLength: text.length,
      cleanedLength: cleanedText.length,
      mentionCount: mentions.length,
    });
    this.log.debug("stripBotMentionFromTeamsMessage exit");
    return cleanedText;
  }

  setMessageHandler(handler: MessageHandler): void {
    this.log.debug("setMessageHandler entry");
    this.messageHandler = handler;
    this.log.debug("setMessageHandler exit");
  }

  setCardActionHandler(handler: CardActionHandler): void {
    this.log.debug("setCardActionHandler entry");
    this.cardActionHandler = handler;
    this.log.debug("setCardActionHandler exit");
  }

  static getConversationReference(activity: Activity): Partial<ConversationReference> {
    const log = teamsLog.withContext("TeamsBot");
    log.debug("getConversationReference entry");
    const reference = TurnContext.getConversationReference(activity);
    log.debug("getConversationReference exit");
    return reference;
  }
}
