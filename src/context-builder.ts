/**
 * Context Builder for Group DM Thread Messages
 * 
 * Fetches recent thread messages and optionally summarizes them with Claude Haiku
 * to provide context when responding to @mentions in group DMs.
 */

import type { MattermostClient } from "./clients/mattermost-client.js";
import type { Post, PostList } from "./models/index.js";
import { log } from "./logger.js";

/** Maximum context length in characters before summarization */
const MAX_CONTEXT_LENGTH = 8000;

/** Default number of messages to fetch from thread */
const DEFAULT_MESSAGE_COUNT = 5;

export interface ThreadMessage {
  userId: string;
  username: string;
  message: string;
  timestamp: number;
}

export interface ThreadContext {
  messages: ThreadMessage[];
  totalCharacters: number;
  wasSummarized: boolean;
  summary?: string;
}

/**
 * Build context from recent thread messages, excluding bot messages
 * 
 * @param mmClient - Mattermost client instance
 * @param threadRootPostId - Root post ID of the thread
 * @param currentPostId - Current post ID (to exclude from context)
 * @param botUserId - Bot user ID (to exclude bot messages)
 * @param maxMessages - Maximum number of messages to fetch (default: 5)
 * @returns ThreadContext with recent messages
 */
export async function buildThreadContext(
  mmClient: MattermostClient,
  threadRootPostId: string,
  currentPostId: string,
  botUserId: string,
  maxMessages: number = DEFAULT_MESSAGE_COUNT
): Promise<ThreadContext> {
  try {
    log.info(`[ContextBuilder] Fetching thread context for root post: ${threadRootPostId}`);
    
    // Fetch the full thread
    const postList: PostList = await mmClient.getPostThread(threadRootPostId);
    
    if (!postList.order || postList.order.length === 0) {
      log.info(`[ContextBuilder] No posts found in thread`);
      return { messages: [], totalCharacters: 0, wasSummarized: false };
    }
    
    // Sort posts by create_at (oldest first), then take the most recent ones
    const sortedPostIds = [...postList.order].sort((a, b) => {
      const postA = postList.posts[a];
      const postB = postList.posts[b];
      return (postA?.create_at || 0) - (postB?.create_at || 0);
    });
    
    // Filter out:
    // 1. Bot messages
    // 2. The current post (the @mention we're responding to)
    // 3. The root post (usually just session info)
    const relevantPosts: Post[] = sortedPostIds
      .map(id => postList.posts[id])
      .filter((post): post is Post => {
        if (!post) return false;
        if (post.user_id === botUserId) return false;
        if (post.id === currentPostId) return false;
        if (post.id === threadRootPostId) return false;
        return true;
      });
    
    // Take the last N messages
    const recentPosts = relevantPosts.slice(-maxMessages);
    
    log.info(`[ContextBuilder] Found ${relevantPosts.length} relevant posts, using last ${recentPosts.length}`);
    
    // Build thread messages - we need to fetch usernames
    const messages: ThreadMessage[] = [];
    const userCache: Record<string, string> = {};
    
    for (const post of recentPosts) {
      let username = userCache[post.user_id];
      if (!username) {
        try {
          const user = await mmClient.getUserById(post.user_id);
          username = user.username;
          userCache[post.user_id] = username;
        } catch (err) {
          username = "unknown";
          log.warn(`[ContextBuilder] Failed to fetch username for user ${post.user_id}`);
        }
      }
      
      messages.push({
        userId: post.user_id,
        username,
        message: post.message,
        timestamp: post.create_at,
      });
    }
    
    const totalCharacters = messages.reduce((sum, m) => sum + m.message.length, 0);
    
    log.info(`[ContextBuilder] Built context with ${messages.length} messages, ${totalCharacters} chars`);
    
    return {
      messages,
      totalCharacters,
      wasSummarized: false,
    };
  } catch (error) {
    log.error(`[ContextBuilder] Error building thread context: ${error}`);
    return { messages: [], totalCharacters: 0, wasSummarized: false };
  }
}

/**
 * Summarize context using Claude Haiku if it exceeds the character limit
 * 
 * @param client - OpenCode SDK client
 * @param sessionId - OpenCode session ID to use for summarization
 * @param context - Thread context to potentially summarize
 * @returns Updated ThreadContext with summary if needed
 */
