import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { PluginState } from "./state.js";
import { createEmptyResponseContext } from "./types.js";
import { startResponseTimer, stopResponseTimer, stopActiveToolTimer } from "./timers.js";

import {
  createConnectTool,
  createDisconnectTool,
  createStatusTool,
  createListSessionsTool,
  createSelectSessionTool,
  createCurrentSessionTool,
  createMonitorTool,
  createUnmonitorTool,
  createSendFileTool,
  createScheduleAddTool,
  createScheduleListTool,
  createScheduleRemoveTool,
  createScheduleEnableTool,
  createScheduleDisableTool,
  createScheduleRunTool,
} from "./tools/index.js";

import {
  handlePermissionAsked,
  handleQuestionAsked,
  handleSessionIdle,
  handleSessionStatus,
  handleSessionCompacted,
  handleMessageUpdated,
  handleMessagePartUpdated,
  handleFileEdited,
  handleTodoUpdated,
  handleToolExecuteBefore,
  handleToolExecuteAfter,
} from "./event-handlers/index.js";

import { ThreadMappingStore } from "../../../src/persistence/thread-mapping-store.js";
import { buildThreadContext, summarizeContextWithHaiku, formatContextForPrompt, stripBotMention } from "../../../src/context-builder.js";
import { loadConfig } from "../../../src/config.js";
import { log } from "../../../src/logger.js";
import type { Post } from "../../../src/models/index.js";
import type { UserSession } from "../../../src/session-manager.js";
import type { InboundRouteResult } from "../../../src/models/routing.js";
import type { OpenCodeSessionInfo } from "../../../src/opencode-session-registry.js";

