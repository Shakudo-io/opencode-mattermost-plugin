/**
 * Message event handlers - handles message.updated and message.part.updated events
 */

import { PluginState } from "../state.js";
import { updateResponseStream } from "../timers.js";
import { handleTaskToolCompleted, handleTaskToolDetected, handleTaskToolError } from "./subagent.js";
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
  
  const targetSessionId = msgInfo.sessionID;
  const ctx = PluginState.activeResponseContexts.get(targetSessionId);
  if (!ctx) return;
  
  if (msgInfo.agent) {
    ctx.agentName = msgInfo.agent;
  }

   const modelID = msgInfo.modelID || msgInfo.model?.modelID;
   if (modelID) {
     ctx.modelId = modelID;
     log.debug(`[Model] Captured modelID=${modelID} for session ${targetSessionId.substring(0, 8)}`);
   } else if (msgInfo.role === "assistant" && !ctx.modelId) {
     log.debug(`[Model] No modelID on assistant msg for ${targetSessionId.substring(0, 8)}, keys: ${Object.keys(msgInfo).join(',')}`);
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
  const { isConnected } = PluginState;
  if (!isConnected) return;
  
  const part = event.properties?.part;
  const delta = event.properties?.delta;
  const sessionId = part?.sessionID || event.properties?.sessionID;
  
  if (!sessionId) return;

  if (part?.type === "tool") {
    log.debug(`[Subagent] Tool part seen: session=${sessionId?.substring(0, 8)}, tool=${part?.tool}, status=${part?.state?.status}, keys=${Object.keys(part?.state || {}).join(',')}`);
  }
  if (part?.type === "tool" && part?.tool === "task") {
    const status = part?.state?.status;
    log.info(`[Subagent] task tool part: session=${sessionId?.substring(0, 8)}, status=${status}, metadata.sessionId=${part?.state?.metadata?.sessionId?.substring(0, 8) || 'NONE'}`);
    if (status === "running") {
      await handleTaskToolDetected(event);
    } else if (status === "completed") {
      await handleTaskToolCompleted(event);
    } else if (status === "error") {
      await handleTaskToolError(event);
    }
    return;
  }

  const subagentInfo = PluginState.subagentRegistry.get(sessionId);
  if (subagentInfo) {
    log.debug(`[Subagent] Routing part event to child ${sessionId.substring(0, 8)} (type=${part?.type}, delta=${delta?.length ?? 'null'})`);
  }
  
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
  
  // Debug: Log full part structure for reasoning parts to find where thinking content lives
  if (part?.type === "reasoning") {
    log.info(`[ReasoningDebug] Full part object: ${JSON.stringify(part, null, 2)}`);
    log.info(`[ReasoningDebug] Full event.properties: ${JSON.stringify(event.properties, null, 2)}`);
    log.info(`[ReasoningDebug] delta=${delta} part.data=${JSON.stringify(part?.data)} part.thinking=${part?.thinking ? part.thinking.substring(0, 100) + '...' : 'undefined'}`);
  }
  
  let shouldUpdate = false;
  
  if (part?.type === "text") {
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
    // Extract text content from either delta (streaming) or part.text (complete)
    let textContent = delta || (part as any)?.text || "";
    
    // Models like MiniMax M2.5 embed thinking as XML tags in text instead of separate reasoning parts
    const thinkMatch = textContent.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      const thinkingContent = thinkMatch[1].trim();
      if (thinkingContent) {
        ctx.thinkingBuffer = thinkingContent;
        ctx.reasoningPartCount = (ctx.reasoningPartCount || 0) + 1;
        log.info(`[Reasoning] Extracted <think> content (${thinkingContent.length} chars) from text part`);
      }
      textContent = textContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
    
    if (textContent) {
      ctx.responseBuffer = textContent;
      ctx.textPartCount = (ctx.textPartCount || 0) + 1;
      shouldUpdate = true;
    }
  } else if (part?.type === "reasoning") {
    // Skip compaction summary reasoning
    if (ctx.inCompactionSummary) {
      log.debug(`[Compaction] Suppressing compaction summary reasoning for session ${sessionId.substring(0, 8)}`);
      return;
    }
    if (ctx.awaitingContinuation) {
      log.info(`[Compaction] Continuation reasoning received, resetting awaitingContinuation for session ${sessionId.substring(0, 8)}`);
      ctx.awaitingContinuation = false;
    }
    // Extract thinking content from multiple possible locations:
    // - delta (streaming updates)
    // - part.text (OpenCode event structure)
    // - part.data.thinking (TUI serialization format)
    const thinkingContent = delta || (part as any)?.text || (part?.data?.thinking) || (part as any)?.thinking || "";
    if (thinkingContent) {
      ctx.thinkingBuffer = thinkingContent;
      ctx.reasoningPartCount = (ctx.reasoningPartCount || 0) + 1;
      shouldUpdate = true;
      log.info(`[Reasoning] Captured reasoning (${thinkingContent.length} chars), total buffer: ${ctx.thinkingBuffer.length} chars`);
    }
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
    await updateResponseStream(sessionId);
  }
}
