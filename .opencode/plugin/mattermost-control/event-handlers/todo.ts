/**
 * Todo event handler - handles todo.updated events
 */

import { PluginState } from "../state.js";
import { updateResponseStream } from "../timers.js";
import { log } from "../../../../src/logger.js";

export async function handleTodoUpdated(event: any): Promise<void> {
  const sessionId = event.properties?.sessionID;
  const todos = event.properties?.todos;
  
  if (!sessionId || !todos) return;
  
  const completed = todos.filter((t: any) => t.status === "completed").length;
  log.info(`[TodoEvent] Session ${sessionId.substring(0, 8)}: ${completed}/${todos.length} complete`);
  
  const ctx = PluginState.activeResponseContexts.get(sessionId);
  if (ctx) {
    ctx.todos = todos;
    await updateResponseStream(sessionId);
  }
}
