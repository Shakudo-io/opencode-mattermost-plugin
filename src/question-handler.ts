import type { MattermostClient } from "./clients/mattermost-client.js";
import { log } from "./logger.js";
import type { PendingInteractionsPgStore } from "./persistence/postgres/pending-interactions-pg.js";
import type { QuestionData } from "./persistence/postgres/schema.js";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  intro?: string;
  tool?: {
    messageID: string;
    callID: string;
  };
}

interface PendingQuestion {
  request: QuestionRequest;
  channelId: string;
  threadRootPostId?: string;
  questionPostId: string;
  createdAt: number;
  currentQuestionIndex: number;
  answers: string[][];
}

// OpenCode server question response structure
interface OpenCodeQuestion {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
}

export class QuestionHandler {
  private mmClient: MattermostClient;
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private sessionToQuestion: Map<string, string> = new Map();
  private opencodeBaseUrl: string = "";
  private opencodeDirectory: string = "";
  private pgStore: PendingInteractionsPgStore | null = null;

  constructor(mmClient: MattermostClient) {
    this.mmClient = mmClient;
  }

  /**
   * Set the Postgres store for dual-write support.
   * When set, pending questions will be written to both local Map and Postgres.
   */
  setPgStore(store: PendingInteractionsPgStore): void {
    this.pgStore = store;
    log.info(`[QuestionHandler] Postgres store configured for dual-write`);
  }

  /**
   * Configure the OpenCode server connection for question state verification.
   */
  setOpenCodeConfig(baseUrl: string, directory: string): void {
    this.opencodeBaseUrl = baseUrl;
    this.opencodeDirectory = directory;
    log.info(`[QuestionHandler] OpenCode config set: baseUrl=${baseUrl}`);
  }

  async handleQuestionAsked(
    request: QuestionRequest,
    channelId: string,
    threadRootPostId?: string
  ): Promise<string> {
    log.info(`[QuestionHandler] Received question request: ${request.id} with ${request.questions.length} question(s)`);

    const formattedMessage = this.formatQuestionPost(request, 0);
    
    const post = await this.mmClient.createPost(
      channelId,
      formattedMessage,
      threadRootPostId
    );

    const pending: PendingQuestion = {
      request,
      channelId,
      threadRootPostId,
      questionPostId: post.id,
      createdAt: Date.now(),
      currentQuestionIndex: 0,
      answers: request.questions.map(() => []),
    };

    this.pendingQuestions.set(request.id, pending);
    this.sessionToQuestion.set(request.sessionID, request.id);

    if (this.pgStore) {
      try {
        const currentQuestion = request.questions[0];
        await this.pgStore.createQuestion({
          id: request.id,
          thread_root_post_id: threadRootPostId || "",
          opencode_session_id: request.sessionID,
          question_post_id: post.id,
          question_data: {
            header: currentQuestion.header,
            question: currentQuestion.question,
            options: currentQuestion.options.map((opt) => ({
              label: opt.label,
              description: opt.description,
            })),
            multiple: currentQuestion.multiple,
          },
        });
      } catch (e) {
        log.warn(`[QuestionHandler] Failed to write question to Postgres: ${e}`);
      }
    }

    log.info(`[QuestionHandler] Posted question ${request.id} as post ${post.id}`);
    return post.id;
  }

  private formatQuestionPost(request: QuestionRequest, questionIndex: number): string {
    const q = request.questions[questionIndex];
    const totalQuestions = request.questions.length;
    
    let message = "";

    if (request.intro) {
      message += `${request.intro}`;
    }
    
    if (totalQuestions > 1) {
      message += `### ❓ Question ${questionIndex + 1}/${totalQuestions}: ${q.header}\n\n`;
    } else {
      message += `### ❓ ${q.header}\n\n`;
    }
    
    message += `${q.question}\n\n`;
    
    q.options.forEach((opt, idx) => {
      message += `**${idx + 1}.** ${opt.label}`;
      if (opt.description) {
        message += ` - _${opt.description}_`;
      }
      message += "\n";
    });

    const allowCustom = q.custom !== false;
    if (allowCustom) {
      message += `**${q.options.length + 1}.** Other - _Type your own answer_\n`;
    }
    
    message += "\n---\n";
    
    if (q.multiple) {
      message += "_Reply with one or more numbers separated by commas (e.g., `1, 3`) or type your answer_\n";
    } else {
      message += "_Reply with a number or type your answer_\n";
    }
    message += "_Use `!reject` to skip this question_";

    return message;
  }

