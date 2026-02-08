/**
 * Event handlers module - exports all OpenCode event handlers
 * 
 * This module aggregates event handlers for the Mattermost Control Plugin.
 */

export { handlePermissionAsked } from "./permission.js";
export { handleQuestionAsked } from "./question.js";
export { handleSessionIdle, handleSessionStatus } from "./session.js";
export { handleSessionCompacted } from "./compaction.js";
export { handleMessageUpdated, handleMessagePartUpdated } from "./message.js";
export { handleFileEdited } from "./file.js";
export { handleTodoUpdated } from "./todo.js";
export { handleToolExecuteBefore, handleToolExecuteAfter } from "./tool.js";
export {
  handleTaskToolDetected,
  handleTaskToolCompleted,
  handleTaskToolError,
  collapseSubagentOnIdle,
  cleanupSubagentsForParent,
} from "./subagent.js";
