/**
 * File event handler - handles file.edited events
 */

import { PluginState } from "../state.js";
import { log } from "../../../../src/logger.js";

export async function handleFileEdited(event: any): Promise<void> {
  const { fileHandler } = PluginState;
  if (!fileHandler) return;
  
  const sessionId = event.properties?.sessionID;
  if (!sessionId) return;
  
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