export const MattermostControlPlugin: Plugin = async ({ client, project, directory, serverUrl, $ }) => {
  const config = loadConfig();
  const projectName = directory.split("/").pop() || "opencode";
  const opencodeBaseUrl = serverUrl.origin;

  PluginState.setProjectName(projectName);

  const threadMappingStore = new ThreadMappingStore();
  threadMappingStore.load().catch((e) => log.warn("[Plugin] Failed to load thread mappings:", e));
  PluginState.setThreadMappingStore(threadMappingStore);

  const connectionContext = {
    client,
    directory,
    projectName,
    opencodeBaseUrl,
    handleUserMessage,
  };

  if (config.mattermost.autoConnect && config.mattermost.token) {
    log.info("Auto-connect enabled, connecting to Mattermost...");
    const connectTool = createConnectTool(connectionContext);
    setTimeout(async () => {
      const result = await connectTool.execute();
      log.info(`Auto-connect result: ${result.split('\n')[0]}`);
    }, 100);
  } else {
    log.info("Loaded (not connected - use /mattermost connect)");
  }

  async function handleUserMessage(post: Post): Promise<void> {
    const { sessionManager, streamer, notifications, fileHandler, messageRouter, commandHandler, openCodeSessionRegistry, mmClient, threadMappingStore, threadManager } = PluginState;
    
    if (!sessionManager || !streamer || !notifications || !fileHandler || !messageRouter || !commandHandler || !openCodeSessionRegistry || !mmClient) return;

    let userSession: UserSession;
    try {
      userSession = await sessionManager.getOrCreateSession(post.user_id);
    } catch (error) {
      log.error("Failed to get/create session:", error);
      return;
    }

    if (threadManager && threadMappingStore && !(post as any)._ownershipConfirmed) {
      const availableSessions = openCodeSessionRegistry.listAvailable();
      for (const sessionInfo of availableSessions) {
        const existingMapping = threadMappingStore.getBySessionId(sessionInfo.id);
        if (!existingMapping) {
          try {
            await threadManager.createThread(
              sessionInfo,
              userSession.mattermostUserId,
              userSession.dmChannelId,
              undefined,
              undefined,
              userSession.mattermostUsername
            );
            log.info(`[AutoThread] Created thread for session ${sessionInfo.shortId} for user ${userSession.mattermostUsername}`);
          } catch (e) {
            log.error(`[AutoThread] Failed to create thread:`, e);
          }
        }
      }
    }

    const routeResult = threadMappingStore 
      ? messageRouter.routeWithThreads(post)
      : convertLegacyRoute(messageRouter.route(post), post);
    
    log.debug(`[ROUTING] type=${routeResult.type}`);

    switch (routeResult.type) {
      case "main_dm_command": {
        const result = await commandHandler.execute(routeResult.command, {
          userSession,
          registry: openCodeSessionRegistry,
          mmClient,
          threadMappingStore,
          teamStore: PluginState.teamStore,
          ownerUserId: config.mattermost.ownerUserId,
          questionHandler: PluginState.questionHandler,
          opencodeClient: client,
          channelId: post.channel_id,
        });
        await mmClient.createPost(post.channel_id, result.message);
        return;
      }
      
      case "main_dm_prompt": {
        if (config.sessionSelection.autoCreateSession) {
          const newSession = await createNewSessionFromDm(userSession, post);
          if (newSession) {
            await handleThreadPrompt({
              sessionId: newSession.sessionId,
              threadRootPostId: newSession.threadRootPostId,
              promptText: post.message.trim(),
              fileIds: post.file_ids,
            }, userSession, post);
          }
          return;
        }
        
        await mmClient.createPost(
          post.channel_id,
          `:warning: ${routeResult.errorMessage}\n\n${routeResult.suggestedAction}`
        );
        return;
      }
      
      case "unknown_thread": {
        const channel = await mmClient.getChannel(post.channel_id);
        const threadRootPostId = routeResult.threadRootPostId;
        
        // Handle ownership confirmation for non-DM channels (Group DM, Public, Private)
        if (channel.type === "G" || channel.type === "O" || channel.type === "P") {
          // Check if this post was already confirmed via _ownershipConfirmed flag
          // This flag is set by connect.ts when user replies "yes" to ownership confirmation
          if ((post as any)._ownershipConfirmed) {
            log.info(`[SessionOwnership] Post has _ownershipConfirmed flag, creating session in ${channel.type === "G" ? "group DM" : channel.type === "O" ? "public" : "private"} channel ${post.channel_id}`);
            const newSession = await createNewSessionFromDm(userSession, post);
            if (newSession) {
              await handleThreadPrompt({
                sessionId: newSession.sessionId,
                threadRootPostId: newSession.threadRootPostId,
                promptText: post.message.trim(),
                fileIds: post.file_ids,
              }, userSession, post);
            }
            return;
          }
          
          const { sessionOwnershipHandler } = PluginState;
          if (sessionOwnershipHandler?.hasPendingConfirmation(post.channel_id, threadRootPostId, post.user_id)) {
            const confirmResult = await sessionOwnershipHandler.handleReply(
              post.channel_id,
              threadRootPostId,
              post.message.trim()
            );
            
            if (confirmResult.confirmed && confirmResult.post) {
              log.info(`[SessionOwnership] User confirmed with approval policy: ${confirmResult.approvalPolicy || 'none'}`);
              const postWithPolicy = confirmResult.post as any;
              postWithPolicy._ownershipConfirmed = true;
              postWithPolicy._approvalPolicy = confirmResult.approvalPolicy || "none";
              const newSession = await createNewSessionFromDm(userSession, postWithPolicy);
              if (newSession) {
                await handleThreadPrompt({
                  sessionId: newSession.sessionId,
                  threadRootPostId: newSession.threadRootPostId,
                  promptText: confirmResult.post.message.trim(),
                  fileIds: confirmResult.post.file_ids,
                }, userSession, confirmResult.post);
              }
            }
            return;
          }
        }
        
        await mmClient.createPost(
          post.channel_id,
          routeResult.errorMessage,
          routeResult.threadRootPostId
        );
        return;
      }
      
      case "ended_session": {
        await mmClient.createPost(
          post.channel_id,
          `:no_entry: ${routeResult.errorMessage}`,
          routeResult.threadRootPostId
        );
        return;
      }
      
      case "merged_session": {
        const destMapping = routeResult.mergedInto 
          ? threadMappingStore?.getBySessionId(routeResult.mergedInto)
          : null;
        
        const baseUrl = config.mattermost.baseUrl.replace(/\/api\/v4$/, "");
        const redirectLink = destMapping 
          ? `[here](${baseUrl}/_redirect/pl/${destMapping.threadRootPostId})`
          : "another thread";
        
        await mmClient.createPost(
          post.channel_id,
          `:lock: **Thread Merged**\n\nThis thread has been merged into ${redirectLink}.\nPlease continue the conversation there.`,
          routeResult.threadRootPostId
        );
        return;
      }
      
      case "thread_prompt": {
        const promptText = routeResult.promptText.trim();
        
        const { fileCompletionHandler } = PluginState;
        if (fileCompletionHandler && fileCompletionHandler.hasPendingCompletion(routeResult.sessionId)) {
          const disambiguationResult = fileCompletionHandler.handleDisambiguationReply(
            routeResult.sessionId,
            promptText
          );
          
          if (disambiguationResult.resolved) {
            if (disambiguationResult.cancelled) {
              await mmClient.createPost(
                post.channel_id,
                `:white_check_mark: File completion cancelled.`,
                routeResult.threadRootPostId
              );
              return;
            }
            
            if (disambiguationResult.result) {
              log.info(`[FileCompletion] User resolved file references, processing message`);
              await handleThreadPromptWithFiles(
                {
                  sessionId: routeResult.sessionId,
                  threadRootPostId: routeResult.threadRootPostId,
                  promptText: disambiguationResult.result.processedMessage,
                  fileIds: routeResult.fileIds,
                },
                userSession,
                post,
                disambiguationResult.result.resolvedFilePaths
              );
              return;
            }
          }
        }
        
        if (promptText.startsWith(config.sessionSelection.commandPrefix)) {
          const parsed = messageRouter.parseCommand(promptText);
          if (parsed) {
            const result = await commandHandler.execute(parsed, {
              userSession,
              registry: openCodeSessionRegistry,
              mmClient,
              threadMappingStore,
              teamStore: PluginState.teamStore,
              ownerUserId: config.mattermost.ownerUserId,
              questionHandler: PluginState.questionHandler,
              opencodeClient: client,
              sessionId: routeResult.sessionId,
              threadRootPostId: routeResult.threadRootPostId,
              channelId: post.channel_id,
            });
            await mmClient.createPost(post.channel_id, result.message, routeResult.threadRootPostId);
            return;
          }
        }
        
        const numericSelection = parseInt(promptText, 10);
        if (!isNaN(numericSelection) && commandHandler.isPendingModelSelection(routeResult.sessionId, threadMappingStore)) {
          const result = await commandHandler.handleModelSelection(numericSelection, {
            userSession,
            registry: openCodeSessionRegistry,
            mmClient,
            threadMappingStore,
            teamStore: PluginState.teamStore,
            ownerUserId: config.mattermost.ownerUserId,
            questionHandler: PluginState.questionHandler,
            opencodeClient: client,
            sessionId: routeResult.sessionId,
            threadRootPostId: routeResult.threadRootPostId,
          });
          if (result) {
            await mmClient.createPost(post.channel_id, result.message, routeResult.threadRootPostId);
            return;
          }
        }
        
        const { guestApprovalHandler, questionHandler } = PluginState;
        
        // Check if BOTH guest approval AND question are pending - this is a collision scenario
        const hasGuestApproval = guestApprovalHandler && threadMappingStore && guestApprovalHandler.hasPendingApproval(routeResult.sessionId);
        const hasQuestion = questionHandler && questionHandler.hasPendingQuestion(routeResult.sessionId);
        
        // If both are pending and message looks like a question answer (bare number), prioritize question
        // Questions are more time-sensitive (AI is actively waiting) and guest approval has alternative syntax
        if (hasGuestApproval && hasQuestion) {
          const trimmed = promptText.trim();
          const looksLikeQuestionAnswer = /^\d+$/.test(trimmed) || /^\d+(,\s*\d+)+$/.test(trimmed); // "1" or "1, 2, 3"
          const looksLikeGuestApprovalOnly = /^(deny|no|0)$/i.test(trimmed); // Only guest approval uses these
          
          if (looksLikeQuestionAnswer && !looksLikeGuestApprovalOnly) {
            log.info(`[CollisionHandler] Both guest approval and question pending. Message "${trimmed}" looks like question answer - routing to question handler first`);
            // Fall through to question handler below
          } else if (looksLikeGuestApprovalOnly) {
            log.info(`[CollisionHandler] Both pending but message "${trimmed}" is guest approval syntax - routing to guest approval`);
            const approvalResult = await guestApprovalHandler.handleOwnerReply(
              routeResult.sessionId,
              promptText,
              threadMappingStore,
              post.channel_id
            );
            
            if (approvalResult.wasApprovalResponse) {
              if (approvalResult.approved && approvalResult.post) {
                log.info(`[GuestApproval] Processing approved guest message`);
                await handleThreadPrompt({
                  sessionId: routeResult.sessionId,
                  threadRootPostId: routeResult.threadRootPostId,
                  promptText: approvalResult.post.message,
                  fileIds: approvalResult.post.file_ids,
                }, userSession, approvalResult.post);
              }
              return;
            }
          } else {
            // Ambiguous text - could be custom answer or unrecognized. Ask user to clarify.
            log.info(`[CollisionHandler] Both pending, message "${trimmed}" is ambiguous - asking user to clarify`);
            await mmClient.createPost(
              post.channel_id,
              `:warning: **Multiple pending requests**\n\nI have both a **question** and a **guest approval request** pending.\n\n` +
              `• To answer the AI question: Reply with a number (e.g., \`1\`) or your answer\n` +
              `• To respond to guest approval: Use \`approve 1\`, \`approve 2\`, \`approve 3\`, or \`deny\`\n\n` +
              `_Use explicit prefixes to avoid confusion._`,
              routeResult.threadRootPostId
            );
            return;
          }
        } else if (hasGuestApproval) {
          const approvalResult = await guestApprovalHandler.handleOwnerReply(
            routeResult.sessionId,
            promptText,
            threadMappingStore,
            post.channel_id
          );
          
          if (approvalResult.wasApprovalResponse) {
            if (approvalResult.approved && approvalResult.post) {
              log.info(`[GuestApproval] Processing approved guest message`);
              await handleThreadPrompt({
                sessionId: routeResult.sessionId,
                threadRootPostId: routeResult.threadRootPostId,
                promptText: approvalResult.post.message,
                fileIds: approvalResult.post.file_ids,
              }, userSession, approvalResult.post);
            }
            return;
          }
          log.info(`[GuestApproval] Owner message not an approval response, processing as regular prompt`);
        }
        
        // Question handler (either only question pending, or collision where we decided to prioritize question)
        if (questionHandler && questionHandler.hasPendingQuestion(routeResult.sessionId)) {
          const verifyResult = await questionHandler.verifyQuestionStillPending(routeResult.sessionId);
          
          if (!verifyResult.pending) {
            if (verifyResult.reason === "server_no_longer_pending") {
              const questionInfo = questionHandler.getPendingQuestionInfo(routeResult.sessionId);
              const questionHeader = questionInfo?.request.questions[0]?.header || "Unknown";
              log.warn(`[QuestionHandler] Question "${questionHeader}" is no longer pending on server (expired or already answered)`);
              await mmClient.createPost(
                post.channel_id,
                `:warning: This question has expired or was already answered elsewhere. Your response "${promptText}" was not processed.\n\nThe AI session has likely continued without waiting for your answer.`,
                routeResult.threadRootPostId
              );
              return;
            }
          }
          
          const replyResult = await questionHandler.handleUserReply(
            routeResult.sessionId,
            promptText,
            post.channel_id,
            routeResult.threadRootPostId
          );
          
          if (replyResult.handled && replyResult.answers && replyResult.requestId) {
            try {
              const ctx = PluginState.activeResponseContexts.get(routeResult.sessionId);
              if (ctx && streamer) {
                const newStreamCtx = await streamer.recreateStreamAtBottom(ctx.streamCtx);
                ctx.streamCtx = newStreamCtx;
                log.debug(`[QuestionHandler] Recreated stream after answer summary, new postId=${newStreamCtx.postId}`);
              }
              
              const replyUrl = `${opencodeBaseUrl}/question/${replyResult.requestId}/reply`;
              const response = await fetch(replyUrl, {
                method: "POST",
                headers: { 
                  "Content-Type": "application/json",
                  "x-opencode-directory": directory,
                },
                body: JSON.stringify({ answers: replyResult.answers }),
              });
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
              }
              log.info(`[QuestionHandler] Submitted answer for question ${replyResult.requestId}`);
            } catch (e) {
              log.error(`[QuestionHandler] Failed to submit answer:`, e);
              await mmClient.createPost(
                post.channel_id,
                `:x: Failed to submit answer: ${e instanceof Error ? e.message : "Unknown error"}`,
                routeResult.threadRootPostId
              );
            }
            return;
          }
          
          if (replyResult.handled) {
            return;
          }
        }
        
        if (fileCompletionHandler && fileCompletionHandler.hasFileReferences(promptText)) {
            log.info(`[FileCompletion] Message contains !! file references`);
            
            const completionResult = await fileCompletionHandler.processMessage(
              routeResult.sessionId,
              routeResult.threadRootPostId,
              post.channel_id,
              promptText,
              post.user_id,
              routeResult.fileIds
            );
            
            if (completionResult.needsDisambiguation) {
              const disambiguationPrompt = fileCompletionHandler.formatDisambiguationPrompt(
                completionResult.unresolvedReferences
              );
              const disambiguationPost = await mmClient.createPost(
                post.channel_id,
                disambiguationPrompt,
                routeResult.threadRootPostId
              );
              fileCompletionHandler.setDisambiguationPostId(
                routeResult.sessionId,
                disambiguationPost.id
              );
              return;
            }
            
            if (completionResult.resolvedFilePaths.length > 0) {
              await handleThreadPromptWithFiles(
                {
                  sessionId: routeResult.sessionId,
                  threadRootPostId: routeResult.threadRootPostId,
                  promptText: completionResult.processedMessage,
                  fileIds: routeResult.fileIds,
                },
                userSession,
                post,
                completionResult.resolvedFilePaths
              );
              return;
            }
        }
        
        await handleThreadPrompt(routeResult, userSession, post);
        return;
      }
    }
  }

  function convertLegacyRoute(legacyResult: { type: string; command?: any; promptText?: string }, post: Post): InboundRouteResult {
    const { openCodeSessionRegistry } = PluginState;
    
    if (legacyResult.type === "command" && legacyResult.command) {
      return { type: "main_dm_command", command: legacyResult.command };
    }
    
    const defaultSession = openCodeSessionRegistry?.getDefault();
    if (!defaultSession) {
      return {
        type: "main_dm_prompt",
        errorMessage: "No OpenCode session available.",
        suggestedAction: "Start an OpenCode session first.",
      };
    }
    
    return {
      type: "thread_prompt",
      sessionId: defaultSession.id,
      threadRootPostId: "",
      promptText: legacyResult.promptText || post.message,
      fileIds: post.file_ids,
    };
  }

  async function createNewSessionFromDm(
    userSession: UserSession,
    post: Post
  ): Promise<{ sessionId: string; threadRootPostId: string } | null> {
    const { mmClient, threadManager, openCodeSessionRegistry, threadMappingStore } = PluginState;
    if (!mmClient || !threadManager) return null;
    
    try {
      const result = await client.session.create({
        body: {},
        query: { directory }
      });
      
      if (!result.data) {
        throw new Error("Failed to create session - no data returned");
      }
      
      const sessionInfo: OpenCodeSessionInfo = {
        id: result.data.id,
        shortId: result.data.id.substring(0, 8),
        projectName: projectName,
        directory: directory,
        title: result.data.title || `Mattermost DM session`,
        lastUpdated: new Date(),
        isAvailable: true,
      };
      
      const threadRootId = post.root_id || post.id;
      log.info(`[CreateSession] post.id=${post.id}, post.root_id=${post.root_id}, threadRootId=${threadRootId}, post.channel_id=${post.channel_id}`);
      const mapping = await threadManager.createThread(
        sessionInfo,
        userSession.mattermostUserId,
        userSession.dmChannelId,
        threadRootId,
        post.channel_id,
        userSession.mattermostUsername
      );
      
      const approvalPolicy = (post as any)._approvalPolicy as string | undefined;
      if (approvalPolicy && threadMappingStore) {
        const updatedMapping = threadMappingStore.getBySessionId(result.data.id);
        if (updatedMapping) {
          if (approvalPolicy === "approve_all") {
            updatedMapping.approveAllUsers = true;
            log.info(`[CreateSession] Applied approve_all policy to session ${sessionInfo.shortId}`);
          } else if (approvalPolicy === "approve_sender") {
            updatedMapping.approvedUsers = updatedMapping.approvedUsers || [];
            if (!updatedMapping.approvedUsers.includes(post.user_id)) {
              updatedMapping.approvedUsers.push(post.user_id);
            }
            log.info(`[CreateSession] Applied approve_sender policy to session ${sessionInfo.shortId}`);
          }
          threadMappingStore.update(updatedMapping);
        }
      }
      
      await openCodeSessionRegistry?.refresh();
      
      log.info(`[CreateSession] Created new session ${sessionInfo.shortId} for @${userSession.mattermostUsername} in channel ${post.channel_id}`);
      
      return {
        sessionId: result.data.id,
        threadRootPostId: mapping.threadRootPostId,
      };
    } catch (error) {
      log.error("[CreateSession] Failed:", error);
      const errorThreadRoot = post.root_id || post.id;
      await mmClient.createPost(
        post.channel_id,
        `:x: Failed to create session: ${error instanceof Error ? error.message : "Unknown error"}`,
        errorThreadRoot
      );
      return null;
    }
  }

  async function handleThreadPrompt(
    route: { sessionId: string; threadRootPostId: string; promptText: string; fileIds?: string[] },
    userSession: UserSession,
    post: Post
  ): Promise<void> {
    const { streamer, notifications, fileHandler, mmClient, threadMappingStore, todoManager } = PluginState;
    if (!streamer || !notifications || !fileHandler || !mmClient) return;

    if (threadMappingStore && route.threadRootPostId) {
      const mapping = threadMappingStore.getByThreadRootPostId(route.threadRootPostId);
      if (mapping && mapping.status === "orphaned") {
        threadMappingStore.reactivate(route.threadRootPostId);
        log.info(`[ThreadMapping] Reactivated orphaned thread ${route.threadRootPostId} for session ${route.sessionId.substring(0, 8)}`);
      }
    }

    userSession.isProcessing = true;
    userSession.currentPromptPostId = post.id;
    userSession.lastPrompt = post;

    let promptText = route.promptText;
    const threadRootPostId = route.threadRootPostId || undefined;
    const targetSessionId = route.sessionId;
    const shortId = targetSessionId.substring(0, 8);

    const existingMapping = threadMappingStore?.getBySessionId(targetSessionId);
    const targetChannelId = existingMapping?.channelId || existingMapping?.dmChannelId || post.channel_id;

    const channel = await mmClient.getChannel(post.channel_id);
    const isGroupDm = channel.type === "G";
    const botUser = PluginState.botUser;
    
    if (isGroupDm && botUser) {
      promptText = stripBotMention(promptText, botUser.username, botUser.id);
      log.info(`[GroupDM] Stripped bot mention, prompt: "${promptText.slice(0, 50)}..."`);
    }

    const { streamCtx, statusIndicator } = await streamer.startStreamWithStatus(
      userSession,
      threadRootPostId,
      "Checking session status...",
      targetChannelId
    );
    userSession.currentResponsePostId = streamCtx.postId;

    try {
      let sessionIsBusy = false;
      let sessionIsRetrying = false;
      let retryInfo: { attempt?: number; maxAttempts?: number } = {};

      try {
        const statusResult = await client.session.status();
        const statusMap = statusResult.data as Record<string, { type: string; attempt?: number; maxAttempts?: number }> | undefined;
        
        if (statusMap && statusMap[targetSessionId]) {
          const sessionStatus = statusMap[targetSessionId];
          log.debug(`[StatusCheck] Session ${shortId} status: ${sessionStatus.type}`);
          
          if (sessionStatus.type === "busy") {
            sessionIsBusy = true;
          } else if (sessionStatus.type === "retry") {
            sessionIsRetrying = true;
            retryInfo = {
              attempt: sessionStatus.attempt,
              maxAttempts: sessionStatus.maxAttempts,
            };
          }
        }
      } catch (e) {
        log.debug(`[StatusCheck] Could not get session status: ${e}`);
      }

      if (sessionIsBusy) {
        await statusIndicator.setQueued("Session is busy processing another request", 1);
      } else if (sessionIsRetrying) {
        await statusIndicator.setRetrying(
          retryInfo.attempt || 1,
          retryInfo.maxAttempts || 3,
          "Session is retrying a previous operation",
          5000
        );
      } else {
        await statusIndicator.setConnecting(targetSessionId, shortId);
      }

      let inboundFileParts: Array<{ type: "file"; mime: string; filename: string; url: string }> = [];
      if (route.fileIds && route.fileIds.length > 0) {
        const { fileParts, textFilePaths } = await fileHandler.processInboundAttachmentsAsFileParts(route.fileIds);
        inboundFileParts = fileParts;
        if (textFilePaths.length > 0) {
          promptText += `\n\n[Attached files: ${textFilePaths.join(", ")}]`;
        }
        if (fileParts.length > 0) {
          log.info(`[FileHandler] Sending ${fileParts.length} file(s) as FilePartInput to OpenCode`);
        }
      }

      log.info(`Using OpenCode session: ${targetSessionId}`);

      if (threadMappingStore) {
        const mapping = threadMappingStore.getBySessionId(targetSessionId);
        if (mapping) {
          mapping.lastActivityAt = new Date().toISOString();
          threadMappingStore.update(mapping);
        }
      }

      let sessionTotalCost = 0;
      try {
        const messagesResult = await client.session.messages({ path: { id: targetSessionId } });
        const messages = messagesResult.data || [];
        for (const message of messages) {
          if (message.info.role === "assistant") {
            sessionTotalCost += (message.info as any).cost || 0;
          }
        }
        log.debug(`[CostTracker] Session ${shortId} prior cost: $${sessionTotalCost.toFixed(4)}`);
      } catch (e) {
        log.debug(`[CostTracker] Could not fetch session messages: ${e}`);
      }

      const responseContext = createEmptyResponseContext(
        targetSessionId,
        userSession,
        streamCtx,
        threadRootPostId,
        sessionTotalCost
      );
      
      PluginState.activeResponseContexts.set(targetSessionId, responseContext);
      startResponseTimer(targetSessionId);
      
      if (todoManager && threadRootPostId) {
        todoManager.setThreadRoot(targetSessionId, threadRootPostId, targetChannelId);
      }

      const replyContext = threadRootPostId 
        ? `[Reply-To: thread=${threadRootPostId} post=${post.id} channel=${targetChannelId}]`
        : `[Reply-To: post=${post.id} channel=${targetChannelId}]`;
      
      let contextPrefix = "";
      let contextFileParts: Array<{ type: "file"; mime: string; filename: string; url: string }> = [];
      if (isGroupDm && threadRootPostId && botUser) {
        try {
          log.info(`[GroupDM] Building thread context for thread ${threadRootPostId}`);
          let threadContext = await buildThreadContext(mmClient, threadRootPostId, post.id, botUser.id, 5);
          
          if (threadContext.messages.length > 0) {
            threadContext = await summarizeContextWithHaiku(client, targetSessionId, threadContext);
            contextPrefix = formatContextForPrompt(threadContext, userSession.mattermostUsername || "user");
            log.info(`[GroupDM] Injecting ${threadContext.wasSummarized ? "summarized" : "full"} context (${threadContext.messages.length} messages)`);
            
            if (threadContext.allFileIds.length > 0 && fileHandler) {
              log.info(`[GroupDM] Processing ${threadContext.allFileIds.length} file attachment(s) from thread context`);
              const { fileParts: ctxFileParts, textFilePaths: ctxTextPaths } = await fileHandler.processInboundAttachmentsAsFileParts(threadContext.allFileIds);
              contextFileParts = ctxFileParts;
              if (ctxTextPaths.length > 0) {
                contextPrefix += `\n[Context attachments downloaded: ${ctxTextPaths.join(", ")}]`;
              }
              if (ctxFileParts.length > 0) {
                log.info(`[GroupDM] Processed ${ctxFileParts.length} context file(s) as FileParts`);
              }
            }
          }
        } catch (e) {
          log.error(`[GroupDM] Failed to build context: ${e}`);
        }
      }
      
      const promptMessage = `[Mattermost DM from @${userSession.mattermostUsername}]\n${replyContext}\n${contextPrefix}${promptText}`;
      
      log.debug(`Injecting prompt into session ${targetSessionId}: "${promptMessage.slice(0, 150)}..."`);
      
      await statusIndicator.setProcessing();
      
      const mapping = threadMappingStore?.getBySessionId(targetSessionId);
      const selectedModel = mapping?.model;
      
      if (selectedModel) {
        log.debug(`[ModelSelection] Using model ${selectedModel.providerID}/${selectedModel.modelID} for session ${shortId}`);
      }
      
      const allFileParts = [...contextFileParts, ...inboundFileParts];
      const promptParts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; filename: string; url: string }> = [
        { type: "text", text: promptMessage },
        ...allFileParts,
      ];

      await client.session.promptAsync({
        path: { id: targetSessionId },
        body: {
          parts: promptParts,
          ...(selectedModel && {
            model: {
              providerID: selectedModel.providerID,
              modelID: selectedModel.modelID,
            },
          }),
        },
      });

      log.info(`Prompt injected into session ${targetSessionId} from @${userSession.mattermostUsername}`);

    } catch (error) {
      log.error("Error processing message:", error);
      
      stopResponseTimer(route.sessionId);
      stopActiveToolTimer(route.sessionId);
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      await statusIndicator.setError(errorMsg, true);
      
      if (notifications && userSession) {
        await notifications.notifyError(userSession, error as Error);
      }
      userSession.isProcessing = false;
      PluginState.activeResponseContexts.delete(route.sessionId);
    }
  }

  async function handleThreadPromptWithFiles(
    route: { sessionId: string; threadRootPostId: string; promptText: string; fileIds?: string[] },
    userSession: UserSession,
    post: Post,
    resolvedFilePaths: string[]
  ): Promise<void> {
    const { fileCompletionHandler, mmClient } = PluginState;
    
    if (!fileCompletionHandler || !mmClient || resolvedFilePaths.length === 0) {
      return handleThreadPrompt(route, userSession, post);
    }
    
    let fileContentSuffix = "";
    const attachedFiles: string[] = [];
    
    for (const filePath of resolvedFilePaths) {
      const content = await fileCompletionHandler.readFileContent(filePath);
      if (content !== null) {
        fileContentSuffix += fileCompletionHandler.formatFileContentForPrompt(filePath, content);
        attachedFiles.push(filePath);
        log.info(`[FileCompletion] Attached file content: ${filePath} (${content.length} chars)`);
      } else {
        log.warn(`[FileCompletion] Could not read file: ${filePath}`);
      }
    }
    
    if (attachedFiles.length > 0) {
      const updatedRoute = {
        ...route,
        promptText: route.promptText + fileContentSuffix,
      };
      
      log.info(`[FileCompletion] Processing prompt with ${attachedFiles.length} attached file(s)`);
      return handleThreadPrompt(updatedRoute, userSession, post);
    }
    
    return handleThreadPrompt(route, userSession, post);
  }

  const mattermostConnectTool = createConnectTool(connectionContext);
  const mattermostDisconnectTool = createDisconnectTool();
  const mattermostStatusTool = createStatusTool(projectName);
  const mattermostListSessionsTool = createListSessionsTool();
  const mattermostSelectSessionTool = createSelectSessionTool();
  const mattermostCurrentSessionTool = createCurrentSessionTool();
  const mattermostMonitorTool = createMonitorTool({ client, directory, projectName });
  const mattermostUnmonitorTool = createUnmonitorTool(client);
  const mattermostSendFileTool = createSendFileTool();

  const scheduleContext = { client, directory, projectName };
  const mattermostScheduleAddTool = createScheduleAddTool(scheduleContext);
  const mattermostScheduleListTool = createScheduleListTool();
  const mattermostScheduleRemoveTool = createScheduleRemoveTool();
  const mattermostScheduleEnableTool = createScheduleEnableTool();
  const mattermostScheduleDisableTool = createScheduleDisableTool();
  const mattermostScheduleRunTool = createScheduleRunTool();

  return {
    tool: {
      mattermost_connect: mattermostConnectTool,
      mattermost_disconnect: mattermostDisconnectTool,
      mattermost_status: mattermostStatusTool,
      mattermost_list_sessions: mattermostListSessionsTool,
      mattermost_select_session: mattermostSelectSessionTool,
      mattermost_current_session: mattermostCurrentSessionTool,
      mattermost_monitor: mattermostMonitorTool,
      mattermost_unmonitor: mattermostUnmonitorTool,
      mattermost_send_file: mattermostSendFileTool,
      mattermost_schedule_add: mattermostScheduleAddTool,
      mattermost_schedule_list: mattermostScheduleListTool,
      mattermost_schedule_remove: mattermostScheduleRemoveTool,
      mattermost_schedule_enable: mattermostScheduleEnableTool,
      mattermost_schedule_disable: mattermostScheduleDisableTool,
      mattermost_schedule_run: mattermostScheduleRunTool,
    },

    async event({ event }) {
      const eventType = event.type as string;
      
      if (eventType === "permission.asked") {
        await handlePermissionAsked(event);
      } else if (eventType === "question.asked") {
        await handleQuestionAsked(event);
      } else if (eventType === "session.idle") {
        await handleSessionIdle(event);
      } else if (eventType === "session.status") {
        await handleSessionStatus(event);
      } else if (eventType === "session.compacted") {
        await handleSessionCompacted(event);
      } else if (eventType === "message.updated") {
        await handleMessageUpdated(event);
      } else if (eventType === "message.part.updated") {
        await handleMessagePartUpdated(event);
      } else if (eventType === "file.edited") {
        await handleFileEdited(event);
      } else if (eventType === "todo.updated") {
        await handleTodoUpdated(event);
      }
    },

    "tool.execute.before": async (input) => {
      await handleToolExecuteBefore(input);
    },

    "tool.execute.after": async (input) => {
      await handleToolExecuteAfter(input);
    },
  };
};

export default MattermostControlPlugin;
