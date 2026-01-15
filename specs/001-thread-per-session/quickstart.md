# Quickstart: Thread-Per-Session

**Feature**: 001-thread-per-session  
**Date**: 2026-01-15

## TL;DR

Every OpenCode session gets its own Mattermost thread automatically. Control multiple sessions in parallel via separate threads.

## Key Changes from Current Behavior

| Before | After |
|--------|-------|
| Manual `/mattermost-connect` required | Automatic on session start |
| One session at a time | Multiple sessions in parallel |
| Commands and prompts in main DM | Commands in main DM, prompts in threads |
| No crash recovery | Thread mappings persist across restarts |

## User Workflow

### 1. Start OpenCode Session
```bash
cd /path/to/project
opencode
```
→ Thread automatically created in your Mattermost DM

### 2. Send Prompts via Thread
Find the new thread in your DM and reply to send prompts:
```
You (in thread): Create a function to parse JSON files
Bot (in thread): [response streams here]
```

### 3. Manage Multiple Sessions
Start another session in different terminal:
```bash
cd /path/to/other-project  
opencode
```
→ New thread created automatically

### 4. Use Commands in Main DM
```
You (main DM): !sessions
Bot: 📋 Active Sessions (2)
     • business-automation (ses_a1b2) - Thread: [link]
     • other-project (ses_c3d4) - Thread: [link]
```

## Available Commands (Main DM Only)

| Command | Description |
|---------|-------------|
| `!sessions` | List active session threads |
| `!help` | Show available commands |
| `!status` | Plugin status |

## Thread Lifecycle

```
Session Start → Thread Created (active)
     ↓
[User sends prompts in thread]
     ↓
Session End → Thread Updated (ended, read-only)
```

## Error Messages

**"Prompts not accepted in main DM"**  
→ You tried to send a prompt in the main DM. Reply in a session thread instead.

**"Thread not recognized"**  
→ This thread isn't linked to any session. Use `!sessions` to find active threads.

**"Session ended"**  
→ This session has terminated. Start a new OpenCode session for a new thread.

## Files

| File | Purpose |
|------|---------|
| `~/.config/opencode/mattermost-threads.json` | Persisted thread-session mappings |

## Quick Reference: Message Flow

```
Main DM                    Session Threads
─────────────────────────  ─────────────────────────────────
!sessions                  Thread 1: business-automation
!help                      └─ Your prompt
!status                    └─ Bot response
                           └─ Your prompt
[prompts rejected]         └─ Bot response
                           
                           Thread 2: other-project
                           └─ Your prompt
                           └─ Bot response
```

## Implementation Files

### New Files
- `src/thread-manager.ts` - Thread lifecycle
- `src/persistence/thread-mapping-store.ts` - File persistence

### Modified Files
- `src/message-router.ts` - Thread-aware routing
- `src/session-manager.ts` - Extended with thread tracking
- `src/command-handler.ts` - Reject prompts in main DM
- `src/response-streamer.ts` - Post to correct thread
- `.opencode/plugin/mattermost-control/index.ts` - Auto-connect logic

## Key Types

```typescript
// Thread-session link
interface ThreadSessionMapping {
  sessionId: string;        // OpenCode session
  threadRootPostId: string; // Mattermost thread
  status: "active" | "ended" | "disconnected" | "orphaned";
}

// Routing decision
type InboundRouteResult =
  | { type: "thread_prompt"; sessionId: string; }
  | { type: "main_dm_command"; command: ParsedCommand; }
  | { type: "main_dm_prompt"; errorMessage: string; }
  | { type: "ended_session"; errorMessage: string; };
```
