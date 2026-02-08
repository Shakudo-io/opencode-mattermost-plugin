/**
 * Subagent task lifecycle handlers
 */

import { PluginState } from "../state.js";
import { createEmptyResponseContext } from "../types.js";
import { formatElapsedTime } from "../formatters.js";
import { startResponseTimer, stopActiveToolTimer, stopResponseTimer } from "../timers.js";
import { log } from "../../../../src/logger.js";

function normalizeAgentType(agentType?: string): string {
  if (!agentType) return "Subagent";
  return agentType.charAt(0).toUpperCase() + agentType.slice(1);
}

function buildThreadLink(threadRootPostId: string): string {
  return `/_redirect/pl/${threadRootPostId}`;
}

function formatTaskLabel(agentType: string, description: string): string {
  return description ? `${agentType} Task — ${description}` : `${agentType} Task`;
}

function buildAgentHeader(agentType: string, description: string, threadRootPostId: string, modelId?: string): string {
  const threadLink = buildThreadLink(threadRootPostId);
  const descriptionSuffix = description ? ` — ${description}` : "";
  const lines = [
    `🕵️ **${agentType} Task**${descriptionSuffix}`,
    `*Parent: [thread link](${threadLink})*`,
  ];
  if (modelId) {
    lines.push(`*Model: ${modelId}*`);
  }
  return lines.join("\n");
}

export async function handleTaskToolDetected(event: any): Promise<void> {
  const part = event.properties?.part;
  if (!part || part.tool !== "task") return;
  if (part.state?.status !== "running") return;

  const childSessionId = part.state?.metadata?.sessionId;
  const parentSessionId = part.sessionID || event.properties?.sessionID;
  if (!childSessionId || !parentSessionId) return;

  if (PluginState.subagentRegistry.has(childSessionId)) {
    return;
  }

  const parentCtx = PluginState.activeResponseContexts.get(parentSessionId);
  const mmClient = PluginState.mmClient;
  if (!parentCtx || !mmClient) return;

  const threadRootPostId = parentCtx.threadRootPostId || parentCtx.streamCtx?.threadRootPostId;
  if (!threadRootPostId) return;

  const description = part.state?.input?.description?.trim() ?? "";
  const agentType = normalizeAgentType(part.state?.input?.subagent_type);
  const modelId = part.state?.metadata?.model || part.state?.metadata?.modelId;

  const agentHeader = buildAgentHeader(agentType, description, threadRootPostId, modelId);
  const initialMessage = `${agentHeader}\n\n---\n\n💻 Starting...`;

  const channelId = parentCtx.streamCtx?.channelId || parentCtx.mmSession?.dmChannelId;
  if (!channelId) return;

  const replyPost = await mmClient.createPost(channelId, initialMessage, threadRootPostId);

  PluginState.subagentRegistry.set(childSessionId, {
    childSessionId,
    parentSessionId,
    threadRootPostId,
    replyPostId: replyPost.id,
    agentType,
    description,
    status: "running",
    startTime: Date.now(),
    toolCount: 0,
    modelId,
    agentHeader,
  });

  const streamCtx = {
    postId: replyPost.id,
    channelId,
    threadRootPostId,
    buffer: "",
    lastUpdateTime: Date.now(),
    totalChunks: 0,
    isCancelled: false,
    continuationPostIds: [],
    currentPostContent: initialMessage,
  };

  const childCtx = createEmptyResponseContext(childSessionId, parentCtx.mmSession, streamCtx, threadRootPostId, 0);
  childCtx.agentName = agentType;
  PluginState.activeResponseContexts.set(childSessionId, childCtx);
  startResponseTimer(childSessionId);

  log.info(`[Subagent] Detected task() child session ${childSessionId.substring(0, 8)} for parent ${parentSessionId.substring(0, 8)}`);
}

export async function handleTaskToolCompleted(event: any): Promise<void> {
  const part = event.properties?.part;
  if (!part || part.tool !== "task") return;
  if (part.state?.status !== "completed") return;

  const childSessionId = part.state?.metadata?.sessionId;
  if (!childSessionId) return;

  const info = PluginState.subagentRegistry.get(childSessionId);
  const mmClient = PluginState.mmClient;
  if (!info || !mmClient) return;

  const elapsed = formatElapsedTime(Date.now() - info.startTime);
  const summary = `✅ ${formatTaskLabel(info.agentType, info.description)} (${elapsed}, ${info.toolCount} tools)`;

  await mmClient.updatePost(info.replyPostId, summary);
  info.status = "completed";

  PluginState.activeResponseContexts.delete(childSessionId);
  stopActiveToolTimer(childSessionId);
  stopResponseTimer(childSessionId);
}

export async function handleTaskToolError(event: any): Promise<void> {
  const part = event.properties?.part;
  if (!part || part.tool !== "task") return;
  if (part.state?.status !== "error") return;

  const childSessionId = part.state?.metadata?.sessionId;
  if (!childSessionId) return;

  const info = PluginState.subagentRegistry.get(childSessionId);
  const mmClient = PluginState.mmClient;
  if (!info || !mmClient) return;

  const errorMessage = part.state?.error || part.state?.metadata?.error;
  const summary = errorMessage
    ? `❌ ${formatTaskLabel(info.agentType, info.description)} (failed: ${errorMessage})`
    : `❌ ${formatTaskLabel(info.agentType, info.description)} (failed)`;

  await mmClient.updatePost(info.replyPostId, summary);
  info.status = "error";

  PluginState.activeResponseContexts.delete(childSessionId);
  stopActiveToolTimer(childSessionId);
  stopResponseTimer(childSessionId);
}

export async function cleanupSubagentsForParent(parentSessionId: string): Promise<void> {
  const mmClient = PluginState.mmClient;
  if (!mmClient) return;

  const entries = Array.from(PluginState.subagentRegistry.values()).filter(
    (entry) => entry.parentSessionId === parentSessionId
  );

  for (const entry of entries) {
    const summary = `❌ ${formatTaskLabel(entry.agentType, entry.description)} (cancelled)`;
    try {
      await mmClient.updatePost(entry.replyPostId, summary);
    } catch (e) {
      log.debug(`[Subagent] Failed to collapse reply ${entry.replyPostId}: ${e}`);
    }
    PluginState.activeResponseContexts.delete(entry.childSessionId);
    stopActiveToolTimer(entry.childSessionId);
    stopResponseTimer(entry.childSessionId);
    PluginState.subagentRegistry.delete(entry.childSessionId);
  }
}
