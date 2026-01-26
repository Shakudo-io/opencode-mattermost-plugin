/**
 * File event handler - handles file.edited events
 */

import { PluginState } from "../state.js";
import { log } from "../../../../src/logger.js";

function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handleFileEdited(event: any): Promise<void> {
  const { fileHandler } = PluginState;
  if (!fileHandler) return;
  
  const sessionId = event.properties?.sessionID;
  if (!sessionId) return;
  
  if (isScheduledTaskSession(sessionId)) {
    log.debug(`[ScheduledTask] Suppressing file.edited for scheduled task session ${sessionId.substring(0, 8)}`);
    return;
  }
  
  const ctx = PluginState.activeResponseContexts.get(sessionId);
  if (!ctx) return;
  
  try {
    const filePath = event.properties?.path;
    if (filePath) {
      await fileHandler.sendOutboundFile(ctx.mmSession, filePath, `File updated: \`${filePath}\``);
    }
  } catch (e) {
    log.error("Failed to send file update:", e);
  }
}
