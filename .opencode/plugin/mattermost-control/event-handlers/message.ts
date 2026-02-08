/**
 * Message event handlers - handles message.updated and message.part.updated events
 */

import { PluginState } from "../state.js";
import { formatFullResponse } from "../formatters.js";
import { updateResponseStream } from "../timers.js";
import { log } from "../../../../src/logger.js";

/**
 * Check if a session is running a scheduled task.
 * If so, streaming updates should be suppressed to prevent routing to wrong threads.
 */
function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handleMessageUpdated(event: any): Promise<void> {
  const msgInfo = event.properties?.info;
  if (msgInfo?.role !== "assistant" || !msgInfo?.sessionID) return;
  
  // Skip streaming updates for scheduled task sessions to prevent routing to wrong threads
  if (isScheduledTaskSession(msgInfo.sessionID)) {
    log.debug(`[ScheduledTask] Suppressing message.updated for scheduled task session ${msgInfo.sessionID.substring(0, 8)}`);
    return;
  }
  
  const ctx = PluginState.activeResponseContexts.get(msgInfo.sessionID);
  if (!ctx) return;
  
  if (msgInfo.agent) {
    ctx.agentName = msgInfo.agent;
  }
  
  // Detect compaction summary messages
  if (msgInfo.agent === "compaction" || msgInfo.summary === true) {
    log.info(`[Compaction] Detected compaction summary message for session ${msgInfo.sessionID.substring(0, 8)}, suppressing text accumulation`);
    ctx.inCompactionSummary = true;
  }
  
  // Update cost tracking
  ctx.cost.currentMessage = msgInfo.cost || 0;
  if (msgInfo.tokens) {
    ctx.cost.tokens = {
      input: msgInfo.tokens.input || 0,
      output: msgInfo.tokens.output || 0,
      reasoning: msgInfo.tokens.reasoning || 0,
      cache: {
        read: msgInfo.tokens.cache?.read || 0,
        write: msgInfo.tokens.cache?.write || 0,
      },
    };
  }
  
  await updateResponseStream(msgInfo.sessionID);
}

export async function handleMessagePartUpdated(event: any): Promise<void> {
  const { streamer, isConnected } = PluginState;
  if (!isConnected || !streamer) return;
  
  const part = event.properties?.part;
  const delta = event.properties?.delta;
  const sessionId = part?.sessionID || event.properties?.sessionID;
  
  if (!sessionId) return;
  
  // Skip streaming updates for scheduled task sessions
  if (isScheduledTaskSession(sessionId)) {
    log.debug(`[ScheduledTask] Suppressing message.part.updated for scheduled task session ${sessionId.substring(0, 8)}`);
    return;
  }
  
  const ctx = PluginState.activeResponseContexts.get(sessionId);
  if (!ctx) return;
  
  // Log all incoming part types for debugging reasoning visibility
  if (part?.type) {
    log.debug(`[PartDebug] session=${sessionId?.substring(0,8)} part.type=${part.type} delta=${delta?.length ?? 'null'} thinkingBuffer=${ctx.thinkingBuffer.length}`);
  }
  
  let shouldUpdate = false;
  
  if (part?.type === "text" && delta) {
    // Skip compaction summary text
    if (ctx.inCompactionSummary) {
      log.debug(`[Compaction] Suppressing compaction summary text for session ${sessionId.substring(0, 8)}`);
      return;
    }
    // Reset awaiting continuation flag when real content arrives
    if (ctx.awaitingContinuation) {
      log.info(`[Compaction] Continuation content received, resetting awaitingContinuation for session ${sessionId.substring(0, 8)}`);
      ctx.awaitingContinuation = false;
    }
    ctx.responseBuffer += delta;
    ctx.textPartCount = (ctx.textPartCount || 0) + 1;
    shouldUpdate = true;
  } else if (part?.type === "reasoning" && delta != null) {
    // Skip compaction summary reasoning
    if (ctx.inCompactionSummary) {
      log.debug(`[Compaction] Suppressing compaction summary reasoning for session ${sessionId.substring(0, 8)}`);
      return;
    }
    if (ctx.awaitingContinuation) {
      log.info(`[Compaction] Continuation reasoning received, resetting awaitingContinuation for session ${sessionId.substring(0, 8)}`);
      ctx.awaitingContinuation = false;
    }
    if (delta) ctx.thinkingBuffer += delta;
    ctx.reasoningPartCount = (ctx.reasoningPartCount || 0) + 1;
    shouldUpdate = true;
    log.info(`[Reasoning] Captured reasoning delta (${delta?.length || 0} chars), total buffer: ${ctx.thinkingBuffer.length} chars`);
  } else if (part?.type === "tool" && part?.tool === "bash") {
    const status = part?.state?.status;
    const shellOutput = part.state.metadata?.output || part.state?.output || part.output;
    const command = part?.state?.input?.command || part?.input?.command || part?.args?.command;
    
    log.info(`[BashStream] status=${status}, output=${shellOutput?.length || 0} chars, command=${command?.substring(0, 50) || 'none'}`);
    log.info(`[BashStream] part keys: ${Object.keys(part || {}).join(', ')}, state keys: ${Object.keys(part?.state || {}).join(', ')}`);
    
    if (command && !ctx.bashCommand) {
      ctx.bashCommand = command;
    }
    
    if (status === "running") {
      if (shellOutput && shellOutput !== ctx.shellOutput) {
        ctx.shellOutput = shellOutput;
        ctx.shellOutputLastUpdate = Date.now();
        shouldUpdate = true;
      }
    } else if (status === "completed" || status === "done") {
      if (shellOutput) {
        ctx.shellOutput = shellOutput;
        ctx.lastBashOutput = shellOutput;
        ctx.lastBashCommand = ctx.bashCommand;
        ctx.shellOutputLastUpdate = Date.now();
        ctx.completedBashOutputs.push({ command: ctx.bashCommand || "", output: shellOutput });
        log.info(`[BashStream] Captured final output: ${shellOutput.length} chars, command: ${ctx.bashCommand?.substring(0, 50)}, total completed: ${ctx.completedBashOutputs.length}`);
        shouldUpdate = true;
      }
    }
  } else if (part?.type === "tool" && part?.tool === "edit") {
    const status = part?.state?.status;
    
    if (status === "completed" || status === "done") {
      const filePath = part?.state?.input?.filePath || part?.state?.input?.file_path;
      const diff = part?.state?.metadata?.diff;
      
      if (diff && filePath) {
        ctx.editDiffs.push({ filePath, diff });
        log.info(`[EditStream] Captured edit diff for ${filePath} (${diff.length} chars), total: ${ctx.editDiffs.length}`);
        shouldUpdate = true;
      }
    }
  }
  
  if (shouldUpdate) {
    ctx.lastUpdateTime = Date.now();
    
    const formattedOutput = formatFullResponse(ctx);
    
    try {
      await streamer.updateStream(ctx.streamCtx, formattedOutput);
    } catch (e) {
      log.error("Failed to update stream:", e);
    }
  }
}
