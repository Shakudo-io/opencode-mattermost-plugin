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
  
  // Skip permission handling for scheduled task sessions - they can't ask for permissions via DM
  if (eventSessionId && isScheduledTaskSession(eventSessionId)) {
    log.debug(`[ScheduledTask] Suppressing permission.asked for scheduled task session ${eventSessionId.substring(0, 8)}`);
    return;
  }
  
  log.debug(`[Monitor] permission.asked event: sessionId=${eventSessionId}`);
  const description = event.properties?.description || "Permission requested";
  const activeSessionIds = Array.from(PluginState.activeResponseContexts.keys());
  await handleMonitorAlert(eventSessionId, "permission.asked", description, activeSessionIds[0]);
  
  if (eventSessionId && PluginState.isConnected) {
    const ctx = PluginState.activeResponseContexts.get(eventSessionId);
    if (ctx?.streamCtx.statusIndicator) {
      await ctx.streamCtx.statusIndicator.setWaiting("permission", description);
    }
  }
}
