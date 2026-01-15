# Data Model: Thread-Per-Session

**Feature**: 001-thread-per-session  
**Date**: 2026-01-15  
**Status**: Complete

## 1. Core Entities

### 1.1 ThreadSessionMapping

The primary entity that links an OpenCode session to a Mattermost thread.

```typescript
/**
 * Maps an OpenCode session to its dedicated Mattermost thread.
 * Persisted to disk for crash recovery.
 */
interface ThreadSessionMapping {
  // === Identity ===
  
  /** OpenCode session ID (e.g., "ses_a1b2c3d4e5f6...") */
  sessionId: string;
  
  /** Mattermost post ID of the thread root post */
  threadRootPostId: string;
  
  /** Short session ID for display (first 8 chars) */
  shortId: string;
  
  // === Mattermost Context ===
  
  /** Mattermost user ID who owns this session */
  mattermostUserId: string;
  
  /** Mattermost DM channel ID */
  dmChannelId: string;
  
  // === Session Metadata ===
  
  /** Project/directory name (e.g., "business-automation") */
  projectName: string;
  
  /** Full directory path */
  directory: string;
  
  /** Optional session title from OpenCode */
  sessionTitle?: string;
  
  // === Lifecycle State ===
  
  /** Current status of the mapping */
  status: ThreadMappingStatus;
  
  /** ISO timestamp when thread was created */
  createdAt: string;
  
  /** ISO timestamp of last activity */
  lastActivityAt: string;
  
  /** ISO timestamp when session ended (if ended) */
  endedAt?: string;
}

type ThreadMappingStatus = 
  | "active"       // Session running, thread accepting prompts
  | "ended"        // Session terminated normally
  | "disconnected" // Connection lost, may reconnect
  | "orphaned";    // Session no longer exists
```

### 1.2 ThreadMappingStore

Persistence layer for thread mappings.

```typescript
/**
 * File-based storage for thread-session mappings.
 * Location: ~/.config/opencode/mattermost-threads.json
 */
interface ThreadMappingFile {
  /** Schema version for migration support */
  version: 1;
  
  /** All thread mappings */
  mappings: ThreadSessionMapping[];
  
  /** ISO timestamp of last file modification */
  lastModified: string;
}
```

### 1.3 ThreadRootPost

Content structure for the thread's root post.

```typescript
/**
 * Information displayed in the thread root post.
 */
interface ThreadRootPostContent {
  projectName: string;
  directory: string;
  sessionId: string;
  shortId: string;
  startedAt: Date;
  sessionTitle?: string;
}

// Rendered format:
// :rocket: **OpenCode Session Started**
//
// **Project**: ${projectName}
// **Directory**: ${directory}
// **Session**: ${shortId}
// **Started**: ${startedAt}
//
// _Reply in this thread to send prompts to this session._
```

## 2. Extended Entities

### 2.1 UserSession (Extended)

Current `UserSession` from `session-manager.ts` extended with thread awareness.

```typescript
interface UserSession {
  // === Existing Fields ===
  id: string;
  mattermostUserId: string;
  mattermostUsername: string;
  dmChannelId: string;
  createdAt: Date;
  lastActivityAt: Date;
  isProcessing: boolean;
  currentPromptPostId: string | null;
  currentResponsePostId: string | null;
  pendingPermission: PermissionRequest | null;
  lastPrompt: Post | null;
  targetOpenCodeSessionId: string | null;
  
  // === New Fields for Thread-Per-Session ===
  
  /** 
   * Currently active thread context.
   * Set when user posts in a thread.
   * Cleared when switching threads.
   */
  activeThreadRootId: string | null;
}
```

### 2.2 OpenCodeSessionInfo (Extended)

Current session info from `opencode-session-registry.ts` extended.

```typescript
interface OpenCodeSessionInfo {
  // === Existing Fields ===
  id: string;
  shortId: string;
  projectName: string;
  directory: string;
  isAvailable: boolean;
  lastUpdated: Date;
  
  // === New Fields ===
  
  /** Whether this session has an associated thread */
  hasThread: boolean;
  
  /** Thread root post ID if thread exists */
  threadRootPostId?: string;
}
```

## 3. Message Types

### 3.1 Inbound Message Classification

```typescript
type InboundMessageType =
  | "thread_prompt"     // Message in a session thread → route to session
  | "main_dm_command"   // Command in main DM (!sessions, !help)
  | "main_dm_prompt"    // Prompt in main DM → reject with guidance
  | "unknown_thread";   // Message in unrecognized thread

interface InboundMessageResult {
  type: InboundMessageType;
  
  /** For thread_prompt: the target session ID */
  sessionId?: string;
  
  /** For main_dm_command: parsed command */
  command?: ParsedCommand;
  
  /** For main_dm_prompt/unknown_thread: error message */
  errorMessage?: string;
}
```

