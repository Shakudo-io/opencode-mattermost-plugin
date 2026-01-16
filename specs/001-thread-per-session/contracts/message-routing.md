# Contract: Message Routing

**Feature**: 001-thread-per-session  
**Contract ID**: C-002  
**Date**: 2026-01-15

## Overview

Defines how inbound Mattermost messages are routed to the appropriate OpenCode session based on thread context.

## Interface

### MessageRouter.routeInbound()

```typescript
/**
 * Routes an inbound Mattermost message to the appropriate handler.
 * 
 * @param post - The Mattermost post data from WebSocket event
 * @returns Routing decision with context
 */
function routeInbound(post: Post): InboundRouteResult;
```

### Input: Post

```typescript
interface Post {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  root_id: string;      // Empty if not in thread
  file_ids?: string[];
}
```

### Output: InboundRouteResult

```typescript
type InboundRouteResult =
  | ThreadPromptRoute
  | MainDmCommandRoute
  | MainDmPromptRoute
  | UnknownThreadRoute
  | EndedSessionRoute;

interface ThreadPromptRoute {
  type: "thread_prompt";
  sessionId: string;
  threadRootPostId: string;
  promptText: string;
  fileIds?: string[];
}

interface MainDmCommandRoute {
  type: "main_dm_command";
  command: ParsedCommand;
}

interface MainDmPromptRoute {
  type: "main_dm_prompt";
  errorMessage: string;
  suggestedAction: string;
}

interface UnknownThreadRoute {
  type: "unknown_thread";
  threadRootPostId: string;
  errorMessage: string;
}

interface EndedSessionRoute {
  type: "ended_session";
  sessionId: string;
  errorMessage: string;
}
```

## Routing Logic

### Decision Tree

```
post.root_id empty?
├── YES (Main DM)
│   ├── Is command? (!sessions, !help, etc.)
│   │   ├── YES → MainDmCommandRoute
│   │   └── NO → MainDmPromptRoute (reject)
│   │
└── NO (Thread message)
    ├── Lookup mapping by root_id
    ├── Mapping found?
    │   ├── NO → UnknownThreadRoute
    │   └── YES
    │       ├── mapping.status == "active"?
    │       │   ├── YES → ThreadPromptRoute
    │       │   └── NO → EndedSessionRoute
```

### Command Detection

```typescript
const COMMAND_PREFIX = "!";
const KNOWN_COMMANDS = ["sessions", "help", "status", "use"];

function isCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return false;
  const cmd = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
  return KNOWN_COMMANDS.includes(cmd);
}
```

## Response Messages

### MainDmPromptRoute Error

```markdown
:warning: **Prompts not accepted in main DM**

To send a prompt, reply in a session thread.

Use `!sessions` to see your active session threads.
```

### UnknownThreadRoute Error

```markdown
:warning: **Thread not recognized**

This thread is not associated with an active OpenCode session.

Use `!sessions` in the main DM to see active sessions.
```

### EndedSessionRoute Error

```markdown
:warning: **Session ended**

This session has ended and is no longer accepting prompts.

Start a new OpenCode session to create a new thread.
```

## Sequence Diagram

```
WebSocket        MessageRouter        MappingStore        Handler
    │                  │                   │                  │
    │  posted event    │                   │                  │
    ├─────────────────>│                   │                  │
    │                  │                   │                  │
    │                  │ [has root_id?]    │                  │
    │                  │                   │                  │
    │                  │ YES: lookup(id)   │                  │
    │                  ├──────────────────>│                  │
    │                  │<─────────────────┤│                  │
    │                  │                   │                  │
    │                  │ [mapping found & active?]            │
    │                  │                   │                  │
    │                  │ YES: ThreadPromptRoute               │
    │                  ├─────────────────────────────────────>│
    │                  │                   │                  │
    │                  │ NO root_id: check if command         │
    │                  │                   │                  │
    │                  │ [is command?]     │                  │
    │                  │ YES: MainDmCommandRoute              │
    │                  │ NO: MainDmPromptRoute (error)        │
```

## Test Cases

### TC-001: Route thread prompt to active session

**Given**: Post with root_id matching active session mapping  
**When**: routeInbound() called  
**Then**: 
- Returns ThreadPromptRoute
- sessionId matches mapping
- promptText contains message

### TC-002: Reject prompt in main DM

**Given**: Post without root_id, not a command  
**When**: routeInbound() called  
**Then**: 
- Returns MainDmPromptRoute
- errorMessage explains rejection
- suggestedAction mentions !sessions

### TC-003: Route command in main DM

**Given**: Post without root_id, message is "!sessions"  
**When**: routeInbound() called  
**Then**: 
- Returns MainDmCommandRoute
- command.name is "sessions"

### TC-004: Unknown thread

**Given**: Post with root_id not in mapping store  
**When**: routeInbound() called  
**Then**: 
- Returns UnknownThreadRoute
- errorMessage explains thread not recognized

### TC-005: Ended session thread

**Given**: Post with root_id matching mapping with status "ended"  
**When**: routeInbound() called  
**Then**: 
- Returns EndedSessionRoute
- errorMessage explains session ended

### TC-006: Route with file attachments

**Given**: Post with root_id and file_ids  
**When**: routeInbound() called  
**Then**: 
- Returns ThreadPromptRoute
- fileIds included in result
