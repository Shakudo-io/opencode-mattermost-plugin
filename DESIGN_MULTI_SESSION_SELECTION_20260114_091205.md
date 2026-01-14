# Design Proposal: Multi-Session Selection for OpenCode Mattermost Plugin

**Created**: 2026-01-14  
**Status**: Draft  
**Author**: AI Agent  

---

## Problem Statement

Currently, the plugin binds to a **single OpenCode session** on connect (`connectedOpenCodeSessionId`). When multiple OpenCode instances are running, users cannot:
1. See available sessions
2. Choose which session to target
3. Switch between sessions

## Goals

1. **List** available OpenCode sessions with meaningful identifiers
2. **Select** which session receives DM prompts
3. **Per-user targeting** - different MM users can target different sessions
4. **Graceful handling** when selected session becomes unavailable

## Non-Goals

- Running prompts across multiple sessions simultaneously
- Session load balancing
- Automatic session failover

---

## Proposed Solution

### 1. Data Model Changes

#### New: `OpenCodeSessionInfo`

```typescript
interface OpenCodeSessionInfo {
  id: string;                    // OpenCode session ID
  projectName: string;           // e.g., "business-automation"
  directory: string;             // e.g., "/root/gitrepos/business-automation"
  shortId: string;               // First 6 chars of ID for easy reference
  lastUpdated: Date;
  isAvailable: boolean;          // Can we still reach this session?
}
```

#### Modified: `UserSession` (Mattermost user → OpenCode session binding)

```typescript
interface UserSession {
  // ... existing fields ...
  
  // NEW: Which OpenCode session this MM user is targeting
  targetOpenCodeSessionId: string | null;
}
```

#### New: `OpenCodeSessionRegistry`

```typescript
class OpenCodeSessionRegistry {
  private sessions: Map<string, OpenCodeSessionInfo>;
  private defaultSessionId: string | null;
  
  // Refresh list from OpenCode API
  async refresh(client: SDKClient): Promise<void>;
  
  // Get all available sessions
  list(): OpenCodeSessionInfo[];
  
  // Get session by ID or shortId
  get(idOrShortId: string): OpenCodeSessionInfo | null;
  
  // Set default session (used when user has no explicit selection)
  setDefault(sessionId: string): void;
  
  // Mark session as unavailable
  markUnavailable(sessionId: string): void;
}
```

---

### 2. User Interaction Design

#### Option A: Message Commands (Recommended)

Users type special commands in DM:

| Command | Action |
|---------|--------|
| `!sessions` | List available OpenCode sessions |
| `!use <id>` | Select session by ID or shortId |
| `!current` | Show currently selected session |

**Example Flow:**

```
User: !sessions

Bot: 📋 **Available OpenCode Sessions:**

| # | Project | Directory | ID |
|---|---------|-----------|-----|
| 1 | business-automation | /root/gitrepos/business-automation | `abc123` ✅ (current) |
| 2 | demos-main | /root/gitrepos/demos-main | `def456` |
| 3 | mcp-servers | /root/gitrepos/mcp-servers | `ghi789` |

Reply `!use <id>` to switch sessions (e.g., `!use def456`)

User: !use def456

Bot: ✓ Now targeting session `def456` (demos-main)
     All your prompts will go to this session.

User: Fix the login bug

Bot: [Response from demos-main session...]
```

#### Option B: Reaction-Based Selection

Bot posts numbered list, user reacts with number emoji (1️⃣, 2️⃣, 3️⃣...).

**Pros**: More visual, no typing
**Cons**: Limited to ~10 sessions, reaction handling complexity

#### Option C: Mattermost Interactive Buttons

Use Mattermost's interactive message attachments with buttons.

**Pros**: Clean UI, native feel
**Cons**: Requires webhook setup, more complex implementation

**Recommendation**: Start with **Option A** (message commands) - simplest to implement, works universally, easy to extend.

---

### 3. Architecture Changes

```
┌─────────────────────────────────────────────────────────────────┐
│                    Plugin Entry Point                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  MessageRouter (NEW)                         ││
│  │  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐  ││
│  │  │ Command       │  │ Prompt        │  │ OpenCodeSession ││  ││
│  │  │ Handler       │  │ Handler       │  │ Registry (NEW)  ││  ││
│  │  │ (!sessions,   │  │ (forwards to  │  │ (tracks all     ││  ││
│  │  │  !use, etc)   │  │  selected     │  │  available      ││  ││
│  │  │               │  │  session)     │  │  sessions)      ││  ││
│  │  └───────────────┘  └───────────────┘  └─────────────────┘  ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│  ┌───────────────────────────┼───────────────────────────────┐  │
│  │              SessionManager (Modified)                     │  │
│  │  UserSession now includes:                                 │  │
│  │  - targetOpenCodeSessionId (per-user selection)            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4. Message Flow

```
User DMs bot: "Fix the login bug"
        │
        ▼
┌─────────────────────────────┐
│ MessageRouter.route(post)   │
│ Is it a command (!sessions)?│
└─────────────────────────────┘
        │
   ┌────┴────┐
   │         │
   ▼         ▼
Command    Prompt
   │         │
   ▼         ▼
