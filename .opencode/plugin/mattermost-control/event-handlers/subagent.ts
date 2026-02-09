/**
 * Subagent task lifecycle handlers
 */

import { PluginState } from "../state.js";
import { createEmptyResponseContext } from "../types.js";
import { formatElapsedTime } from "../formatters.js";
import { startResponseTimer, stopActiveToolTimer, stopResponseTimer, updateResponseStream } from "../timers.js";
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
  const partStatus = part.state?.status;
  if (partStatus !== "running" && partStatus !== "completed") return;

  const childSessionId = part.state?.metadata?.sessionId;
  const parentSessionId = part.sessionID || event.properties?.sessionID;
  log.info(`[Subagent] handleTaskToolDetected: childSession=${childSessionId?.substring(0, 8) || 'NONE'}, parentSession=${parentSessionId?.substring(0, 8) || 'NONE'}, status=${part.state?.status}`);
  if (!childSessionId || !parentSessionId) {
    log.info(`[Subagent] Skipping — missing childSessionId or parentSessionId`);
    return;
  }

  const parentCtx = PluginState.activeResponseContexts.get(parentSessionId);
  const mmClient = PluginState.mmClient;
  if (!parentCtx || !mmClient) {
    log.info(`[Subagent] Skipping — parentCtx=${!!parentCtx}, mmClient=${!!mmClient}`);
    return;
  }

  const threadRootPostId = parentCtx.threadRootPostId || parentCtx.streamCtx?.threadRootPostId;
  if (!threadRootPostId) {
    log.info(`[Subagent] Skipping — no threadRootPostId on parent context`);
    return;
  }

  const description = part.state?.input?.description?.trim() ?? "";
  const agentType = normalizeAgentType(part.state?.input?.subagent_type);
  log.info(`[Subagent] Creating reply for: type=${agentType}, desc="${description.substring(0, 60)}", thread=${threadRootPostId.substring(0, 8)}`);
  const rawModelId = part.state?.metadata?.model || part.state?.metadata?.modelId;
  const modelId = typeof rawModelId === "object" && rawModelId ? rawModelId.modelID : rawModelId;

  const agentHeader = buildAgentHeader(agentType, description, threadRootPostId, modelId);
  const initialMessage = `${agentHeader}\n\n---\n\n💻 Starting...`;

  const channelId = parentCtx.streamCtx?.channelId || parentCtx.mmSession?.dmChannelId;
  if (!channelId) return;

  const existingInfo = PluginState.subagentRegistry.get(childSessionId);
  if (existingInfo?.replyPostId) {
    if (existingInfo.status === "running") {
      log.debug(`[Subagent] Child ${childSessionId.substring(0, 8)} already running — skipping`);
      return;
    }

    let existingContent = existingInfo.agentHeader;
    try {
      const existingPost = await mmClient.getPost(existingInfo.replyPostId);
      existingContent = existingPost.message || existingContent;
    } catch (e) {
      log.debug(`[Subagent] Failed to fetch existing reply post ${existingInfo.replyPostId}: ${e}`);
    }

    const resumedMessage = `${existingContent}\n\n--- **Resumed** ---\n\n${agentHeader}\n\n---\n\n💻 Starting...`;
    await mmClient.updatePost(existingInfo.replyPostId, resumedMessage);

    existingInfo.status = "running";
    existingInfo.startTime = Date.now();
    existingInfo.toolCount = 0;
    existingInfo.agentType = agentType;
    existingInfo.description = description;
    existingInfo.modelId = modelId;
    existingInfo.agentHeader = agentHeader;
    existingInfo.threadRootPostId = threadRootPostId;
    existingInfo.parentSessionId = parentSessionId;

    const streamCtx = {
      postId: existingInfo.replyPostId,
      channelId,
      threadRootPostId,
      buffer: "",
      lastUpdateTime: Date.now(),
      totalChunks: 0,
      isCancelled: false,
      continuationPostIds: [],
      currentPostContent: resumedMessage,
    };

    const childCtx = createEmptyResponseContext(childSessionId, parentCtx.mmSession, streamCtx, threadRootPostId, 0);
    childCtx.agentName = agentType;
    if (modelId) {
      childCtx.modelId = modelId;
    }
    PluginState.activeResponseContexts.set(childSessionId, childCtx);
    startResponseTimer(childSessionId);

    log.info(`[Subagent] Resumed child session ${childSessionId.substring(0, 8)} for parent ${parentSessionId.substring(0, 8)}`);
    return;
  }

  log.info(`[Subagent] Creating reply post in channel=${channelId.substring(0, 8)}, rootPost=${threadRootPostId.substring(0, 8)}`);
  const replyPost = await mmClient.createPost(channelId, initialMessage, threadRootPostId);
  log.info(`[Subagent] Reply post created: ${replyPost.id.substring(0, 8)}`);

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
  if (modelId) {
    childCtx.modelId = modelId;
  }
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
  if (!info) {
    log.info(`[Subagent] Parent task tool completed but child ${childSessionId.substring(0, 8)} was never detected during "running" — late-registering now`);
    await handleTaskToolDetected(event);
    return;
  }

  log.info(`[Subagent] Parent task tool completed for child ${childSessionId.substring(0, 8)} — NOT collapsing yet (waiting for child session.idle)`);
}

export async function collapseSubagentOnIdle(childSessionId: string): Promise<void> {
  const info = PluginState.subagentRegistry.get(childSessionId);
  const mmClient = PluginState.mmClient;
  if (!info || !mmClient) return;
  if (info.status !== "running") return;

  const elapsed = formatElapsedTime(Date.now() - info.startTime);
  const summary = `✅ ${formatTaskLabel(info.agentType, info.description)} (${elapsed}, ${info.toolCount} tools)`;

  log.info(`[Subagent] Child idle — collapsing: child=${childSessionId.substring(0, 8)}, type=${info.agentType}, ${elapsed}, ${info.toolCount} tools`);
  await mmClient.updatePost(info.replyPostId, summary);
  info.status = "completed";

  await updateResponseStream(info.parentSessionId);

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

  log.info(`[Subagent] Error: child=${childSessionId.substring(0, 8)}, type=${info.agentType}, error=${errorMessage || 'unknown'} — collapsing reply`);
  await mmClient.updatePost(info.replyPostId, summary);
  info.status = "error";

  await updateResponseStream(info.parentSessionId);

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

  log.info(`[Subagent] Cleanup: parent=${parentSessionId.substring(0, 8)}, ${entries.length} child subagents to clean up`);
  for (const entry of entries) {
    if (entry.status === "running") {
      const summary = `❌ ${formatTaskLabel(entry.agentType, entry.description)} (cancelled)`;
      try {
        await mmClient.updatePost(entry.replyPostId, summary);
      } catch (e) {
        log.debug(`[Subagent] Failed to collapse reply ${entry.replyPostId}: ${e}`);
      }
    } else {
      log.debug(`[Subagent] Cleanup: skipping ${entry.childSessionId.substring(0, 8)} (already ${entry.status})`);
    }
    PluginState.activeResponseContexts.delete(entry.childSessionId);
    stopActiveToolTimer(entry.childSessionId);
    stopResponseTimer(entry.childSessionId);
    PluginState.subagentRegistry.delete(entry.childSessionId);
  }
}
