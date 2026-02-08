/**
 * Compaction event handler - handles session.compacted events
 */

import { PluginState } from "../state.js";
import { formatFullResponse } from "../formatters.js";
import { log } from "../../../../src/logger.js";

function isScheduledTaskSession(sessionId: string): boolean {
  const scheduler = PluginState.schedulerService;
  return scheduler?.isRunningScheduledTask(sessionId) ?? false;
}

export async function handleSessionCompacted(event: any): Promise<void> {
  const eventSessionId = event.properties?.sessionID;
  const { mmClient, streamer } = PluginState;
  
  if (!eventSessionId || !mmClient || !streamer) return;
  
  if (isScheduledTaskSession(eventSessionId)) {
    log.debug(`[ScheduledTask] Suppressing session.compacted for scheduled task session ${eventSessionId.substring(0, 8)}`);
    return;
  }
  
  log.info(`[Compaction] Session ${eventSessionId.substring(0, 8)} compacted`);
  const props = event.properties || {};
  log.debug(`[Compaction] Event properties: ${JSON.stringify(props)}`);
  
  const ctx = PluginState.activeResponseContexts.get(eventSessionId);
  if (!ctx) return;
  
  ctx.compactionCount += 1;
  ctx.awaitingContinuation = true;
  ctx.inCompactionSummary = false;
  log.info(`[Compaction] Set awaitingContinuation=true, inCompactionSummary=false for session ${eventSessionId.substring(0, 8)}`);
  
  try {
    const oldContent = formatFullResponse(ctx, undefined, true);
    const newStreamCtx = await streamer.recreateStreamAtBottom(ctx.streamCtx, oldContent);
    ctx.streamCtx = newStreamCtx;
    log.debug(`[Compaction] Recreated stream at bottom, new postId=${newStreamCtx.postId}`);
    
    // Reset content buffers for the new post-compaction stream
    // This prevents old content from flashing in the new post
    ctx.responseBuffer = "";
    ctx.thinkingBuffer = "";
    ctx.shellOutput = "";
    ctx.bashCommand = undefined;
    ctx.lastBashOutput = undefined;
    ctx.lastBashCommand = undefined;
    ctx.completedBashOutputs = [];
    ctx.editDiffs = [];
    ctx.activeTool = null;
    // Preserve: toolCalls (cumulative), todos (persistent), cost (cumulative),
    //           agentName (still active), compactionCount (already incremented)
    
    const compactionMsg = `📦 **Context Compacted** (×${ctx.compactionCount})\n\n` +
      `_Context was automatically compressed to continue the conversation._`;
    
    const targetChannelId = ctx.streamCtx?.channelId || ctx.mmSession.dmChannelId;
    
    // Reuse existing compaction notification post if one exists
    if (ctx.compactionPostId) {
      try {
        await mmClient.updatePost(ctx.compactionPostId, compactionMsg);
        log.debug(`[Compaction] Updated existing compaction post ${ctx.compactionPostId}`);
      } catch (e) {
        log.warn(`[Compaction] Failed to update compaction post ${ctx.compactionPostId}, creating new`);
        const post = await mmClient.createPost(targetChannelId, compactionMsg, ctx.threadRootPostId);
        ctx.compactionPostId = post.id;
        log.debug(`[Compaction] Created new compaction post ${post.id}`);
      }
    } else {
      const post = await mmClient.createPost(targetChannelId, compactionMsg, ctx.threadRootPostId);
      ctx.compactionPostId = post.id;
      log.debug(`[Compaction] Created compaction post ${post.id}`);
    }
  } catch (e) {
    log.error(`[Compaction] Failed to handle compaction:`, e);
  }
}
