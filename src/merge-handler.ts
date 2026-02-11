import type { MattermostClient } from "./clients/mattermost-client.js";
import type { ThreadMappingStore } from "./persistence/thread-mapping-store.js";
import type { ThreadSessionMapping } from "./models/index.js";
import { log } from "./logger.js";

export interface MergeResult {
  success: boolean;
  message: string;
  sourceSessionId?: string;
  summary?: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export class MergeHandler {
  private mmClient: MattermostClient;
  private threadMappingStore: ThreadMappingStore;
  private opencodeClient: any;
  private mattermostBaseUrl: string;

  constructor(
    mmClient: MattermostClient,
    threadMappingStore: ThreadMappingStore,
    opencodeClient: any,
    mattermostBaseUrl: string
  ) {
    this.mmClient = mmClient;
    this.threadMappingStore = threadMappingStore;
    this.opencodeClient = opencodeClient;
    this.mattermostBaseUrl = mattermostBaseUrl.replace(/\/api\/v4$/, "");
  }

  parseThreadUrl(url: string): string | null {
    const patterns = [
      /\/pl\/([a-z0-9]+)$/i,
      /\/pl\/([a-z0-9]+)\?/i,
      /postId=([a-z0-9]+)/i,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return null;
  }

  async getThreadRootPostId(postId: string): Promise<string | null> {
    try {
      const post = await this.mmClient.getPost(postId);
      return post.root_id || post.id;
    } catch (e) {
      log.error(`[MergeHandler] Failed to fetch post ${postId}: ${e}`);
      return null;
    }
  }

  async fetchSessionMessages(sessionId: string): Promise<SessionMessage[]> {
    try {
      const messagesResult = await this.opencodeClient.session.messages({
        path: { id: sessionId },
      });

      const messages: SessionMessage[] = [];
      const rawMessages = messagesResult.data || [];

      for (const msg of rawMessages) {
        if (!msg.info?.role) continue;

        let content = "";
        if (msg.parts) {
          for (const part of msg.parts) {
            if (part.type === "text" && part.text) {
              content += part.text + "\n";
            }
          }
        }

        if (content.trim()) {
          messages.push({
            role: msg.info.role as "user" | "assistant",
            content: content.trim(),
            timestamp: msg.info.createdAt,
          });
        }
      }

      return messages;
    } catch (e) {
      log.error(`[MergeHandler] Failed to fetch session messages for ${sessionId}: ${e}`);
      return [];
    }
  }

  async summarizeSession(sessionId: string, sourceMapping: ThreadSessionMapping): Promise<string | null> {
    const messages = await this.fetchSessionMessages(sessionId);

    if (messages.length === 0) {
      return null;
    }

    const conversationText = messages
      .map((m) => `**${m.role === "user" ? "User" : "Assistant"}**: ${m.content}`)
      .join("\n\n---\n\n");

    const summaryPrompt = `You are summarizing a conversation from a Mattermost thread to be merged into another thread. The conversation was about "${sourceMapping.sessionTitle || sourceMapping.projectName}".

Summarize the following conversation concisely. Focus on:
- Key decisions made
- Important context or requirements
- Actions taken or planned
- Any unfinished work or next steps

Keep your summary under 800 words. Use bullet points for clarity.

Conversation:
${conversationText}

Summary:`;

    try {
      const result = await this.opencodeClient.session.prompt({
        sessionId,
        prompt: summaryPrompt,
        model: {
          providerID: "google",
          modelID: "gemini-3-flash-preview",
        },
      });

      let summary = "";
      if (result && typeof result === "object" && "text" in result) {
        summary = String(result.text);
      } else if (typeof result === "string") {
        summary = result;
      }

      return summary || null;
    } catch (e) {
      log.error(`[MergeHandler] Failed to summarize session ${sessionId}: ${e}`);
      return this.createFallbackSummary(messages, sourceMapping);
    }
  }

  private createFallbackSummary(messages: SessionMessage[], sourceMapping: ThreadSessionMapping): string {
    const userMessages = messages.filter((m) => m.role === "user").slice(-5);
    const assistantMessages = messages.filter((m) => m.role === "assistant").slice(-3);

    let summary = `**Context from ${sourceMapping.projectName}** (${messages.length} messages)\n\n`;
    summary += `**Recent user requests:**\n`;
    for (const msg of userMessages) {
      const truncated = msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content;
      summary += `- ${truncated}\n`;
    }

    if (assistantMessages.length > 0) {
      summary += `\n**Key responses/actions:**\n`;
      for (const msg of assistantMessages) {
        const truncated = msg.content.length > 300 ? msg.content.slice(0, 300) + "..." : msg.content;
        summary += `- ${truncated}\n`;
      }
    }

    return summary;
  }

  async executeMerge(
    sourceUrl: string,
    targetSessionId: string,
    targetThreadRootPostId: string,
    targetChannelId: string,
    userId: string
  ): Promise<MergeResult> {
    log.info(`[MergeHandler] Starting merge from URL ${sourceUrl} into session ${targetSessionId}`);

    try {
      const postId = this.parseThreadUrl(sourceUrl);
      log.debug(`[MergeHandler] Parsed postId: ${postId}`);
      if (!postId) {
        return {
          success: false,
          message: "Invalid URL format. Please provide a valid Mattermost thread link (e.g., `https://mattermost.example.com/team/pl/postid123`).",
        };
      }

      log.debug(`[MergeHandler] Fetching thread root post ID for ${postId}`);
      const sourceThreadRootPostId = await this.getThreadRootPostId(postId);
      log.debug(`[MergeHandler] Source thread root: ${sourceThreadRootPostId}`);
      if (!sourceThreadRootPostId) {
        return {
          success: false,
          message: "Could not resolve thread from the provided URL. The post may have been deleted.",
        };
      }

      if (sourceThreadRootPostId === targetThreadRootPostId) {
        return {
          success: false,
          message: "Cannot merge a thread into itself.",
        };
      }

      log.debug(`[MergeHandler] Looking up source mapping for thread ${sourceThreadRootPostId}`);
      const sourceMapping = this.threadMappingStore.getByThreadRootPostId(sourceThreadRootPostId);
      log.debug(`[MergeHandler] Source mapping found: ${sourceMapping ? sourceMapping.sessionId : 'null'}`);
      if (!sourceMapping) {
        return {
          success: false,
          message: "Thread not found in this OpenCode instance. Only threads from your current OpenCode sessions can be merged.",
        };
      }

      if (sourceMapping.status === "merged") {
        const destMapping = sourceMapping.mergedInto
          ? this.threadMappingStore.getBySessionId(sourceMapping.mergedInto)
          : null;
        const destLink = destMapping
          ? `[here](${this.mattermostBaseUrl}/_redirect/pl/${destMapping.threadRootPostId})`
          : "another thread";
        return {
          success: false,
          message: `This thread was already merged into ${destLink} on ${sourceMapping.mergedAt || "unknown date"}.`,
        };
      }

      log.debug(`[MergeHandler] Summarizing session ${sourceMapping.sessionId}`);
      const summary = await this.summarizeSession(sourceMapping.sessionId, sourceMapping);
      log.debug(`[MergeHandler] Summary generated: ${summary ? summary.substring(0, 100) + '...' : 'null'}`)
    if (!summary) {
      return {
        success: false,
        message: "Could not summarize the source thread. It may be empty or inaccessible.",
      };
    }

    const sourceLink = `${this.mattermostBaseUrl}/_redirect/pl/${sourceThreadRootPostId}`;
    const mergeTimestamp = new Date().toISOString();
    
    let username = "unknown";
    try {
      const user = await this.mmClient.getUserById(userId);
      username = user.username;
    } catch (e) {
      log.warn(`[MergeHandler] Could not fetch username for ${userId}`);
    }

    const mergeMessage = [
      `:twisted_rightwards_arrows: **Merged Thread Context**`,
      "",
      `Merged conversation from [${sourceMapping.projectName} (${sourceMapping.shortId})](${sourceLink}):`,
      "",
      "---",
      "",
      summary,
      "",
      "---",
      `_Merged by @${username} at ${new Date(mergeTimestamp).toLocaleString()}_`,
    ].join("\n");

    try {
      await this.mmClient.createPost(targetChannelId, mergeMessage, targetThreadRootPostId);
    } catch (e) {
      log.error(`[MergeHandler] Failed to post merge summary: ${e}`);
      return {
        success: false,
        message: `Failed to post merge summary: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    sourceMapping.status = "merged";
    sourceMapping.mergedInto = targetSessionId;
    sourceMapping.mergedAt = mergeTimestamp;
    sourceMapping.lastActivityAt = mergeTimestamp;
    this.threadMappingStore.update(sourceMapping);

    const farewellMessage = [
      `:lock: **Thread Merged**`,
      "",
      `This conversation has been merged into another thread.`,
      `Continue the conversation [here](${this.mattermostBaseUrl}/_redirect/pl/${targetThreadRootPostId}).`,
      "",
      `_Merged at ${new Date(mergeTimestamp).toLocaleString()}_`,
    ].join("\n");

    try {
      await this.mmClient.createPost(
        sourceMapping.channelId || sourceMapping.dmChannelId,
        farewellMessage,
        sourceThreadRootPostId
      );
    } catch (e) {
      log.warn(`[MergeHandler] Could not post farewell message to source thread: ${e}`);
    }

    log.info(`[MergeHandler] Successfully merged session ${sourceMapping.shortId} into ${targetSessionId.substring(0, 8)}`);

    return {
      success: true,
      message: [
        `:white_check_mark: **Thread Merged Successfully**`,
        "",
        `Conversation from **${sourceMapping.projectName}** (\`${sourceMapping.shortId}\`) has been merged.`,
        `The source thread has been marked as merged and locked.`,
      ].join("\n"),
      sourceSessionId: sourceMapping.sessionId,
      summary,
    };
    } catch (e) {
      log.error(`[MergeHandler] Unhandled error in executeMerge: ${e}`);
      return {
        success: false,
        message: `Merge failed due to an unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  isMergedThread(threadRootPostId: string): boolean {
    const mapping = this.threadMappingStore.getByThreadRootPostId(threadRootPostId);
    return mapping?.status === "merged";
  }

  getMergeDestination(threadRootPostId: string): ThreadSessionMapping | null {
    const mapping = this.threadMappingStore.getByThreadRootPostId(threadRootPostId);
    if (mapping?.status === "merged" && mapping.mergedInto) {
      return this.threadMappingStore.getBySessionId(mapping.mergedInto);
    }
    return null;
  }
}
