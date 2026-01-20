/**
 * Permission event handler
 */

import { PluginState } from "../state.js";
import { handleMonitorAlert } from "../../../../src/monitor-service.js";
import { log } from "../../../../src/logger.js";

export async function handlePermissionAsked(event: any): Promise<void> {
  const eventSessionId = event.properties?.sessionID;
  
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
