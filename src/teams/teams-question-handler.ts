/**
 * Teams Question Handler
 *
 * Manages AI question tool support for MS Teams:
 * - Posts question cards to threads
 * - Handles card action submissions (answer/reject)
 * - Tracks pending questions with expiration
 * - Cleans up expired questions automatically
 */

import { TurnContext, MessageFactory } from "botbuilder";
import type { TeamsConfig } from "./teams-config.js";
import { teamsLog } from "./teams-logger.js";
import {
  type PendingQuestion,
  type PendingQuestionStatus,
  type QuestionOption,
  createDefaultPendingQuestion,
} from "../models/teams-types.js";
import {
  createQuestionCard,
  createQuestionAnsweredCard,
  createQuestionRejectedCard,
  createQuestionExpiredCard,
} from "./cards/question-card.js";

export interface TeamsQuestionHandlerOptions {
  config: TeamsConfig;
  expirationMs?: number;
}

export class TeamsQuestionHandler {
  private readonly log = teamsLog.withContext("TeamsQuestionHandler");
  private readonly config: TeamsConfig;
  private readonly expirationMs: number;
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly sessionToQuestion = new Map<string, string>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: TeamsQuestionHandlerOptions) {
    this.config = options.config;
    this.expirationMs = options.expirationMs ?? this.config.bot.questionExpirationMs;

    this.startCleanupTimer();
    this.log.info(`QuestionHandler initialized (expiration: ${this.expirationMs}ms)`);
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 60000);
  }

  async handleQuestionAsked(
    context: TurnContext,
    questionData: {
      id: string;
      sessionId: string;
      questions: Array<{
        header: string;
        question: string;
        options: QuestionOption[];
        multiple?: boolean;
        custom?: boolean;
      }>;
    }
  ): Promise<PendingQuestion> {
    const { id, sessionId, questions } = questionData;
    const firstQuestion = questions[0];

    this.log.info(`Question asked: ${id} with ${questions.length} question(s)`);

    const activity = await context.sendActivity({
      attachments: [
        createQuestionCard({
          questionId: id,
          sessionId,
          header: firstQuestion.header,
          question: firstQuestion.question,
          options: firstQuestion.options,
          multiple: firstQuestion.multiple ?? false,
          custom: firstQuestion.custom,
          questionIndex: 0,
          totalQuestions: questions.length,
        }),
      ],
    });

    const pending = createDefaultPendingQuestion({
      sessionId,
      threadRootMessageId: context.activity.replyToId ?? context.activity.id ?? "",
      questionData: {
        header: firstQuestion.header,
        question: firstQuestion.question,
        options: firstQuestion.options,
        multiple: firstQuestion.multiple ?? false,
      },
    });

    pending.id = id;
    pending.questionCardId = activity?.id;

    this.pendingQuestions.set(id, pending);
    this.sessionToQuestion.set(sessionId, id);

    return pending;
  }

  async handleCardAction(
    context: TurnContext,
    actionData: Record<string, unknown>
  ): Promise<
    | { answered: true; questionId: string; answers: string[][] }
    | { rejected: true; questionId: string }
    | { error: string }
  > {
    const verb = actionData.verb as string;
    const questionId = actionData.questionId as string;
    const sessionId = actionData.sessionId as string;

    if (!questionId || !sessionId) {
      this.log.warn(`Card action missing questionId or sessionId`);
      return { error: "missing_ids" };
    }

    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      this.log.warn(`Question not found: ${questionId}`);
      await context.sendActivity(
        MessageFactory.text("⚠️ This question is no longer pending or has expired.")
      );
      return { error: "not_found" };
    }

    const now = new Date();
    const expiresAt = new Date(pending.expiresAt);
    if (now > expiresAt) {
      this.log.info(`Question expired: ${questionId}`);
      this.pendingQuestions.delete(questionId);
      this.sessionToQuestion.delete(sessionId);

      await context.updateActivity({
        ...context.activity,
        id: pending.questionCardId ?? context.activity.replyToId ?? context.activity.id ?? "",
        attachments: [createQuestionExpiredCard(pending.questionData.header)],
      });

      return { error: "expired" };
    }

    if (verb === "reject_question") {
      this.log.info(`Question rejected: ${questionId}`);
      pending.status = "rejected";
      this.pendingQuestions.delete(questionId);
      this.sessionToQuestion.delete(sessionId);

      await context.updateActivity({
        ...context.activity,
        id: pending.questionCardId ?? context.activity.replyToId ?? context.activity.id ?? "",
        attachments: [createQuestionRejectedCard(pending.questionData.header)],
      });

      return { rejected: true, questionId };
    }

    if (verb === "answer_question") {
      const selectedOptions = (actionData.selectedOptions as string | string[]) ?? [];
      const customAnswer = actionData.customAnswer as string | undefined;

      const selectedArray = Array.isArray(selectedOptions)
        ? selectedOptions
        : selectedOptions
          ? [selectedOptions]
          : [];

      const answer = customAnswer && customAnswer.trim() ? [customAnswer.trim()] : selectedArray;

      if (answer.length === 0) {
        await context.sendActivity(
          MessageFactory.text(
            "⚠️ Please select at least one option or provide a custom answer."
          )
        );
        return { error: "no_answer" };
      }

      this.log.info(`Question answered: ${questionId} with ${JSON.stringify(answer)}`);
      pending.status = "answered";
      pending.answeredAt = now.toISOString();
      pending.answer = {
        selectedOptions: answer,
        customAnswer: customAnswer?.trim(),
      };

      this.pendingQuestions.delete(questionId);
      this.sessionToQuestion.delete(sessionId);

      await context.updateActivity({
        ...context.activity,
        id: pending.questionCardId ?? context.activity.replyToId ?? context.activity.id ?? "",
        attachments: [createQuestionAnsweredCard(pending.questionData.header, answer)],
      });

      return { answered: true, questionId, answers: [answer] };
    }

    return { error: "unknown_verb" };
  }

  hasPendingQuestion(sessionId: string): boolean {
    return this.sessionToQuestion.has(sessionId);
  }

  getPendingQuestion(sessionId: string): PendingQuestion | undefined {
    const questionId = this.sessionToQuestion.get(sessionId);
    if (!questionId) return undefined;
    return this.pendingQuestions.get(questionId);
  }

  cancelQuestion(questionId: string): void {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      this.sessionToQuestion.delete(pending.sessionId);
      this.pendingQuestions.delete(questionId);
      this.log.info(`Question cancelled: ${questionId}`);
    }
  }

  cancelSessionQuestions(sessionId: string): void {
    const questionId = this.sessionToQuestion.get(sessionId);
    if (questionId) {
      this.cancelQuestion(questionId);
    }
  }

  cleanupExpired(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [id, pending] of this.pendingQuestions.entries()) {
      const expiresAt = new Date(pending.expiresAt);
      if (now > expiresAt) {
        this.sessionToQuestion.delete(pending.sessionId);
        this.pendingQuestions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.log.info(`Cleaned up ${cleaned} expired questions`);
    }

    return cleaned;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.log.info("QuestionHandler destroyed");
  }
}

export function createTeamsQuestionHandler(config: TeamsConfig): TeamsQuestionHandler {
  return new TeamsQuestionHandler({ config });
}
