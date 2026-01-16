# Design: Reply Context & New Session Creation

**Branch**: `002-reply-context-and-new-session`
**Date**: 2026-01-16
**Status**: PROPOSAL (not yet implemented)

---

## Overview

This document proposes two enhancements to the OpenCode Mattermost plugin:

1. **Reply Context in Prompts**: Include Mattermost thread/post IDs in injected prompts so agents with other Mattermost integrations can reply to the correct thread.

2. **New Session from Main DM**: Allow users to start a new OpenCode session by sending a message in the main DM channel (instead of requiring an existing session thread).

---

## Feature 1: Reply Context in Prompts

### Problem Statement

Currently, when a Mattermost message is injected into an OpenCode session, only the username is included:

```typescript
// Current format (index.ts:531)
const promptMessage = `[Mattermost DM from @${userSession.mattermostUsername}]: ${promptText}`;
```

If the agent has access to Mattermost tools (MCP server, direct API, etc.), it has no way to know which thread to reply to. The agent would need to search for recent messages or guess.

### Proposed Solution

Include structured metadata in the prompt that provides all necessary context for replying:

```typescript
// Proposed format
const promptMessage = `[Mattermost DM from @${userSession.mattermostUsername}]
[Reply-To: thread=${threadRootPostId} post=${post.id} channel=${userSession.dmChannelId}]
${promptText}`;
```

### Design Details

#### Option A: Inline Metadata (Recommended)

Add a second metadata line with reply context:

```
[Mattermost DM from @yevgeniy]
[Reply-To: thread=abc123def456 post=xyz789 channel=dm_channel_id]
Help me debug this issue...
```

**Pros**:
- Human-readable
- Easy for agents to parse
- Minimal change to existing format
- Backward compatible (old code ignores extra lines)

**Cons**:
- Slightly increases prompt length

#### Option B: JSON Metadata Block

```
[Mattermost Context]
{"from": "@yevgeniy", "thread": "abc123", "post": "xyz789", "channel": "dm_ch_id"}
[/Mattermost Context]
Help me debug this issue...
```

**Pros**:
- Structured, easy to parse programmatically
- Can include additional metadata easily

**Cons**:
- More verbose
- Less human-readable
- Bigger change to existing format

#### Option C: Single-Line Extended Format

```
[Mattermost DM from @yevgeniy | thread:abc123 | post:xyz789 | channel:dm_ch_id]: Help me debug...
```

**Pros**:
- Single line
- Compact

**Cons**:
- Harder to parse
- Gets long with multiple fields

### Recommendation

**Option A (Inline Metadata)** is recommended because:
1. Minimal change to existing format
2. Easy to read and parse
3. Maintains backward compatibility
4. Clear separation between metadata and user message

### Implementation Changes

**File**: `.opencode/plugin/mattermost-control/index.ts`

```typescript
// In handleThreadPrompt function (around line 531)
async function handleThreadPrompt(
  route: { sessionId: string; threadRootPostId: string; promptText: string; fileIds?: string[] },
  userSession: UserSession,
  post: Post
): Promise<void> {
  // ... existing code ...

  // Build prompt with reply context
  const replyContext = route.threadRootPostId 
    ? `\n[Reply-To: thread=${route.threadRootPostId} post=${post.id} channel=${userSession.dmChannelId}]`
    : `\n[Reply-To: post=${post.id} channel=${userSession.dmChannelId}]`;
  
  const promptMessage = `[Mattermost DM from @${userSession.mattermostUsername}]${replyContext}\n${promptText}`;
  
  // ... rest of injection code ...
}
```

### Testing Strategy

1. Send a message in a session thread
2. Verify the injected prompt contains the correct thread ID
3. Use a Mattermost MCP tool to reply using the thread ID
4. Verify the reply appears in the correct thread

---

## Feature 2: New Session Creation from Main DM

### Problem Statement

Currently, prompts sent in the main DM (outside any thread) are rejected with:

```
:warning: Prompts must be sent in a session thread, not the main DM.
Use `!sessions` to see available sessions and their threads.
```

This requires users to either:
- Have an existing OpenCode session running
- Use `!sessions` to find a thread
- Manually start OpenCode in a terminal

Users want to simply DM the bot to start working, even if no session exists.

### Proposed Solution

When a prompt is received in the main DM (not a thread, not a command):
1. Check if there are any available sessions
2. If none exist, create a new session using `client.session.create()`
3. Create a thread for the new session
4. Route the prompt to the new session

### Design Details

#### User Experience Flow

**Scenario: No existing sessions**

```
User (main DM): Help me build a React component
Bot: 🚀 Starting new OpenCode session...

Bot (creates thread): 🚀 OpenCode Session Started
                      Project: opencode-mattermost-plugin
                      Directory: /root/gitrepos/opencode-mattermost-plugin
                      Session: ses_abc1
                      Started: 2026-01-16T10:30:00.000Z
                      
                      Reply in this thread to send prompts.

Bot (in thread): [Streaming response to the user's request...]
```

**Scenario: Sessions exist but none selected**

Current behavior rejects the message. Options:
- **Option 2A**: Auto-select the most recently active session
- **Option 2B**: Create a new session anyway
- **Option 2C**: Ask user to choose (current behavior, improved)

**Recommendation**: Option 2A (auto-select most recent) with a note that they can use `!sessions` to switch.

#### Session Creation API