Handle   ┌─────────────────────────────┐
locally  │ Get user's targetSessionId  │
         │ from UserSession            │
         └─────────────────────────────┘
                    │
         ┌─────────┴─────────┐
         │                   │
         ▼                   ▼
    Has target          No target
         │                   │
         ▼                   ▼
    Use that          Use default session
    session           (or prompt to select)
         │                   │
         └─────────┬─────────┘
                   ▼
         ┌─────────────────────────────┐
         │ OpenCodeSessionRegistry     │
         │ .get(targetSessionId)       │
         │ → Verify still available    │
         └─────────────────────────────┘
                   │
         ┌────────┴────────┐
         │                 │
         ▼                 ▼
    Available         Unavailable
         │                 │
         ▼                 ▼
    Forward to        Notify user:
    that session      "Session disconnected"
                      Offer alternatives
```

---

### 5. New Tools

| Tool | Purpose |
|------|---------|
| `mattermost_list_sessions` | List all available OpenCode sessions |
| `mattermost_select_session` | Select which session to target |
| `mattermost_current_session` | Show currently selected session |

These tools allow programmatic session management in addition to DM commands.

---

### 6. Session Refresh Strategy

**When to refresh session list:**
1. On `mattermost_connect` (initial load)
2. On `!sessions` command
3. Every 60 seconds (background poll)
4. When a prompt fails with "session not found"

**Handling session disappearance:**
```
If user's targetSessionId becomes unavailable:
  1. Notify user: "⚠️ Session `abc123` (project-name) is no longer available"
  2. List remaining sessions
  3. If only one session remains → auto-switch and notify
  4. If multiple remain → prompt user to select
  5. If none remain → notify "No active OpenCode sessions"
```

---

### 7. Configuration Additions

```bash
# Session selection behavior
export OPENCODE_MM_AUTO_SELECT="true"           # Auto-select if only one session
export OPENCODE_MM_SESSION_REFRESH_INTERVAL="60000"  # ms between refreshes
export OPENCODE_MM_COMMAND_PREFIX="!"           # Prefix for commands (!, /, etc.)
```

---

### 8. Message Formats

#### Session List
```markdown
📋 **Available OpenCode Sessions:**

| # | Project | Directory | ID |
|---|---------|-----------|-----|
| 1 | business-automation | `.../business-automation` | `abc123` ✅ |
| 2 | demos-main | `.../demos-main` | `def456` |

✅ = your current target

**Commands:**
• `!use <id>` - switch to a session
• `!current` - show current session
```

#### Session Selected
```markdown
✓ **Session Changed**

Now targeting: **demos-main** (`def456`)
Directory: `/root/gitrepos/demos-main`

All your prompts will go to this session.
```

#### Session Unavailable
```markdown
⚠️ **Session Unavailable**

Session `abc123` (business-automation) is no longer connected.

**Available sessions:**
1. `def456` - demos-main
2. `ghi789` - mcp-servers

Reply `!use <id>` to select a new session.
```

---

### 9. File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/models/index.ts` | Add | `OpenCodeSessionInfo` interface |
| `src/opencode-session-registry.ts` | **New** | Registry for tracking OpenCode sessions |
| `src/message-router.ts` | **New** | Routes messages to commands vs prompts |
| `src/command-handler.ts` | **New** | Handles `!sessions`, `!use`, `!current` |
| `src/session-manager.ts` | Modify | Add `targetOpenCodeSessionId` to `UserSession` |
| `.opencode/plugin/.../index.ts` | Modify | Integrate new components, add tools |
| `src/config.ts` | Modify | Add session selection config options |

---

### 10. Migration / Backward Compatibility

- **Default behavior unchanged**: If only one session exists, auto-select it
- **Existing users**: First message after upgrade shows session list if multiple available
- **No breaking changes**: All existing functionality preserved

---

## Open Questions

1. **Should different MM users share session selection or be independent?**
   - Proposed: Independent (per-user targeting)
   - Alternative: Global (one active session for all users)

2. **What if a user never explicitly selects a session?**
   - Proposed: Use most recently updated session (current behavior)
   - Alternative: Require explicit selection

3. **Should we support session "nicknames" for easier selection?**
   - e.g., `!use frontend` instead of `!use abc123`

---

## Implementation Order

1. `OpenCodeSessionRegistry` - core tracking
2. `UserSession.targetOpenCodeSessionId` - per-user binding
3. `MessageRouter` + `CommandHandler` - command parsing
4. Message formats and notifications
5. New tools (`mattermost_list_sessions`, etc.)
6. Background refresh and availability monitoring
7. Documentation and tests

---

## Appendix: Current Implementation Reference

### Current Session Binding (index.ts)

```typescript
// Current: Single global session ID
let connectedOpenCodeSessionId: string | null = null;

// On connect, auto-binds to most recent session
const sessionsResult = await client.session.list();
const sessions = sessionsResult.data;
if (sessions && sessions.length > 0) {
  const sortedSessions = sessions.sort((a, b) => b.time.updated - a.time.updated);
  connectedOpenCodeSessionId = sortedSessions[0].id;
}
```

### Current UserSession (session-manager.ts)

```typescript
export interface UserSession {
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
  // NOTE: No targetOpenCodeSessionId field currently
}
```
