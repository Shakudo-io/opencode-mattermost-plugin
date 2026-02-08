/**
 * Tool execution event handlers - handles tool.execute.before and tool.execute.after
 */

import { PluginState } from "../state.js";
import { startActiveToolTimer, stopActiveToolTimer, updateResponseStream } from "../timers.js";
import { handleMonitorAlert } from "../../../../src/monitor-service.js";
import { log } from "../../../../src/logger.js";

function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handleToolExecuteBefore(input: any): Promise<void> {
  if (!PluginState.isConnected) return;
  
  const toolSessionId = input.sessionID || input.session?.id;
  log.info(`[ToolDebug] tool.execute.before - tool: ${input.tool}, sessionId: ${toolSessionId?.substring(0, 8)}`);
  if (!toolSessionId) return;
  
  if (isScheduledTaskSession(toolSessionId)) {
    log.debug(`[ScheduledTask] Suppressing tool.execute.before for scheduled task session ${toolSessionId.substring(0, 8)}`);
    return;
  }
  
  const ctx = PluginState.activeResponseContexts.get(toolSessionId);
  if (!ctx) {
    log.info(`[ToolDebug] No active context for session ${toolSessionId.substring(0, 8)}`);
    return;
  }
  
  ctx.activeTool = {
    name: input.tool,
    startTime: Date.now(),
  };
  
  if (input.tool === "bash") {
    log.info(`[ToolDebug] bash args: ${JSON.stringify(input.args || {})}`);
    if (input.args?.command) {
      ctx.bashCommand = input.args.command;
      const cmdDisplay = ctx.bashCommand || "unknown";
      log.info(`[ToolDebug] Captured bash command: ${cmdDisplay.substring(0, 100)}`);
    }
  }
  
  startActiveToolTimer(toolSessionId);
  await updateResponseStream(toolSessionId);
}

export async function handleToolExecuteAfter(input: any): Promise<void> {
  const toolSessionId = input.sessionID || input.session?.id;
  log.info(`[ToolDebug] tool.execute.after - tool: ${input.tool}, sessionId: ${toolSessionId?.substring(0, 8)}`);

  // Skip all tool.execute.after processing for scheduled task sessions
  if (toolSessionId && isScheduledTaskSession(toolSessionId)) {
    log.debug(`[ScheduledTask] Suppressing tool.execute.after for scheduled task session ${toolSessionId.substring(0, 8)}`);
    return;
  }

  // Handle question tool specially for monitoring
  if (input.tool === "question" && toolSessionId) {
    const questionText = input.args?.questions?.[0]?.question || "Question awaiting answer";
    const activeSessionIds = Array.from(PluginState.activeResponseContexts.keys());
    await handleMonitorAlert(toolSessionId, "question", questionText, activeSessionIds[0]);
    
    if (PluginState.isConnected) {
      const ctx = PluginState.activeResponseContexts.get(toolSessionId);
      if (ctx?.streamCtx.statusIndicator) {
        await ctx.streamCtx.statusIndicator.setWaiting("question", questionText);
      }
    }
  }

  if (!PluginState.isConnected || !toolSessionId) return;
  
  const ctx = PluginState.activeResponseContexts.get(toolSessionId);
  if (ctx) {
    if (ctx.activeTool) {
      ctx.toolCalls.push(ctx.activeTool.name);
      if (ctx.activeTool.name === "bash") {
        // Debug: Log all available sources for bash output
        log.info(`[BashDebug] tool.execute.after for bash - ctx.shellOutput: ${ctx.shellOutput?.length || 0} chars`);
        log.info(`[BashDebug] input.result type: ${typeof input.result}, length: ${typeof input.result === 'string' ? input.result.length : 'N/A'}`);
        log.info(`[BashDebug] input.metadata: ${JSON.stringify(input.metadata || {})}`);
        log.info(`[BashDebug] input keys: ${Object.keys(input).join(', ')}`);
        
        // Preserve the output for final display before clearing for next bash command
        // Try multiple sources: streaming output, tool result, or tool metadata
        const finalOutput = ctx.shellOutput || input.result || input.metadata?.output || "";
        const finalCommand = ctx.bashCommand || input.args?.command;
        
        log.info(`[BashDebug] Final output selected: ${finalOutput.length} chars, command: ${finalCommand?.substring(0, 50)}`);
        
        if (finalOutput || finalCommand) {
          ctx.lastBashOutput = finalOutput;
          ctx.lastBashCommand = finalCommand;
          log.info(`[BashOutput] Preserved output (${finalOutput.length} chars) and command for final display`);
        }
        ctx.shellOutput = "";
        ctx.bashCommand = undefined;
        ctx.shellOutputLastUpdate = 0;
      }
      // Edit diffs: captured in message.ts via message.part.updated (part.state.metadata.diff)
      ctx.activeTool = null;
      stopActiveToolTimer(toolSessionId);
    }
    await updateResponseStream(toolSessionId);
  }
}