export async function summarizeContextWithHaiku(
  client: any, // OpenCode SDK client
  sessionId: string,
  context: ThreadContext
): Promise<ThreadContext> {
  // Don't summarize if under the limit or no messages
  if (context.totalCharacters <= MAX_CONTEXT_LENGTH || context.messages.length === 0) {
    return context;
  }
  
  log.info(`[ContextBuilder] Context exceeds ${MAX_CONTEXT_LENGTH} chars (${context.totalCharacters}), summarizing with Haiku`);
  
  try {
    // Format messages for summarization
    const conversationText = context.messages
      .map(m => `@${m.username}: ${m.message}`)
      .join("\n\n");
    
    const summaryPrompt = `Summarize the following conversation concisely, preserving key context, decisions, and any important details that would be needed to understand and respond to a follow-up message. Keep your summary under 500 words.

Conversation:
${conversationText}

Summary:`;
    
    // Use Haiku for fast, cheap summarization
    const result = await client.session.prompt({
      sessionId,
      prompt: summaryPrompt,
      model: {
        providerID: "anthropic",
        modelID: "claude-3-5-haiku-20241022",
      },
    });
    
    // Extract text from result
    let summary = "";
    if (result && typeof result === "object" && "text" in result) {
      summary = String(result.text);
    } else if (typeof result === "string") {
      summary = result;
    }
    
    if (summary) {
      log.info(`[ContextBuilder] Generated summary: ${summary.length} chars`);
      return {
        ...context,
        wasSummarized: true,
        summary,
      };
    }
    
    log.warn(`[ContextBuilder] Haiku returned empty summary, using original context`);
    return context;
  } catch (error) {
    log.error(`[ContextBuilder] Error summarizing with Haiku: ${error}`);
    // Fall back to original context on error
    return context;
  }
}

/**
 * Format context as a prefix for the user's prompt
 * 
 * @param context - Thread context (possibly summarized)
 * @param currentUsername - Username of the person who @mentioned the bot
 * @returns Formatted context prefix string, or empty string if no context
 */
export function formatContextForPrompt(
  context: ThreadContext,
  currentUsername: string
): string {
  if (context.messages.length === 0 && !context.summary) {
    return "";
  }
  
  let contextBlock: string;
  
  if (context.wasSummarized && context.summary) {
    contextBlock = `[Previous conversation summary]
${context.summary}`;
  } else {
    // Format individual messages
    const formattedMessages = context.messages
      .map(m => `@${m.username}: ${m.message}`)
      .join("\n\n");
    
    contextBlock = `[Previous messages in this thread]
${formattedMessages}`;
  }
  
  return `${contextBlock}

[Current message from @${currentUsername}]
`;
}

/**
 * Check if a message contains a bot @mention
 * 
 * @param message - Message text to check
 * @param botUsername - Bot username (without @)
 * @param botUserId - Bot user ID
 * @returns true if the bot is mentioned
 */
export function isBotMentioned(
  message: string,
  botUsername: string,
  botUserId: string
): boolean {
  // Check for @username mention (case-insensitive)
  const atMentionRegex = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "i");
  if (atMentionRegex.test(message)) {
    return true;
  }
  
  // Check for user ID mention format used by some Mattermost clients
  if (message.includes(`<@${botUserId}>`)) {
    return true;
  }
  
  return false;
}

/**
 * Strip bot @mentions from a message to clean up the prompt
 * 
 * @param message - Message text
 * @param botUsername - Bot username (without @)
 * @param botUserId - Bot user ID
 * @returns Message with bot mentions removed
 */
export function stripBotMention(
  message: string,
  botUsername: string,
  botUserId: string
): string {
  // Remove @username mentions (case-insensitive)
  let cleaned = message.replace(
    new RegExp(`@${escapeRegExp(botUsername)}\\b`, "gi"),
    ""
  );
  
  // Remove user ID mention format
  cleaned = cleaned.replace(new RegExp(`<@${escapeRegExp(botUserId)}>`, "g"), "");
  
  // Clean up extra whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  
  return cleaned;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
