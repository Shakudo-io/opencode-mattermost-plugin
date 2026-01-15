# Research: Thread-Per-Session Architecture

**Feature**: 001-thread-per-session  
**Date**: 2026-01-15  
**Status**: Complete

## 1. Mattermost Threading API

### 1.1 Thread Creation Pattern

Threads in Mattermost are created by posting with a `root_id` parameter. The first post without a `root_id` becomes the thread root; all subsequent posts with that post's ID as `root_id` become replies in the thread.

```typescript
// Create thread root post (no root_id)
const rootPost = await mmClient.createPost(channelId, sessionInfoMessage);
// rootPost.id becomes the thread's anchor

// Reply in thread (with root_id)
await mmClient.createPost(channelId, replyMessage, rootPost.id);
```

**Existing Implementation** (`mattermost-client.ts` line 101-118):
```typescript
async createPost(channelId: string, message: string, rootId?: string, fileIds?: string[]): Promise<Post> {
  const payload: any = {
    channel_id: channelId,
    message,
  };
  if (rootId) payload.root_id = rootId;
  if (fileIds) payload.file_ids = fileIds;
  // ...
}
```

**Finding**: API already supports threading. No client changes needed.

### 1.2 WebSocket Events for Thread Messages

When a message is posted in a thread, the WebSocket `posted` event includes:
- `root_id`: The ID of the thread's root post (empty string if not in a thread)
- `parent_id`: Same as `root_id` for thread replies

**Current Implementation** (`index.ts` line 249-267):
```typescript
wsClient!.on("posted", async (event: WebSocketEvent) => {
  const postData = typeof event.data.post === "string" 
    ? JSON.parse(event.data.post) 
    : event.data.post;
  // postData.root_id available but not currently used
  await handleUserMessage(postData);
});
```

**Finding**: `root_id` available in events but not utilized. Need to add routing logic.

### 1.3 Thread Retrieval

```typescript
// Get all posts in a thread
async getPostThread(postId: string): Promise<PostList>
```

**Finding**: Already implemented. Useful for debugging/recovery.

## 2. OpenCode Plugin Lifecycle

### 2.1 Session Events

The plugin receives session lifecycle events via the `event` handler:

```typescript
event: async ({ event }) => {
  const eventType = event.type as string;
  const eventSessionId = (event as any).properties?.sessionID;
  
  // Available events:
  // - "session.idle" - session waiting for input
  // - "permission.asked" - permission request pending
  // - "message.part.updated" - streaming response
  // - "file.edited" - file was modified
}
```

**Missing Event**: No `session.started` event available in current OpenCode plugin SDK.

### 2.2 Session Discovery

**Current Implementation** (`opencode-session-registry.ts`):
- `client.session.list()` - Get all sessions
- `client.session.status()` - Get active sessions with status
- `client.session.get({ path: { id } })` - Get session details

**Finding**: Can poll for new sessions, but no push notification for session creation.

### 2.3 Proposed Auto-Connect Strategy

Since there's no `session.started` event, we have two options:

**Option A: Polling-based Detection** (Selected)
- On plugin load, record known session IDs
- Poll `client.session.list()` periodically (every 5-10 seconds)
- On new session detected → create thread automatically
- Pros: Works with current SDK, reliable
- Cons: Slight delay (up to poll interval)

**Option B: Session Registration at Connect**
- When user runs `mattermost_connect`, create thread for current session
- New sessions without threads get prompted to connect
- Pros: Explicit user control
- Cons: Not fully automatic as spec requires

**Decision**: Option A - Polling. Modify `OpenCodeSessionRegistry` to emit events on new session detection.

## 3. Persistence Strategy

### 3.1 File Location

Following XDG conventions used by OpenCode:
- Primary: `~/.config/opencode/mattermost-threads.json`
- Fallback: `~/.opencode/mattermost-threads.json`

### 3.2 File Format

