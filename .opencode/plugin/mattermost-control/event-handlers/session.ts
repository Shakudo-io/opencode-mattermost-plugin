import { PluginState } from "../state.js";
import { formatFullResponse } from "../formatters.js";
import { stopActiveToolTimer, stopResponseTimer } from "../timers.js";
import { handleMonitorAlert } from "../../../../src/monitor-service.js";
import { log } from "../../../../src/logger.js";

function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handleSessionIdle(event: any): Promise<void> {
  const eventSessionId = event.properties?.sessionID;
  
  // Handle monitor alerts (skip for scheduled tasks - they don't need idle alerts)
  log.debug(`[Monitor] session.idle event: sessionId=${eventSessionId}`);
  if (eventSessionId && !isScheduledTaskSession(eventSessionId)) {
    const activeSessionIds = Array.from(PluginState.activeResponseContexts.keys());
    await handleMonitorAlert(eventSessionId, "session.idle", undefined, activeSessionIds[0]);
  }
  
  // Handle stream finalization
  const { streamer, notifications, isConnected } = PluginState;
  if (!isConnected || !streamer || !notifications) return;
  
  if (!eventSessionId) return;
  
  // Skip stream finalization for scheduled task sessions
  if (isScheduledTaskSession(eventSessionId)) {
    log.debug(`[ScheduledTask] Suppressing session.idle finalization for scheduled task session ${eventSessionId.substring(0, 8)}`);
    return;
  }
  
  const ctx = PluginState.activeResponseContexts.get(eventSessionId);
  if (!ctx) return;
  
  // v0.2.70 fix: Don't finalize if we're awaiting continuation after compaction
  if (ctx.awaitingContinuation) {
    log.info(`[Compaction] Session ${eventSessionId.substring(0, 8)} idle but awaitingContinuation=true, skipping finalization`);
    return;
  }
  if (ctx.inCompactionSummary) {
    log.info(`[Compaction] Session ${eventSessionId.substring(0, 8)} idle but inCompactionSummary=true, skipping finalization`);
    return;
  }
  
  log.info(`[MessageParts] Session ${eventSessionId.substring(0, 8)} completed: textParts=${ctx.textPartCount || 0}, reasoningParts=${ctx.reasoningPartCount || 0}, responseLen=${ctx.responseBuffer.length}, thinkingLen=${ctx.thinkingBuffer.length}, tools=${ctx.toolCalls.length}, compactions=${ctx.compactionCount}, todos=${ctx.todos.length}, cost=$${(ctx.cost.sessionTotal + ctx.cost.currentMessage).toFixed(4)}`);
  log.info(`[FinalBash] lastBashOutput: ${ctx.lastBashOutput?.length || 0} chars, lastBashCommand: ${ctx.lastBashCommand?.substring(0, 50) || 'none'}`);
  
  try {
    stopActiveToolTimer(eventSessionId);
    stopResponseTimer(eventSessionId);
    
    ctx.streamCtx.buffer = formatFullResponse(ctx, log.info.bind(log));
    await streamer.endStream(ctx.streamCtx);
    await notifications.notifyCompletion(ctx.mmSession, "Response complete", ctx.streamCtx.threadRootPostId);
    ctx.mmSession.isProcessing = false;
    
    // Release thread claim after processing completes
    const { threadMappingStore } = PluginState;
    const pgStore = threadMappingStore?.getPgStore();
    const instanceId = threadMappingStore?.getInstanceId() ?? "local";
    const threadRootPostId = ctx.streamCtx.threadRootPostId;
    
    if (pgStore && threadRootPostId) {
      await pgStore.releaseThread(threadRootPostId, instanceId);
      log.debug(`[ThreadClaim] Released claim on thread ${threadRootPostId}`);
    }
  } catch (e) {
    log.error("Error finalizing stream:", e);
  }
  PluginState.activeResponseContexts.delete(eventSessionId);
}

export async function handleSessionStatus(event: any): Promise<void> {
  const eventSessionId = event.properties?.sessionID;
  if (!eventSessionId || !PluginState.isConnected) return;
  
  // Skip status updates for scheduled task sessions
  if (isScheduledTaskSession(eventSessionId)) {
    log.debug(`[ScheduledTask] Suppressing session.status for scheduled task session ${eventSessionId.substring(0, 8)}`);
    return;
  }
  
  const status = event.properties?.status as { type: string; attempt?: number; maxAttempts?: number; error?: string } | undefined;
  const ctx = PluginState.activeResponseContexts.get(eventSessionId);
  
  if (!ctx?.streamCtx.statusIndicator || !status) return;
  
  log.debug(`[StatusEvent] Session ${eventSessionId.substring(0, 8)} status: ${status.type}`);
  
  switch (status.type) {
    case "busy":
      await ctx.streamCtx.statusIndicator.setProcessing();
      break;
    case "retry":
      await ctx.streamCtx.statusIndicator.setRetrying(
        status.attempt || 1,
        status.maxAttempts || 3,
        status.error || "Transient error",
        5000
      );
      break;
    case "idle":
      // No action needed
      break;
  }
}