### 3.2 Thread Message

Messages posted to a thread include root_id.

```typescript
interface ThreadMessage {
  /** Channel ID (DM channel) */
  channelId: string;
  
  /** Message content */
  message: string;
  
  /** Thread root post ID (required for thread replies) */
  rootId: string;
  
  /** Optional file attachments */
  fileIds?: string[];
}
```

## 4. State Transitions

### 4.1 ThreadMappingStatus Transitions

```
                    ┌─────────────┐
                    │   (none)    │
                    └──────┬──────┘
                           │ create thread
                           ▼
                    ┌─────────────┐
         ┌─────────│   active    │─────────┐
         │         └──────┬──────┘         │
         │                │                │
    connection       session end      session crash
      lost                │              (poll)
         │                │                │
         ▼                ▼                ▼
  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
  │disconnected │  │   ended     │  │  orphaned   │
  └──────┬──────┘  └─────────────┘  └─────────────┘
         │                              
    reconnect                          
         │                              
         ▼                              
  ┌─────────────┐                       
  │   active    │                       
  └─────────────┘                       
```

### 4.2 Valid Transitions

| From | To | Trigger |
|------|-----|---------|
| (none) | active | New session detected, thread created |
| active | ended | Session terminated normally |
| active | disconnected | WebSocket disconnect or plugin unload |
| active | orphaned | Session not found in session.list() |
| disconnected | active | Reconnect and find session still exists |
| disconnected | orphaned | Reconnect but session no longer exists |

## 5. Indexes & Lookups

### 5.1 Required Lookups

```typescript
interface ThreadMappingLookups {
  /** Find mapping by OpenCode session ID */
  bySessionId: Map<string, ThreadSessionMapping>;
  
  /** Find mapping by thread root post ID */
  byThreadRootPostId: Map<string, ThreadSessionMapping>;
  
  /** Find all active mappings for a Mattermost user */
  byMattermostUserId: Map<string, ThreadSessionMapping[]>;
}
```

### 5.2 Index Maintenance

- Rebuild indexes on:
  - Plugin initialization (load from file)
  - Mapping creation
  - Mapping status change
  - Mapping deletion

## 6. Validation Rules

### 6.1 ThreadSessionMapping Validation

```typescript
const ThreadSessionMappingSchema = z.object({
  sessionId: z.string().min(1),
  threadRootPostId: z.string().min(1),
  shortId: z.string().length(8),
  mattermostUserId: z.string().min(1),
  dmChannelId: z.string().min(1),
  projectName: z.string().min(1),
  directory: z.string().min(1),
  sessionTitle: z.string().optional(),
  status: z.enum(["active", "ended", "disconnected", "orphaned"]),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
});
```

### 6.2 Business Rules

1. **Uniqueness**: One thread per session (sessionId is unique key)
2. **Ownership**: Mapping belongs to one Mattermost user
3. **Immutability**: threadRootPostId never changes after creation
4. **Status Consistency**: endedAt only set when status is "ended"

## 7. File Format Example

```json
{
  "version": 1,
  "mappings": [
    {
      "sessionId": "ses_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      "threadRootPostId": "post_x1y2z3a4b5c6d7e8",
      "shortId": "ses_a1b2",
      "mattermostUserId": "user_abc123",
      "dmChannelId": "channel_def456",
      "projectName": "business-automation",
      "directory": "/root/gitrepos/business-automation",
      "sessionTitle": "Fix email pipeline",
      "status": "active",
      "createdAt": "2026-01-15T14:30:00.000Z",
      "lastActivityAt": "2026-01-15T14:45:00.000Z"
    },
    {
      "sessionId": "ses_q9w8e7r6t5y4u3i2o1p0a9s8d7f6",
      "threadRootPostId": "post_m1n2o3p4q5r6s7t8",
      "shortId": "ses_q9w8",
      "mattermostUserId": "user_abc123",
      "dmChannelId": "channel_def456",
      "projectName": "opencode-plugin",
      "directory": "/root/gitrepos/opencode-mattermost-plugin-public",
      "status": "ended",
      "createdAt": "2026-01-15T10:00:00.000Z",
      "lastActivityAt": "2026-01-15T12:30:00.000Z",
      "endedAt": "2026-01-15T12:30:00.000Z"
    }
  ],
  "lastModified": "2026-01-15T14:45:00.000Z"
}
```
