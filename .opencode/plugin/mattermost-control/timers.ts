import { PluginState } from "./state.js";
import { formatFullResponse } from "./formatters.js";
import { log } from "../../../src/logger.js";

export const TOOL_UPDATE_INTERVAL_MS = 1000;
export const QUESTION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const QUESTION_EXPIRY_MS = 30 * 60 * 1000;

export async function updateResponseStream(sessionId: string): Promise<void> {
  const ctx = PluginState.activeResponseContexts.get(sessionId);
  if (!ctx || !PluginState.streamer) return;
  
  const formattedOutput = formatFullResponse(ctx, log.info.bind(log));
  
  try {
    await PluginState.streamer.updateStream(ctx.streamCtx, formattedOutput);
  } catch (e) {
    log.error("Failed to update stream:", e);
  }
}

export function startActiveToolTimer(sessionId: string): void {
  if (PluginState.activeToolTimers.has(sessionId)) return;
  
  const timer = setInterval(async () => {
    const ctx = PluginState.activeResponseContexts.get(sessionId);
    if (!ctx?.activeTool) {
      stopActiveToolTimer(sessionId);
      return;
    }
    await updateResponseStream(sessionId);
  }, TOOL_UPDATE_INTERVAL_MS);
  
  PluginState.activeToolTimers.set(sessionId, timer);
}

export function stopActiveToolTimer(sessionId: string): void {
  const timer = PluginState.activeToolTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    PluginState.activeToolTimers.delete(sessionId);
  }
}

export function startResponseTimer(sessionId: string): void {
  if (PluginState.activeResponseTimers.has(sessionId)) return;
  
  const timer = setInterval(async () => {
    const ctx = PluginState.activeResponseContexts.get(sessionId);
    if (!ctx) {
      stopResponseTimer(sessionId);
      return;
    }
    await updateResponseStream(sessionId);
  }, TOOL_UPDATE_INTERVAL_MS);
  
  PluginState.activeResponseTimers.set(sessionId, timer);
}

export function stopResponseTimer(sessionId: string): void {
  const timer = PluginState.activeResponseTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    PluginState.activeResponseTimers.delete(sessionId);
  }
}

export function startQuestionCleanupTimer(): void {
  if (PluginState.questionCleanupTimer) return;
  
  const timer = setInterval(async () => {
    if (PluginState.questionHandler) {
      const syncResult = await PluginState.questionHandler.syncWithServer();
      if (syncResult.removed > 0) {
        log.info(`[QuestionHandler] Sync removed ${syncResult.removed} stale questions (server has ${syncResult.synced} pending)`);
      }
      
      const cleaned = PluginState.questionHandler.cleanupExpired(QUESTION_EXPIRY_MS);
      if (cleaned > 0) {
        log.info(`[QuestionHandler] Cleaned up ${cleaned} expired questions`);
      }
    }
  }, QUESTION_CLEANUP_INTERVAL_MS);
  
  PluginState.setQuestionCleanupTimer(timer);
  log.debug("[QuestionHandler] Started cleanup timer");
}

export function stopQuestionCleanupTimer(): void {
  const timer = PluginState.questionCleanupTimer;
  if (timer) {
    clearInterval(timer);
    PluginState.setQuestionCleanupTimer(null);
    log.debug("[QuestionHandler] Stopped cleanup timer");
  }
}
