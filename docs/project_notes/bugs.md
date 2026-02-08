# Bug Log

## 2026-02-07: Scheduled tasks fail with "Empty response from LLM" due to stale session IDs (v0.3.72 → v0.3.73)

**Problem:** All 13 enabled scheduled tasks fail with "Empty response from LLM" after every OpenCode restart. Session IDs are ephemeral — they change on restart — but scheduled tasks persist old session IDs in `mattermost-schedules.json`.

**Example:** 4 stale session IDs across 13 tasks: `ses_4230dc92bffe`, `ses_3d1dc5817ffe`, `ses_3caae02c2ffe`, `ses_3d4bd4e46ffe` — none exist after restart.

**Root Cause:** `SchedulerService.executeSchedule()` calls `ctx.client.session.prompt(schedule.sessionId, ...)`. When the session ID doesn't exist, the prompt silently fails and returns empty, which the scheduler reports as "Empty response from LLM".

**Fix:** Added `rebindStaleSessions(availableSessionIds, fallbackSessionId)` method to `scheduler-service.ts`. Called during `connect.ts` startup after `scheduler.start()`. On each connect:
1. Gets all available sessions from `openCodeSessionRegistry.listAvailable()`
2. Gets default session from `openCodeSessionRegistry.getDefault()`
3. For each schedule whose `sessionId` is NOT in the available set, rebinds it to the fallback (default or first available) session
4. Persists the updated session ID via `store.update()`

**Files Changed:**
- `src/scheduler/scheduler-service.ts` — Added `rebindStaleSessions()` method (lines 148-179)
- `.opencode/plugin/mattermost-control/tools/connect.ts` — Wired rebind call after `scheduler.start()` (lines ~205-215)

**Prevention:** Session IDs are ephemeral by design. Any component that persists session references must handle rebinding on startup. Consider adding a `session.invalidated` event listener for proactive rebinding.

**Verified:** Published v0.3.73. Pending restart verification — logs should show `[SchedulerService] Re-bound N schedules to session ...`

---

## 2026-02-07: Scheduled task prompts leak into wrong Mattermost threads via TUI sync (v0.3.71 → v0.3.72)

**Problem:** Scheduled task prompts (e.g. `functional-standup-feedback-sat`) appeared as `[TUI]` messages in unrelated Mattermost threads. The scheduler injects prompts into a session via `session.prompt()`, which triggers a `chat.message` event. The TUI sync handler in `index.ts` then posted the prompt text to whatever Mattermost thread was mapped to that session — even though the thread had nothing to do with the scheduled task.

**Example:** Standup feedback task prompt appeared in a "Deployment automation" discussion thread in the platform channel.

**Root Cause:** The `chat.message` handler in `index.ts` (line ~997) fires for ALL user messages to any session, including scheduler-injected prompts. All other event handlers (message.ts, session.ts, permission.ts, question.ts, todo.ts, file.ts, tool.ts, compaction.ts) already checked `isScheduledTaskSession()` and suppressed output. The TUI sync handler was the ONLY path missing this check.

**Fix:** Added `schedulerService?.isRunningScheduledTask(input.sessionID)` check at the top of the `chat.message` handler to suppress TUI sync for scheduled task sessions:

```typescript
// Suppress TUI sync for scheduled task sessions to prevent posting to wrong threads
if (schedulerService?.isRunningScheduledTask(input.sessionID)) {
  log.debug(`[TUISync] Suppressing TUI sync for scheduled task session ${input.sessionID.substring(0, 8)}`);
  return;
}
```

**Additional issue found:** All 14 scheduled tasks have stale session IDs (sessions change on OpenCode restart), causing "Empty response from LLM" failures. This is a separate issue to address.

**Verified:** Code review confirms the fix is correct — `PluginState.schedulerService` is accessible (state.ts line 76), `isRunningScheduledTask()` tracks running sessions via `runningScheduledSessions` Set.

---

## 2026-01-26: Non-DM channel session creation fails after ownership confirmation (v0.3.36 → v0.3.37)

**Problem:** User @mentions bot in a public/private channel thread, bot asks for ownership confirmation, user replies "yes", but then gets error: "This thread is not associated with any OpenCode session."

