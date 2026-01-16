# Contract: Thread Creation

**Feature**: 001-thread-per-session  
**Contract ID**: C-001  
**Date**: 2026-01-15

## Overview

Defines the interface for creating a new Mattermost thread when an OpenCode session is detected.

## Interface

### ThreadManager.createThread()

```typescript
/**
 * Creates a new Mattermost thread for an OpenCode session.
 * 
 * @param sessionInfo - Information about the OpenCode session
 * @param mattermostUserId - The Mattermost user to create the thread for
 * @returns The created thread mapping
 * @throws Error if thread creation fails
 */
async function createThread(
  sessionInfo: OpenCodeSessionInfo,
  mattermostUserId: string
): Promise<ThreadSessionMapping>;
```

### Input: OpenCodeSessionInfo

```typescript
interface OpenCodeSessionInfo {
  id: string;           // Full session ID
  shortId: string;      // First 8 chars
  projectName: string;  // Directory name
  directory: string;    // Full path
  title?: string;       // Optional session title
}
```

### Output: ThreadSessionMapping

```typescript
interface ThreadSessionMapping {
  sessionId: string;
  threadRootPostId: string;
  shortId: string;
  mattermostUserId: string;
  dmChannelId: string;
  projectName: string;
  directory: string;
  sessionTitle?: string;
  status: "active";
  createdAt: string;
  lastActivityAt: string;
}
```

## Behavior

### Pre-conditions

1. Mattermost client is connected
2. Valid Mattermost user ID provided
3. Session does not already have a thread (check by sessionId)

### Post-conditions

1. Root post created in user's DM channel
2. Mapping persisted to disk
3. Mapping indexed for lookup
4. Returns mapping with status "active"

### Root Post Format

```markdown
:rocket: **OpenCode Session Started**

**Project**: {projectName}
**Directory**: {directory}
**Session**: {shortId}
**Started**: {createdAt formatted}

_Reply in this thread to send prompts to this session._
```

### Error Handling

| Error | Handling |
|-------|----------|
| DM channel not found | Create DM channel first |
| Post creation fails | Retry once, then throw |
| Mapping already exists | Return existing mapping |
| Persistence fails | Log error, continue with in-memory |

## Sequence Diagram

```
SessionDetector          ThreadManager          MattermostClient        MappingStore
     │                        │                       │                      │
     │  newSessionDetected    │                       │                      │
     ├───────────────────────>│                       │                      │
     │                        │                       │                      │
     │                        │  checkExisting(id)    │                      │
     │                        ├──────────────────────────────────────────────>│
     │                        │<─────────────────────────────────────────────┤
     │                        │                       │                      │
     │                        │ [if not exists]       │                      │
     │                        │  getDmChannel(user)   │                      │
     │                        ├──────────────────────>│                      │
     │                        │<─────────────────────┤│                      │
     │                        │                       │                      │
     │                        │  createPost(content)  │                      │
     │                        ├──────────────────────>│                      │
     │                        │<─────────────────────┤│                      │
     │                        │                       │                      │
     │                        │  save(mapping)        │                      │
     │                        ├──────────────────────────────────────────────>│
     │                        │<─────────────────────────────────────────────┤
     │                        │                       │                      │
     │   ThreadSessionMapping │                       │                      │
     │<──────────────────────┤│                       │                      │
```

## Test Cases

### TC-001: Create thread for new session

**Given**: Valid session info, connected Mattermost client  
**When**: createThread() called  
**Then**: 
- Root post created in DM channel
- Mapping returned with status "active"
- Mapping persisted to disk

### TC-002: Session already has thread

**Given**: Session already has a thread mapping  
**When**: createThread() called with same sessionId  
**Then**: 
- No new post created
- Existing mapping returned

### TC-003: Mattermost post fails

**Given**: Mattermost API returns error  
**When**: createThread() called  
**Then**: 
- Retry once
- If still fails, throw error with context

### TC-004: Persistence fails

**Given**: File write fails  
**When**: createThread() called  
**Then**: 
- Thread still created
- In-memory mapping maintained
- Error logged but not thrown
