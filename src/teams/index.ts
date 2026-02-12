/**
 * MS Teams Bot Integration
 *
 * Main entry point for the MS Teams OpenCode integration.
 * Exports all Teams-specific modules and provides the startTeamsBot() bootstrap function.
 */

// =============================================================================
// Configuration
// =============================================================================

export {
  type TeamsConfig,
  type AzureConfig,
  type TeamsServerConfig,
  type TeamsBotConfig,
  type TeamsLoggingConfig,
  type OpenCodeConnectionConfig,
  loadTeamsConfig,
  validateTeamsConfig,
  logTeamsConfig,
  getTeamsConfig,
  clearTeamsConfigCache,
} from "./teams-config.js";

// =============================================================================
// Logging
// =============================================================================

export { teamsLog, type TeamsLogger } from "./teams-logger.js";

// =============================================================================
// Adapter
// =============================================================================

export {
  createTeamsAdapter,
  getTeamsAdapter,
  clearAdapterInstance,
  validateAdapterConfig,
} from "./teams-adapter.js";

// =============================================================================
// Bot
// =============================================================================

export {
  TeamsBot,
  type TeamsBotOptions,
  type MessageHandler,
  type CardActionHandler,
} from "./teams-bot.js";

// =============================================================================
// Server
// =============================================================================

export {
  createTeamsServer,
  type TeamsServer,
  type TeamsServerOptions,
} from "./teams-server.js";

// =============================================================================
// Cards
// =============================================================================

export { CardBuilder, type AdaptiveCardContent, type CardAction } from "./cards/card-builder.js";

// =============================================================================
// OpenCode Bridge
// =============================================================================

export {
  OpenCodeBridge,
  getOpenCodeBridge,
  clearOpenCodeBridge,
  type OpenCodeBridgeOptions,
  type ResponseChunk,
  type ResponseChunkCallback,
  type SessionEvent,
  type SessionEventCallback,
  type ConnectionState,
} from "./opencode-bridge.js";

// =============================================================================
// Thread Manager
// =============================================================================

export {
  TeamsThreadManager,
  getTeamsThreadManager,
  clearTeamsThreadManager,
  type TeamsThreadManagerOptions,
  type ThreadCreationResult,
} from "./teams-thread-manager.js";

// =============================================================================
// Response Streamer
// =============================================================================

export {
  TeamsResponseStreamer,
  getTeamsResponseStreamer,
  clearTeamsResponseStreamer,
  type TeamsResponseStreamerConfig,
  type StreamingSession,
} from "./teams-response-streamer.js";

// =============================================================================
// Command Handler
// =============================================================================

export {
  TeamsCommandHandler,
  createTeamsCommandHandler,
  type CommandResult,
  type CommandContext,
} from "./teams-command-handler.js";

// =============================================================================
// Command Cards
// =============================================================================

export {
  CommandCardBuilder,
  HelpCardBuilder,
  createCommandCard,
  createHelpCard,
  createMessageCard,
  createErrorCard,
  createSuccessCard,
  getDefaultCommands,
  type CommandDefinition,
  type HelpCardConfig,
  type CommandCardConfig,
} from "./cards/command-card.js";

// =============================================================================
// Session Cards
// =============================================================================

export {
  SessionListCardBuilder,
  ModelSelectionCardBuilder,
  CostCardBuilder,
  createSessionListCard,
  createModelSelectionCard,
  createCostCard,
  createCurrentModelCard,
  createModelSelectedCard,
  createStoppedCard,
  createNoSessionsCard,
  type SessionInfo,
  type SessionListCardConfig,
  type ModelSelectionCardConfig,
  type CostCardConfig,
} from "./cards/session-card.js";

// =============================================================================
// Question Cards
// =============================================================================

export {
  QuestionCardBuilder,
  createQuestionCard,
  createQuestionAnsweredCard,
  createQuestionRejectedCard,
  createQuestionExpiredCard,
  type QuestionCardConfig,
  type QuestionOption,
} from "./cards/question-card.js";

// =============================================================================
// Question Handler
// =============================================================================

export {
  TeamsQuestionHandler,
  createTeamsQuestionHandler,
  type TeamsQuestionHandlerOptions,
} from "./teams-question-handler.js";