**Specific case:** https://mattermost.dev.hyperplane.dev/shakudo-internal/pl/cqm6if39c3yu98e5gtw1ifcq9h
- User @mentioned bot in channel (type `O` or `P`)
- Bot asked: "Would you like to create a new OpenCode session?"
- User replied "yes"
- Session was created, but routing returned `type=unknown_thread`

**Root Cause:** In `.opencode/plugin/mattermost-control/index.ts`, the `unknown_thread` case only handled `_ownershipConfirmed` flag for Group DMs (`channel.type === "G"`), but NOT for public channels (`O`) or private channels (`P`).

```typescript
// OLD - only handled Group DMs
if (channel.type === "G") {
  if ((post as any)._ownershipConfirmed) { /* create session */ }
}
```

When ownership is confirmed in a public/private channel, the code fell through to the error message instead of creating the session.

**Fix:** Extended the condition to include all non-DM channel types:
```typescript
// NEW - handles Group DM, Public, and Private channels
if (channel.type === "G" || channel.type === "O" || channel.type === "P") {
  if ((post as any)._ownershipConfirmed) { /* create session */ }
}
```

**Files Changed:**
- `.opencode/plugin/mattermost-control/index.ts` - Line 159: Extended channel type check

**Prevention:** When adding channel-specific behavior, always consider ALL non-DM channel types: `G` (Group DM), `O` (Public), and `P` (Private). The ownership confirmation flow applies to all of these.

**Verified:** TypeScript compiles, published v0.3.37

---

## 2026-01-26: Scheduled task responses routed to wrong thread (v0.3.32 → v0.3.33)

**Problem:** A scheduled job (`functional-standup-reminder`) response appeared in an unrelated session/thread instead of being sent as a direct DM. The scheduled task's streaming updates were routed through existing `activeResponseContexts` to whatever thread happened to be mapped to that session.

**Specific case:** Scheduled task ran on session that had an existing Mattermost thread mapping, causing intermediate streaming events (`message.part.updated`, `session.idle`, etc.) to post to that thread instead of being suppressed.

**Root Cause:** The scheduler uses `ctx.client.session.prompt()` which is synchronous but OpenCode still emits streaming events. Event handlers route responses via `PluginState.activeResponseContexts.get(sessionId)` - if the session has an existing context from a prior user interaction, events get routed there. The scheduler's final `sendEphemeralAlert()` correctly sends results as a fresh DM, but intermediate streaming updates polluted unrelated threads.

**Fix:** Added `isRunningScheduledTask()` check to all event handlers. When a session is running a scheduled task, all streaming events are suppressed:

1. `SchedulerService` tracks running sessions in `runningScheduledSessions: Set<string>`
2. `isRunningScheduledTask(sessionId)` method added to check if session should be isolated
3. All event handlers (`message.ts`, `session.ts`, `tool.ts`, `todo.ts`, `compaction.ts`, `question.ts`, `file.ts`, `permission.ts`) now check this before routing

**Files Changed:**
- `src/scheduler/scheduler-service.ts` - Already had the tracking set and method (added in previous iteration)
- `.opencode/plugin/mattermost-control/event-handlers/*.ts` - All 8 handlers updated to check `isScheduledTaskSession()`

**Prevention:** When adding new execution contexts (scheduled tasks, background jobs, etc.), ensure streaming event handlers are aware and can isolate those contexts from user-facing threads.

**Verified:** TypeScript compiles, published v0.3.33

---

## 2026-01-22: Thread context missing when session created from existing thread (v0.3.24 → v0.3.25)