  async handleUserReply(
    sessionId: string,
    userMessage: string,
    channelId: string,
    threadRootPostId?: string
  ): Promise<{ handled: boolean; answers?: string[][]; requestId?: string; rejected?: boolean }> {
    const questionId = this.sessionToQuestion.get(sessionId);
    if (!questionId) {
      return { handled: false };
    }

    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      this.sessionToQuestion.delete(sessionId);
      return { handled: false };
    }

    if (channelId !== pending.channelId) {
      return { handled: false };
    }

    const trimmedMessage = userMessage.trim();
    const lowerMessage = trimmedMessage.toLowerCase();
    const isRejectCommand = lowerMessage === "!reject" || lowerMessage === "!cancel";
    
    if (isRejectCommand) {
      this.pendingQuestions.delete(questionId);
      this.sessionToQuestion.delete(sessionId);
      
      await this.mmClient.createPost(
        channelId,
        `:x: Question rejected. The AI will receive an empty response.`,
        threadRootPostId
      );
      
      log.info(`[QuestionHandler] Question ${questionId} rejected by user`);
      
      return {
        handled: true,
        answers: pending.request.questions.map(() => []),
        requestId: questionId,
        rejected: true,
      };
    }
    const currentQuestion = pending.request.questions[pending.currentQuestionIndex];
    
    const selectedLabels = this.parseUserResponse(trimmedMessage, currentQuestion);
    
    if (selectedLabels.length === 0) {
      await this.mmClient.createPost(
        channelId,
        `⚠️ I didn't understand your response. Please reply with a number (1-${currentQuestion.options.length + 1}) or type your answer.`,
        threadRootPostId
      );
      return { handled: true };
    }

    pending.answers[pending.currentQuestionIndex] = selectedLabels;
    
    if (pending.currentQuestionIndex < pending.request.questions.length - 1) {
      pending.currentQuestionIndex++;
      const nextQuestionMessage = this.formatQuestionPost(pending.request, pending.currentQuestionIndex);
      await this.mmClient.createPost(channelId, nextQuestionMessage, threadRootPostId);
      return { handled: true };
    }

    this.pendingQuestions.delete(questionId);
    this.sessionToQuestion.delete(sessionId);

    if (this.pgStore) {
      try {
        await this.pgStore.answerQuestion(questionId, JSON.stringify(pending.answers));
      } catch (e) {
        log.warn(`[QuestionHandler] Failed to update question in Postgres: ${e}`);
      }
    }

    const selectionSummary = pending.answers.map((ans, idx) => {
      const q = pending.request.questions[idx];
      return `**${q.header}**: ${ans.join(", ")}`;
    }).join("\n");
    
    await this.mmClient.createPost(
      channelId,
      `✅ Got it!\n${selectionSummary}`,
      threadRootPostId
    );

    log.info(`[QuestionHandler] Question ${questionId} answered: ${JSON.stringify(pending.answers)}`);

