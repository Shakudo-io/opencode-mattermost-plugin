/**
 * Permission event handler
 */

import { PluginState } from "../state.js";
import { handleMonitorAlert } from "../../../../src/monitor-service.js";
import { log } from "../../../../src/logger.js";

function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handlePermissionAsked(event: any): Promise<void> {
  const eventSessionId = event.properties?.sessionID;
  const subagentInfo = eventSessionId ? PluginState.subagentRegistry.get(eventSessionId) : undefined;
  const parentSessionId = subagentInfo?.parentSessionId;
  const targetSessionId = parentSessionId ?? eventSessionId;
  
  // Skip permission handling for scheduled task sessions - they can't ask for permissions via DM
  if (targetSessionId && isScheduledTaskSession(targetSessionId)) {
    log.debug(`[ScheduledTask] Suppressing permission.asked for scheduled task session ${targetSessionId.substring(0, 8)}`);
    return;
  }
  
  log.debug(`[Monitor] permission.asked event: sessionId=${eventSessionId}`);
  const description = event.properties?.description || "Permission requested";
  const activeSessionIds = Array.from(PluginState.activeResponseContexts.keys());
  if (targetSessionId) {
    await handleMonitorAlert(targetSessionId, "permission.asked", description, activeSessionIds[0]);
  }
  
  if (targetSessionId && PluginState.isConnected) {
    const ctx = PluginState.activeResponseContexts.get(targetSessionId);
    if (ctx?.streamCtx.statusIndicator) {
      await ctx.streamCtx.statusIndicator.setWaiting("permission", description);
    }
  }

  if (subagentInfo && PluginState.isConnected) {
    const parentCtx = parentSessionId ? PluginState.activeResponseContexts.get(parentSessionId) : undefined;
    const mmClient = PluginState.mmClient;
    const targetChannelId = parentCtx?.streamCtx?.channelId || parentCtx?.mmSession?.dmChannelId;
    const targetThreadId = parentCtx?.threadRootPostId || parentCtx?.streamCtx?.threadRootPostId;

    if (parentCtx && mmClient && targetChannelId && targetThreadId) {
      const prefix = `🔔 *Permission request from ${subagentInfo.agentType} subagent:*\n\n`;
      await mmClient.createPost(targetChannelId, `${prefix}${description}`, targetThreadId);
    }
  }
}
