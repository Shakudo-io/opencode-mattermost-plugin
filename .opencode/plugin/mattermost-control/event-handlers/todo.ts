/**
 * Todo event handler - handles todo.updated events
 */

import { PluginState } from "../state.js";
import { updateResponseStream } from "../timers.js";
import { log } from "../../../../src/logger.js";

function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handleTodoUpdated(event: any): Promise<void> {
  const sessionId = event.properties?.sessionID;
  const todos = event.properties?.todos;
  
  if (!sessionId || !todos) return;
  
  if (isScheduledTaskSession(sessionId)) {
    log.debug(`[ScheduledTask] Suppressing todo.updated for scheduled task session ${sessionId.substring(0, 8)}`);
    return;
  }
  
  const completed = todos.filter((t: any) => t.status === "completed").length;
  log.info(`[TodoEvent] Session ${sessionId.substring(0, 8)}: ${completed}/${todos.length} complete`);
  
  const ctx = PluginState.activeResponseContexts.get(sessionId);
  if (ctx) {
    ctx.todos = todos;
    await updateResponseStream(sessionId);
  }
}