```typescript
interface ThreadMappingFile {
  version: 1;
  mappings: ThreadSessionMapping[];
}

interface ThreadSessionMapping {
  // Identity
  sessionId: string;           // OpenCode session ID
  threadRootPostId: string;    // Mattermost thread root post ID
  
  // Context
  mattermostUserId: string;    // User who owns this mapping
  dmChannelId: string;         // DM channel ID
  
  // Metadata
  projectName: string;         // e.g., "business-automation"
  directory: string;           // e.g., "/root/gitrepos/business-automation"
  sessionTitle?: string;       // Optional session title
  
  // State
  status: "active" | "ended" | "disconnected";
  createdAt: string;           // ISO timestamp
  lastActivityAt: string;      // ISO timestamp
  endedAt?: string;            // ISO timestamp if ended
}
```

### 3.3 Persistence Operations

```typescript
// Load on plugin init
function loadMappings(): ThreadSessionMapping[];

// Save on any change (debounced)
function saveMappings(mappings: ThreadSessionMapping[]): void;

// Query operations
function getMappingBySession(sessionId: string): ThreadSessionMapping | null;
function getMappingByThread(rootPostId: string): ThreadSessionMapping | null;
function getActiveMappingsForUser(userId: string): ThreadSessionMapping[];
```

### 3.4 Concurrency Considerations

- Multiple OpenCode instances may run simultaneously
- File locking not needed - each session has unique ID
- On load, merge with existing file (don't overwrite)
- Use atomic write (write to temp, then rename)

## 4. Message Routing Architecture

### 4.1 Inbound Message Flow (Mattermost → OpenCode)

```
User posts in thread
  ↓
WebSocket "posted" event received
  ↓
Extract root_id from post
  ↓
If no root_id (main DM):
  → Check if command (!sessions, !help)
  → If command: execute and reply
  → If prompt: reject with guidance message
  ↓
If has root_id (thread message):
  → Lookup mapping by threadRootPostId
  → If no mapping: "Thread not associated with active session"
  → If mapping.status != "active": "Session ended, start new one"
  → Route to mapped sessionId
```

### 4.2 Outbound Message Flow (OpenCode → Mattermost)

```
OpenCode emits event (message.part.updated, session.idle, etc.)
  ↓
Extract sessionId from event
  ↓
Lookup mapping by sessionId
  ↓
If no mapping: skip (session not connected to Mattermost)
  ↓
Post to thread using mapping.threadRootPostId as root_id
```

### 4.3 Thread Root Post Content

```markdown
:rocket: **OpenCode Session Started**

**Project**: business-automation
**Directory**: /root/gitrepos/business-automation
**Session**: ses_a1b2c3
**Started**: 2026-01-15 14:30:00 UTC

_Reply in this thread to send prompts to this session._
```

### 4.4 Session End Post Content

```markdown
:checkered_flag: **Session Ended**

**Duration**: 45 minutes
**Ended**: 2026-01-15 15:15:00 UTC

_This thread is now read-only. Start a new session for a new thread._
```

## 5. Integration Points Summary

| Component | Change Required |
|-----------|-----------------|
| `mattermost-client.ts` | None - already supports `root_id` |
| `websocket-client.ts` | None - events include `root_id` |
| `session-manager.ts` | Extend to track thread mappings |
| `message-router.ts` | Major rewrite for thread-aware routing |
| `command-handler.ts` | Modify to reject prompts in main DM |
| `response-streamer.ts` | Accept threadRootPostId parameter |
| `index.ts` | Hook session detection, auto-connect |
| NEW: `thread-manager.ts` | Thread lifecycle (create, end, reconnect) |
| NEW: `persistence/thread-mapping-store.ts` | File-based persistence |

## 6. Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| How to detect new sessions? | Polling with `session.list()` |
| Persist in memory or file? | File (crash recovery required) |
| Main DM behavior? | Commands only, reject prompts |
| Thread reuse on restart? | Yes, via persisted mappings |

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Polling delay for new sessions | 5-second interval is acceptable UX |
| File corruption | Atomic writes, version field for migration |
| Orphaned threads (session deleted) | Status field, cleanup on session list refresh |
| Rate limiting by Mattermost | Existing buffering in ResponseStreamer |
