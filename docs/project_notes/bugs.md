# Bug Log

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