// =============================================================================
// Permission Cards
// =============================================================================

export {
  PermissionCardBuilder,
  createPermissionCard,
  createPermissionApprovedCard,
  createPermissionDeniedCard,
  createPermissionExpiredCard,
  type PermissionCardConfig,
} from "./cards/permission-card.js";

// =============================================================================
// Permission Handler
// =============================================================================

export {
  TeamsPermissionHandler,
  createTeamsPermissionHandler,
  type TeamsPermissionHandlerOptions,
} from "./teams-permission-handler.js";

// =============================================================================
// Auth Handler
// =============================================================================

export {
  TeamsAuthHandler,
  getTeamsAuthHandler,
  clearTeamsAuthHandler,
  type AuthCheckResult,
} from "./teams-auth.js";

// =============================================================================
// Main Entry Point
// =============================================================================

import { teamsLog } from "./teams-logger.js";
import { getTeamsConfig, logTeamsConfig, validateTeamsConfig } from "./teams-config.js";
import { getTeamsAdapter, validateAdapterConfig } from "./teams-adapter.js";
import { TeamsBot } from "./teams-bot.js";
import { createTeamsServer, type TeamsServer } from "./teams-server.js";
import { getOpenCodeBridge, type OpenCodeBridge } from "./opencode-bridge.js";
import { getTeamsThreadManager, type TeamsThreadManager } from "./teams-thread-manager.js";
import { createTeamsCommandHandler, type TeamsCommandHandler } from "./teams-command-handler.js";
import { createTeamsQuestionHandler, type TeamsQuestionHandler } from "./teams-question-handler.js";
import { createTeamsPermissionHandler, type TeamsPermissionHandler } from "./teams-permission-handler.js";
import { getTeamsAuthHandler, type TeamsAuthHandler } from "./teams-auth.js";
import type { QuestionOption } from "./cards/question-card.js";
import { MessageFactory } from "botbuilder";

export interface StartTeamsBotResult {
  server: TeamsServer;
  bot: TeamsBot;
  bridge: OpenCodeBridge;
  threadManager: TeamsThreadManager;
  commandHandler: TeamsCommandHandler;
  questionHandler: TeamsQuestionHandler;
  permissionHandler: TeamsPermissionHandler;
  authHandler: TeamsAuthHandler;
}