    return {
      handled: true,
      answers: pending.answers,
      requestId: questionId,
    };
  }

  private parseUserResponse(message: string, question: QuestionInfo): string[] {
    const selectedLabels: string[] = [];
    const allowCustom = question.custom !== false;
    const otherOptionNumber = question.options.length + 1;

    const numberPattern = /^[\d,\s]+$/;
    if (numberPattern.test(message)) {
      const numbers = message.split(/[,\s]+/).map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
      
      for (const num of numbers) {
        if (num >= 1 && num <= question.options.length) {
          selectedLabels.push(question.options[num - 1].label);
        } else if (allowCustom && num === otherOptionNumber) {
          return [];
        }
      }
      
      if (selectedLabels.length > 0) {
        return question.multiple ? selectedLabels : [selectedLabels[0]];
      }
    }

    for (const opt of question.options) {
      if (opt.label.toLowerCase() === message.toLowerCase()) {
        return [opt.label];
      }
    }

    if (allowCustom && message.length > 0) {
      return [message];
    }

    return [];
  }

  hasPendingQuestion(sessionId: string): boolean {
    return this.sessionToQuestion.has(sessionId);
  }

  /**
   * Verify with OpenCode server that a question is still pending.
   * Returns true only if both plugin AND server have the question pending.
   * If the server no longer has the question, cleans up plugin state.
   */
  async verifyQuestionStillPending(sessionId: string): Promise<{
    pending: boolean;
    reason?: "no_plugin_state" | "server_no_longer_pending" | "server_error";
  }> {
    const questionId = this.sessionToQuestion.get(sessionId);
    if (!questionId) {
      return { pending: false, reason: "no_plugin_state" };
    }

    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      this.sessionToQuestion.delete(sessionId);
      return { pending: false, reason: "no_plugin_state" };
    }

    if (!this.opencodeBaseUrl) {
      log.warn(`[QuestionHandler] OpenCode config not set, assuming question ${questionId} is still pending`);
      return { pending: true };
    }

    try {
      const response = await fetch(`${this.opencodeBaseUrl}/question`, {
        method: "GET",
        headers: {
          "x-opencode-directory": this.opencodeDirectory,
        },
      });

      if (!response.ok) {
        log.warn(`[QuestionHandler] Failed to fetch server questions: HTTP ${response.status}`);
        return { pending: true };
      }

      const serverQuestions: OpenCodeQuestion[] = await response.json();
      const isStillPending = serverQuestions.some(q => q.id === questionId);

      if (!isStillPending) {
        log.info(`[QuestionHandler] Question ${questionId} no longer pending on server, cleaning up plugin state`);
        this.pendingQuestions.delete(questionId);
        this.sessionToQuestion.delete(sessionId);
        return { pending: false, reason: "server_no_longer_pending" };
      }

      return { pending: true };
    } catch (error) {
      log.error(`[QuestionHandler] Error verifying question state:`, error);
      return { pending: true };
    }
  }

  getPendingQuestionId(sessionId: string): string | undefined {
    return this.sessionToQuestion.get(sessionId);
  }

  getPendingQuestionInfo(sessionId: string): PendingQuestion | undefined {
    const questionId = this.sessionToQuestion.get(sessionId);
    if (!questionId) return undefined;
    return this.pendingQuestions.get(questionId);
  }

  cancelQuestion(questionId: string): void {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      this.sessionToQuestion.delete(pending.request.sessionID);
      this.pendingQuestions.delete(questionId);

      if (this.pgStore) {
        this.pgStore.cancelQuestion(questionId).catch((e) => {
          log.warn(`[QuestionHandler] Failed to cancel question in Postgres: ${e}`);
        });
      }

      log.info(`[QuestionHandler] Cancelled question ${questionId}`);
    }
  }

  cancelSessionQuestions(sessionId: string): void {
    const questionId = this.sessionToQuestion.get(sessionId);
    if (questionId) {
      this.cancelQuestion(questionId);
    }
  }

  cleanupExpired(maxAgeMs: number = 30 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, pending] of this.pendingQuestions.entries()) {
      if (now - pending.createdAt > maxAgeMs) {
        this.sessionToQuestion.delete(pending.request.sessionID);
        this.pendingQuestions.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      log.info(`[QuestionHandler] Cleaned up ${cleaned} expired questions`);
    }
    
    return cleaned;
  }

  async syncWithServer(): Promise<{ synced: number; removed: number }> {
    if (!this.opencodeBaseUrl) {
      return { synced: 0, removed: 0 };
    }

    let removed = 0;

    try {
      const response = await fetch(`${this.opencodeBaseUrl}/question`, {
        method: "GET",
        headers: {
          "x-opencode-directory": this.opencodeDirectory,
        },
      });

      if (!response.ok) {
        log.warn(`[QuestionHandler] Failed to sync with server: HTTP ${response.status}`);
        return { synced: 0, removed: 0 };
      }

      const serverQuestions: OpenCodeQuestion[] = await response.json();
      const serverQuestionIds = new Set(serverQuestions.map(q => q.id));

      for (const [questionId, pending] of this.pendingQuestions.entries()) {
        if (!serverQuestionIds.has(questionId)) {
          log.info(`[QuestionHandler] Sync: Question ${questionId} no longer on server, removing`);
          this.sessionToQuestion.delete(pending.request.sessionID);
          this.pendingQuestions.delete(questionId);
          removed++;
        }
      }

      return { synced: serverQuestions.length, removed };
    } catch (error) {
      log.error(`[QuestionHandler] Error syncing with server:`, error);
      return { synced: 0, removed: 0 };
    }
  }
}