**Problem:** When a session is created from an existing Mattermost thread (user's message is the root), the LLM doesn't receive the thread context. It says "I need to understand what task you're referring to" even though the original question is visible in the thread.

**Specific case:** https://mattermost.dev.hyperplane.dev/shakudo-internal/pl/okqzw6k81p8qxnqg8b9f7e9azh
- Christine posted asking about contract modifications (root post)
- shakudobabyagi responded with advice
- Yevgeniy @mentioned Kaji: "@kaji can you please do this for @christine"
- Session was created, but bot didn't see Christine's original question

**Root Cause:** In `src/context-builder.ts`, the `buildThreadContext()` function unconditionally filtered out the root post:
```typescript
if (post.id === threadRootPostId) return false;  // Always excluded root
```
The comment said "usually just session info" - true when the BOT creates the thread (rocket emoji announcement), but FALSE when a session is created in an EXISTING user thread.

**Fix:** Only exclude root post if it's a bot message:
```typescript
if (post.id === threadRootPostId && post.user_id === botUserId) return false;
```

**Files Changed:**
- `src/context-builder.ts` - Changed filter condition at line ~77

**Prevention:** When filtering posts for context, consider the different thread creation scenarios. Don't assume root post is always bot-generated session info.

---

## 2026-01-22: Question timeout - user reply ignored after ~105 minutes (v0.3.23 → v0.3.24)

**Problem:** User replied "1" to a question ~105 minutes after it was asked, but the response wasn't processed. The AI had continued without the answer.

**Specific case:** https://mattermost.dev.hyperplane.dev/shakudo-internal/pl/kwawy4tis7dr5e4d6f47q4n6ww
- Question "Loki StatefulSet Diff" asked at timestamp `1769031244047`
- User replied "1" at timestamp `1769037557087` (~105 minutes later)
- Bot was already processing bash commands 77ms after user's reply

**Root Cause:** The plugin and OpenCode server track questions independently in-memory:
- **Plugin:** `pendingQuestions` Map in `QuestionHandler`
- **Server:** `pending` record in `Question` namespace

When the OpenCode server restarts or the session continues (e.g., due to context compaction), the server-side question is lost/resolved, but the plugin still thinks it's pending. When user finally replies, the plugin calls `/question/{id}/reply` but the server silently ignores it ("reply for unknown request" log).

**Fix:** Added server-side question state verification:
1. `QuestionHandler.setOpenCodeConfig(baseUrl, directory)` - Configure server connection
2. `QuestionHandler.verifyQuestionStillPending(sessionId)` - Check with server before processing reply
3. `QuestionHandler.syncWithServer()` - Periodic sync to clean up stale questions

**Implementation:**
- Before processing a question reply, call `/question` endpoint to verify question exists on server
- If server no longer has the question, notify user: "This question has expired or was already answered elsewhere"
- Cleanup timer now also syncs with server every 5 minutes to remove stale plugin state

**Files Changed:**
- `src/question-handler.ts` - Added `setOpenCodeConfig`, `verifyQuestionStillPending`, `syncWithServer`
- `.opencode/plugin/mattermost-control/index.ts` - Added verification before processing reply
- `.opencode/plugin/mattermost-control/tools/connect.ts` - Configure question handler with OpenCode URL
- `.opencode/plugin/mattermost-control/timers.ts` - Added server sync to cleanup timer

**Prevention:** When syncing state between plugin and server, always verify server-side state before acting on plugin-side state, especially for long-running interactions like questions.

---

## 2026-01-21: File completion `!!` feature - API response format and `!cancel` flow (v0.3.22 → v0.3.23)

**Problem 1:** File search with `!!path` always returned "No files found" even when files exist.

**Root Cause:** The `/find/file` API returns a plain string array `["path1", "path2", ...]`, but the code expected `{ files: [{ path, score }] }`.

**Fix:** Updated `searchFiles()` in `src/file-completion-handler.ts` to handle the actual API response format:
```typescript
// OLD - wrong assumption
const data = await response.json() as { files?: Array<{ path: string; score: number }> };
if (!data.files || !Array.isArray(data.files)) return [];

// NEW - matches actual API
const data = await response.json();
if (!Array.isArray(data)) return [];
return data.map((path: string) => ({ path, score: 0 }));
```

**Problem 2:** `!cancel` command didn't work during file completion disambiguation.

**Root Cause:** In the message flow, command parsing (`!cancel` → "Unknown command") ran BEFORE the file completion handler could check for `!cancel`. The command handler doesn't have a `cancel` command registered, so it returned "Unknown command" and never reached the disambiguation handler.

**Fix:** Moved the pending file completion check to run BEFORE command parsing in `.opencode/plugin/mattermost-control/index.ts`:
```typescript
// Check pending file completions FIRST (before command parsing)
if (fileCompletionHandler?.hasPendingCompletion(sessionId)) {
  const result = fileCompletionHandler.handleDisambiguationReply(sessionId, promptText);
  if (result.resolved && result.cancelled) { /* handle cancel */ }
}

// THEN check for commands
if (promptText.startsWith(commandPrefix)) { /* parse command */ }
```

**Prevention:** When adding special reply handlers (disambiguation, questions, etc.), ensure they run before generic command parsing if they need to handle `!commands` themselves.

---

## 2026-01-21: Multiple instances send ownership confirmation in group DMs (v0.3.17 → v0.3.18)

**Problem:** When user A creates a session in a group DM thread, and user B @mentions the bot in that thread, BOTH instances respond:
- User A's instance: correctly sends guest approval request
- User B's instance: incorrectly sends ownership confirmation ("Do you want to create a session?")

**Root Cause:** Each OpenCode instance stores thread mappings locally in `~/.config/opencode/mattermost-threads.json`. When user B @mentions the bot:
- User A's instance has the mapping and knows there's already a session → asks for guest approval
- User B's instance has no mapping and sees `isOwner=true` (based on local owner config) → asks to create session

**Fix:** 
1. Added `**Owner**: @username` to session announcement messages
2. Added `checkExistingSessionOwner()` method that fetches the thread and looks for existing session announcements
3. If another user is already the owner, skip the ownership confirmation prompt

**Files Changed:**
- `src/models/index.ts` - Added `ownerUsername` to `ThreadRootPostContent` interface
- `src/thread-manager.ts` - Updated `createThread()` to accept and display owner username
- `src/session-ownership-handler.ts` - Added `checkExistingSessionOwner()` and skip logic
- `.opencode/plugin/mattermost-control/tools/connect.ts` - Pass owner username to createThread
- `.opencode/plugin/mattermost-control/index.ts` - Pass owner username to createThread

**Prevention:** When checking if a user can create a session in a group DM thread, always check if another instance has already created one by looking for session announcements in the thread.

---

## 2026-01-21: Group DM session creation fails with "Invalid RootId parameter" (v0.3.11 → v0.3.16)

**Problem:** When user confirms "yes" to create a session in a group DM thread, the session creation fails with:
```
Invalid RootId parameter
```

**Symptoms:**
- Ownership confirmation flow works (bot asks, user replies "yes")
- Session creation in OpenCode succeeds
- Posting "Session Started" message to Mattermost fails
- ~46 seconds later, a fallback thread gets created in the wrong channel (1:1 DM instead of group DM)

**Root Cause:** The `originalPost` stored in the pending confirmation was the @mention post, which is a **reply** in the thread. The code was using `post.id` as the thread root, but when the @mention is a reply, `post.id` is not the thread root - `post.root_id` is.

**Fix:** In `createNewSessionFromDm()`, changed:
```typescript
// OLD - fails when @mention is a reply in a thread
const threadRootId = post.id;
```
To:
```typescript
// NEW - works for both root posts and replies
const threadRootId = post.root_id || post.id;
```

**Files Fixed:**
- `.opencode/plugin/mattermost-control/index.ts:368` - Use `post.root_id || post.id` for threadRootId
- `src/thread-manager.ts:46` - Added verbose logging for debugging

**Debug approach:**
1. Created WebSocket listener (`/tmp/mm-debug-listener.ts`) to capture raw post data
2. Confirmed the API works with correct values via direct curl test
3. Added logging to trace actual values being passed

**Prevention:** When working with Mattermost threads, always check if a post is a reply (`post.root_id` exists) vs a root post. Use the pattern `post.root_id || post.id` to get the thread root.

---

## 2026-01-20: Group DM responses fail with "Invalid ChannelId for RootId parameter" (v0.3.3 → v0.3.4)

**Problem:** When user sends message in group DM, bot creates thread successfully but then fails to post responses with error:
```
Invalid ChannelId for RootId parameter
```

**Cause:** Multiple places in the code used `userSession.dmChannelId` (the 1:1 DM channel) or `mapping.dmChannelId` instead of the actual channel where the message came from (`mapping.channelId` or `post.channel_id`).

**Files Fixed:**
- `.opencode/plugin/mattermost-control/tools/file.ts:28` - Use `mapping.channelId || mapping.dmChannelId`
- `.opencode/plugin/mattermost-control/index.ts` - Multiple fixes for targetChannelId, model selection, question handler
- `.opencode/plugin/mattermost-control/event-handlers/question.ts:28` - Use `mapping.channelId || mapping.dmChannelId`
- `.opencode/plugin/mattermost-control/event-handlers/compaction.ts:37` - Use `ctx.streamCtx?.channelId`

**Pattern:** Throughout the codebase, replaced:
```typescript
// OLD - only works for 1:1 DMs
userSession.dmChannelId
mapping.dmChannelId
```
With:
```typescript
// NEW - works for both 1:1 and group DMs
mapping.channelId || mapping.dmChannelId  // when you have mapping
post.channel_id  // when you have the original post
ctx.streamCtx?.channelId || ctx.mmSession.dmChannelId  // when you have response context
```

**Prevention:** When posting to a thread, always use the channel ID from the thread mapping, not the user session's default DM channel.

---

## 2026-01-20: TypeScript error with channelId type mismatch

**Problem:** `Type 'string | undefined' is not assignable to type 'string'` in thread-mapping-store.ts

**Cause:** Interface `ThreadSessionMapping` had `channelId: string` but Zod schema had it optional for backward compatibility.

**Solution:** Changed interface to `channelId?: string` to match Zod schema.

**File:** `src/models/index.ts` line 172

---

## 2026-02-04: Threads marked orphaned on OpenCode restart (v0.3.50 → v0.3.51)

**Problem:** After restarting OpenCode, all Mattermost threads are marked as "orphaned" and users see "This session is no longer available (OpenCode may have restarted)" error when trying to use existing threads.

**Specific case:** After restart, 288 out of 348 threads were orphaned. Only 2 remained active (likely created after restart).

**Root Cause:** The `cleanOrphanedMappings()` function in `tools/connect.ts` runs on every plugin connect. It marks threads as orphaned if their `sessionId` doesn't exist in current OpenCode sessions. But session IDs are ephemeral - they change on every restart. So ALL old threads fail the check and get orphaned.

```typescript
// In thread-mapping-store.ts - the problematic logic
async cleanOrphaned(validSessionIds: Set<string>): Promise<number> {
  for (const mapping of this.listAll()) {
    if (mapping.status === "active" && !validSessionIds.has(mapping.sessionId)) {
      mapping.status = "orphaned";  // This kills ALL threads on restart
      await this.update(mapping);
    }
  }
}
```

**Fix:** Disabled `cleanOrphanedMappings()` call in `tools/connect.ts`:

```typescript
// NOTE: cleanOrphanedMappings disabled - it incorrectly marks threads as orphaned
// when OpenCode restarts (session IDs change). Threads should remain active
// and be matched by other means (user ID, project, etc.) rather than exact session ID.
// cleanOrphanedMappings(threadMappingStore, availableSessions);
```

**Data Fix:** Reactivate orphaned threads in JSON file:
```bash
cd ~/.config/opencode && cat mattermost-threads.json | jq '(.mappings |= map(if .status == "orphaned" then .status = "active" else . end))' > tmp.json && mv tmp.json mattermost-threads.json
```

**Files Changed:**
- `.opencode/plugin/mattermost-control/tools/connect.ts` - Commented out `cleanOrphanedMappings()` call

**Prevention:** Session IDs should NOT be used as the primary identifier for thread validity. Threads should remain active and be matched by user ID, project directory, or other persistent identifiers. The orphan cleanup logic needs redesign to only orphan threads whose PROJECTS no longer exist, not just sessions.

**Verified:** Fix deployed in v0.3.51, 288 threads reactivated from orphaned→active status.

---

## 2026-01-18: mmClient closure timing bug (v0.3.1 → v0.3.2)

**Problem:** Plugin crashed on disconnect due to accessing closed mmClient.

**Solution:** Added null checks before mmClient operations in disconnect flow.

---