export async function startTeamsBot(): Promise<StartTeamsBotResult> {
  const log = teamsLog.withContext("startTeamsBot");

  log.info("Starting MS Teams bot...");

  const { isValid, errors: configErrors } = validateTeamsConfig();
  if (!isValid) {
    const errorMsg = `Invalid Teams configuration: ${configErrors.join("; ")}`;
    log.error(errorMsg);
    throw new Error(errorMsg);
  }

  const config = getTeamsConfig();
  logTeamsConfig(config);

  if (!validateAdapterConfig()) {
    throw new Error("Invalid adapter configuration. Check Azure credentials.");
  }

  const adapter = getTeamsAdapter();

  const threadManager = getTeamsThreadManager({
    config,
    adapter,
  });

  const bridge = getOpenCodeBridge({
    config,
    onSessionEvent: async (event) => {
      if (event.type === "question_asked" && event.data) {
        const data = event.data;
        if (
          typeof data === "object" &&
          data !== null &&
          "id" in data &&
          "questions" in data &&
          Array.isArray(data.questions)
        ) {
          const threadMapping = threadManager.getThreadBySessionId(event.sessionId);
          if (threadMapping) {
            const conversationRef = threadMapping.conversationReference;
            await adapter.continueConversation(conversationRef, async (turnContext) => {
              await questionHandler.handleQuestionAsked(turnContext, {
                id: String(data.id),
                sessionId: event.sessionId,
                questions: data.questions as Array<{
                  header: string;
                  question: string;
                  options: QuestionOption[];
                  multiple?: boolean;
                  custom?: boolean;
                }>,
              });
            });
          }
        }
      } else if (event.type === "permission_requested" && event.data) {
        const data = event.data;
        if (typeof data === "object" && data !== null && "id" in data) {
          const threadMapping = threadManager.getThreadBySessionId(event.sessionId);
          if (threadMapping) {
            const conversationRef = threadMapping.conversationReference;
            await adapter.continueConversation(conversationRef, async (turnContext) => {
              await permissionHandler.handlePermissionRequested(turnContext, {
                id: String(data.id),
                sessionId: event.sessionId,
                type: (data.type as "bash" | "file_write" | "file_delete" | "other") || "other",
                command: data.command as string | undefined,
                filePath: data.filePath as string | undefined,
                description: (data.description as string) || "Permission required",
              });
            });
          }
        }
      }
      await threadManager.handleSessionEvent(event);
    },
  });

  await threadManager.initialize();
  threadManager.setBridge(bridge);

  const commandHandler = createTeamsCommandHandler(config, bridge);
  const questionHandler = createTeamsQuestionHandler(config);
  const permissionHandler = createTeamsPermissionHandler(config);
  const authHandler = getTeamsAuthHandler(config);

  const bot = new TeamsBot({
    config,
    onMessage: async (context, text) => {
      // Auth check: verify user is in the authorized Azure AD group
      const authResult = await authHandler.checkAuthorization(context);
      if (!authResult.authorized) {
        log.info(`Access denied for user ${authResult.userId}: ${authResult.reason ?? "not_in_group"}`);
        await authHandler.sendAccessDenied(context);
        return;
      }

      const activity = context.activity;
      const replyToId = activity.replyToId;
      const conversationId = activity.conversation?.id ?? "unknown";
      const userId = activity.from?.id ?? "unknown";
      const userName = activity.from?.name ?? "unknown";

      if (replyToId) {
        const result = await threadManager.routeMessageToSession(context, text);
        if (result.handled) {
          log.debug(`Message routed to session: ${result.sessionId}`);
          return;
        }

        if (result.error === "unknown_thread") {
          try {
            const result = await context.sendActivity(
              MessageFactory.text("This thread is not linked to an OpenCode session. Use `!sessions` to see available sessions.")
            );
            log.info(`sendActivity result for 'unknown_thread': ${JSON.stringify(result)}`);
          } catch (sendError) {
            log.error(`sendActivity FAILED for 'unknown_thread': ${sendError}`);
            throw sendError;
          }
          return;
        }
      }

      const threadMapping = replyToId ? threadManager.getThreadByRootMessageId(replyToId) : undefined;
      const sessionId = threadMapping?.openCodeSessionId;

      if (commandHandler.isCommand(text) || commandHandler.isNumericResponse(text, conversationId)) {
        const cmdResult = await commandHandler.handleCommand(text, {
          turnContext: context,
          userId,
          userName,
          conversationId,
          threadId: replyToId,
          sessionId,
        });

        if (cmdResult.handled && cmdResult.card) {
          try {
            const result = await context.sendActivity({ attachments: [cmdResult.card] });
            log.info(`sendActivity result for 'command card': ${JSON.stringify(result)}`);
          } catch (sendError) {
            log.error(`sendActivity FAILED for 'command card': ${sendError}`);
            throw sendError;
          }
          return;
        }
        if (cmdResult.handled && cmdResult.text) {
          try {
            const result = await context.sendActivity(MessageFactory.text(cmdResult.text));
            log.info(`sendActivity result for 'command text': ${JSON.stringify(result)}`);
          } catch (sendError) {
            log.error(`sendActivity FAILED for 'command text': ${sendError}`);
            throw sendError;
          }
          return;
        }
        if (cmdResult.handled) {
          return;
        }
      }

       const sessions = bridge.getSessions();
       if (sessions.length === 0) {
         try {
           const result = await context.sendActivity(
             MessageFactory.text("No OpenCode sessions available. Start an OpenCode session first.")
           );
           log.info(`sendActivity result for 'no sessions': ${JSON.stringify(result)}`);
         } catch (sendError) {
           log.error(`sendActivity FAILED for 'no sessions': ${sendError}`);
           throw sendError;
         }
         return;
       }

       const activeThreads = threadManager
         .getActiveThreadsForUser(userId)
         .filter((thread) => thread.conversationId === conversationId);

       if (activeThreads.length === 1) {
         const thread = activeThreads[0];
         const originalReplyToId = context.activity.replyToId;
         try {
           context.activity.replyToId = thread.threadRootMessageId;
           const routeResult = await threadManager.routeMessageToSession(context, text);
           if (routeResult.handled) {
             return;
           }
         } finally {
           context.activity.replyToId = originalReplyToId;
         }
       }

       if (activeThreads.length > 1) {
         try {
           const result = await context.sendActivity(
             MessageFactory.text(
               `You have ${activeThreads.length} active sessions. Use \`!sessions\` to select one.`
             )
           );
           log.info(`sendActivity result for 'multiple active sessions': ${JSON.stringify(result)}`);
         } catch (sendError) {
           log.error(`sendActivity FAILED for 'multiple active sessions': ${sendError}`);
           throw sendError;
         }
         return;
       }

       if (sessions.length === 1) {
         const session = sessions[0];
         const threadResult = await threadManager.createThreadForSession(context, session);
         log.info(`Created thread ${threadResult.mapping.id} for session ${session.shortId}`);

         const originalReplyToId = context.activity.replyToId;
         try {
           context.activity.replyToId = threadResult.rootMessageId;
           const routeResult = await threadManager.routeMessageToSession(context, text);
           if (routeResult.handled) {
             return;
           }
         } finally {
           context.activity.replyToId = originalReplyToId;
         }
       }

       try {
         const result = await context.sendActivity(
           MessageFactory.text("Multiple sessions available. Use `!sessions` to select one.")
         );
         log.info(`sendActivity result for 'multiple sessions available': ${JSON.stringify(result)}`);
       } catch (sendError) {
         log.error(`sendActivity FAILED for 'multiple sessions available': ${sendError}`);
         throw sendError;
       }
       return;
    },
    onCardAction: async (context, actionData) => {
      log.info(`Card action: verb=${actionData.verb}, keys=[${Object.keys(actionData).join(",")}]`);
      const verb = actionData.verb as string;

      if (verb === "answer_question" || verb === "reject_question") {
        const result = await questionHandler.handleCardAction(context, actionData);
        if ("answered" in result && result.answered) {
          log.info(`Question answered: ${result.questionId}`);
        } else if ("rejected" in result && result.rejected) {
          log.info(`Question rejected: ${result.questionId}`);
        } else if ("error" in result) {
          log.warn(`Question handling error: ${result.error}`);
        }
        return;
      }

      if (verb === "response_page") {
        log.debug(`Pagination action: page=${actionData.page}, session=${actionData.sessionId}`);
        return;
      }

      if (verb === "approve_permission" || verb === "deny_permission") {
        const result = await permissionHandler.handleCardAction(context, actionData);
        if ("approved" in result && result.approved) {
          log.info(`Permission approved: ${result.permissionId}`);
        } else if ("denied" in result && result.denied) {
          log.info(`Permission denied: ${result.permissionId}`);
        } else if ("error" in result) {
          log.warn(`Permission handling error: ${result.error}`);
        }
        return;
      }
    },
  });

  const server = createTeamsServer({
    adapter,
    bot,
    config,
  });

  await server.start();

  await bridge.connect();
  await threadManager.reconnectThreads();

  log.info("MS Teams bot started successfully");

  return { server, bot, bridge, threadManager, commandHandler, questionHandler, permissionHandler, authHandler };
}



/**
 * Convenience function to stop the Teams bot server
 */
export async function stopTeamsBot(server: TeamsServer): Promise<void> {
  const log = teamsLog.withContext("stopTeamsBot");
  log.info("Stopping MS Teams bot...");
  await server.stop();
  log.info("MS Teams bot stopped");
}

// =============================================================================
// Auto-start when run directly (e.g., bun run src/teams/index.ts)
// =============================================================================

const isMainModule =
  typeof Bun !== "undefined"
    ? Bun.main === import.meta.path
    : import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  startTeamsBot()
    .then((result) => {
      const log = teamsLog.withContext("main");
      log.info(`Teams bot running on port ${result.server.port}`);

      const shutdown = async () => {
        log.info("Shutting down...");
        await stopTeamsBot(result.server);
        result.bridge.disconnect();
        result.questionHandler.destroy?.();
        result.permissionHandler.destroy();
        result.authHandler.destroy();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("Failed to start Teams bot:", err);
      process.exit(1);
    });
}
