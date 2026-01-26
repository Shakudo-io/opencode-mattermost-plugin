/**
 * Question event handler - handles question.asked events from OpenCode
 */

import { PluginState } from "../state.js";
import { formatFullResponse } from "../formatters.js";
import type { QuestionRequest } from "../../../../src/question-handler.js";
import { log } from "../../../../src/logger.js";

function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handleQuestionAsked(event: any): Promise<void> {
  const { questionHandler, threadMappingStore, streamer, isConnected } = PluginState;
  
  if (!questionHandler || !isConnected) return;
  
  const props = event.properties;
  const eventSessionId = props?.sessionID;
  
  // Skip question handling for scheduled task sessions - they can't ask questions via DM
  if (eventSessionId && isScheduledTaskSession(eventSessionId)) {
    log.debug(`[ScheduledTask] Suppressing question.asked for scheduled task session ${eventSessionId.substring(0, 8)}`);
    return;
  }
  
  log.info(`[QuestionHandler] question.asked event: sessionId=${eventSessionId}, requestId=${props?.id}`);
  
  if (!eventSessionId || !props?.id || !props?.questions) return;
  
  // First try thread mapping (per-session thread mode)
  const mapping = threadMappingStore?.getBySessionId(eventSessionId);
  let targetChannelId: string | undefined;
  let targetThreadId: string | undefined;
  
  if (mapping && mapping.status === "active") {
    targetChannelId = mapping.channelId || mapping.dmChannelId;
    targetThreadId = mapping.threadRootPostId;
    log.debug(`[QuestionHandler] Using thread mapping: channel=${targetChannelId}, thread=${targetThreadId}`);
  } else {
    // Fall back to active response context (main DM thread mode)
    const ctx = PluginState.activeResponseContexts.get(eventSessionId);
    if (ctx && ctx.threadRootPostId) {
      targetChannelId = ctx.streamCtx?.channelId || ctx.mmSession?.dmChannelId;
      targetThreadId = ctx.threadRootPostId;
      log.debug(`[QuestionHandler] Using active response context: channel=${targetChannelId}, thread=${targetThreadId}`);
    }
  }
  
  if (!targetChannelId || !targetThreadId) {
    log.debug(`[QuestionHandler] No active thread context for session ${eventSessionId}`);
    return;
  }
  
  const questionRequest: QuestionRequest = {
    id: props.id,
    sessionID: eventSessionId,
    questions: props.questions,
  };
  
  try {
    const ctx = PluginState.activeResponseContexts.get(eventSessionId);
    if (ctx && streamer) {
      const oldContent = formatFullResponse(ctx);
      const newStreamCtx = await streamer.recreateStreamAtBottom(ctx.streamCtx, oldContent);
      ctx.streamCtx = newStreamCtx;
      log.debug(`[QuestionHandler] Recreated stream before question, new postId=${newStreamCtx.postId}`);
    }
    
    await questionHandler.handleQuestionAsked(
      questionRequest,
      targetChannelId,
      targetThreadId
    );
    log.info(`[QuestionHandler] Posted question ${props.id} to thread ${targetThreadId}`);
    
    // Don't recreate stream after question - let the question be the last visible post
    // The user needs to see and answer the question without it being buried
    // The stream will resume when the question is answered
    if (ctx && ctx.streamCtx.statusIndicator) {
      const firstQuestion = props.questions[0];
      await ctx.streamCtx.statusIndicator.setWaiting(
        "question", 
        firstQuestion?.question || "Waiting for your answer..."
      );
    }
  } catch (e) {
    log.error(`[QuestionHandler] Failed to post question:`, e);
  }
}
