# Bug Log

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

## 2026-01-18: mmClient closure timing bug (v0.3.1 → v0.3.2)

**Problem:** Plugin crashed on disconnect due to accessing closed mmClient.

**Solution:** Added null checks before mmClient operations in disconnect flow.

---