The OpenCode SDK provides session creation:

```typescript
// From /tmp/opencode/packages/sdk/js/src/gen/types.gen.ts
export type SessionCreateData = {
  body?: {
    parentID?: string;  // For child sessions
    title?: string;     // Session title
  };
  query?: {
    directory?: string; // Working directory
  };
};
```

Usage in plugin:
```typescript
const newSession = await client.session.create({
  body: {
    title: `Mattermost session - ${new Date().toISOString()}`
  },
  query: {
    directory: directory  // From plugin context
  }
});
```

#### Implementation Changes

**File**: `.opencode/plugin/mattermost-control/index.ts`

1. **Modify `handleUserMessage`** to handle main DM prompts:

```typescript
case "main_dm_prompt": {
  // Instead of rejecting, try to create/find a session
  const availableSessions = openCodeSessionRegistry?.listAvailable() || [];
  
  if (availableSessions.length === 0) {
    // No sessions - create one
    const newSession = await createNewSessionFromDm(userSession, post);
    if (newSession) {
      // Route to the new session
      await handleThreadPrompt({
        sessionId: newSession.sessionId,
        threadRootPostId: newSession.threadRootPostId,
        promptText: post.message,
        fileIds: post.file_ids,
      }, userSession, post);
    }
  } else {
    // Sessions exist - use most recent or ask user
    const mostRecent = availableSessions[0]; // Already sorted by lastUpdated
    await mmClient.createPost(
      userSession.dmChannelId,
      `:information_source: Routing to most recent session: **${mostRecent.projectName}** (${mostRecent.shortId})\n\nUse \`!sessions\` to see all sessions or reply in a specific thread.`
    );
    // ... route to that session
  }
  return;
}
```

2. **Add new helper function**:

```typescript
async function createNewSessionFromDm(
  userSession: UserSession,
  post: Post
): Promise<{ sessionId: string; threadRootPostId: string } | null> {
  if (!client || !mmClient || !threadManager) return null;
  
  try {
    // Notify user
    await mmClient.createPost(
      userSession.dmChannelId,
      `:rocket: Starting new OpenCode session...`
    );
    
    // Create session via OpenCode API
    const result = await client.session.create({
      body: {
        title: `Mattermost DM - ${new Date().toISOString()}`
      },
      query: {
        directory: directory  // Plugin's current directory
      }
    });
    
    if (!result.data) {
      throw new Error("Failed to create session");
    }
    
    const sessionInfo: OpenCodeSessionInfo = {
      id: result.data.id,
      shortId: result.data.id.substring(0, 8),
      projectName: directory.split("/").pop() || "opencode",
      directory: directory,
      title: result.data.title,
      lastUpdated: new Date(),
      isAvailable: true,
    };
    
    // Create thread for the new session
    const mapping = await threadManager.createThread(
      sessionInfo,
      userSession.mattermostUserId,
      userSession.dmChannelId
    );
    
    // Refresh registry
    await openCodeSessionRegistry?.refresh();
    
    return {
      sessionId: result.data.id,
      threadRootPostId: mapping.threadRootPostId,
    };
  } catch (error) {
    log.error("[CreateSession] Failed:", error);
    await mmClient.createPost(
      userSession.dmChannelId,
      `:x: Failed to create session: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    return null;
  }
}
```

### Edge Cases

1. **What directory for new session?**
   - Use the plugin's `directory` from PluginInput
   - This is the directory where OpenCode was started with `mattermost_connect`

2. **What if session creation fails?**
   - Show error message to user
   - Suggest they start OpenCode manually

3. **What if thread creation fails after session creation?**
   - Session exists but no thread
   - Should still work - prompt can be sent directly
   - Log warning and continue

4. **Rate limiting / abuse prevention?**
   - Consider limiting session creation rate per user
   - Could add config option: `OPENCODE_MM_AUTO_CREATE_SESSION=true/false`

### Configuration

Add new environment variable:

```bash
# Enable/disable auto-creating sessions from main DM (default: true)
export OPENCODE_MM_AUTO_CREATE_SESSION="true"
```

### Testing Strategy

1. **No sessions exist**: Send prompt in main DM → New session created → Thread created → Response streams
2. **Sessions exist**: Send prompt in main DM → Routes to most recent session
3. **Session creation fails**: Appropriate error message shown
4. **Disabled via config**: Falls back to current rejection behavior

---

## Summary of Changes

| File | Change |
|------|--------|
| `.opencode/plugin/mattermost-control/index.ts` | Add reply context to prompt, handle main DM prompts |
| `src/config.ts` | Add `autoCreateSession` config option |
| `src/message-router.ts` | (No changes - routing logic stays the same) |
| `README.md` | Document new behavior |

## Open Questions

1. **Q**: Should we include the Mattermost server URL in the reply context?
   **A**: Probably not needed - agents with Mattermost tools will have their own connection configured.

2. **Q**: Should new sessions inherit any permissions from a "default" config?
   **A**: Use default OpenCode session permissions.

3. **Q**: What if multiple users try to create sessions simultaneously?
   **A**: Each gets their own session - existing behavior handles this.

---

## Next Steps

After design approval:
1. Implement Feature 1 (Reply Context) - smaller, lower risk
2. Test Feature 1 thoroughly
3. Implement Feature 2 (New Session Creation)
4. Test Feature 2
5. Update documentation
6. Publish new version
