# Investigation Report: Multi-Session Selection Design Verification

**Date**: 2026-01-14  
**Status**: VERIFIED - Design is compatible with OpenCode architecture

---

## Executive Summary

The proposed multi-session selection design **IS VALID** and compatible with the OpenCode plugin architecture. The SDK provides all necessary APIs to:
1. List available sessions with metadata
2. Target specific sessions by ID
3. Subscribe to session lifecycle events

---

## Sources Investigated

| Source | Location | Key Findings |
|--------|----------|--------------|
| OpenCode Plugin Docs | https://opencode.ai/docs/plugins/ | Plugin API, hooks, event types |
| OpenCode SDK Docs | https://opencode.ai/docs/sdk/ | Session APIs, client methods |
| OpenCode Source | `/tmp/opencode-repo` (github.com/sst/opencode) | Types, SDK implementation |
| Plugin Package | `@opencode-ai/plugin` v1.1.19 | Plugin interface, hooks |
| Current MM Plugin | `opencode-mattermost-plugin-public/` | Working implementation |

---

## Key API Findings

### 1. Session Type (SDK)

```typescript
// From packages/sdk/js/src/gen/types.gen.ts
export type Session = {
  id: string              // Unique session ID
  projectID: string       // Project identifier  
  directory: string       // Working directory path (e.g., "/root/gitrepos/business-automation")
  title: string           // Session title
  version: string
  time: {
    created: number       // Unix timestamp
    updated: number       // Unix timestamp
    compacting?: number
  }
  parentID?: string       // For forked sessions
  summary?: {             // Git summary
    additions: number
    deletions: number
    files: number
    diffs?: Array<FileDiff>
  }
  share?: { url: string } // If shared
  revert?: {...}          // Revert state
}
```

**Implication**: We have `id`, `directory`, and `title` - exactly what we need for session identification.

### 2. Session SDK Methods

```typescript
// From packages/sdk/js/src/gen/sdk.gen.ts
class Session {
  // List ALL sessions - returns Session[]
  public list<ThrowOnError extends boolean = false>(
    options?: Options<SessionListData, ThrowOnError>
  )

  // Get specific session by ID
  public get<ThrowOnError extends boolean = false>(
    options: Options<SessionGetData, ThrowOnError>  // path.id required
  )

  // Send prompt to specific session (async, returns immediately)
  public promptAsync<ThrowOnError extends boolean = false>(
    options: Options<SessionPromptAsyncData, ThrowOnError>
    // path.id = session ID
    // body.parts = message parts
  )

  // Send prompt and wait for response
  public prompt<ThrowOnError extends boolean = false>(
    options: Options<SessionPromptData, ThrowOnError>
  )
}
```

**Implication**: `session.list()` returns all sessions, `session.promptAsync()` accepts any session ID.

### 3. Plugin API

```typescript
// From packages/plugin/src/index.ts
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>  // SDK client
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
}

export type Plugin = (input: PluginInput) => Promise<Hooks>

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>  // Event subscription
  tool?: { [key: string]: ToolDefinition }            // Custom tools
  // ... other hooks
}
```

**Implication**: Plugin receives `client` which has full SDK access including `session.list()`.

### 4. Available Session Events

From the docs and source:

| Event Type | Properties | When Fired |
|------------|------------|------------|
| `session.created` | `{ info: Session }` | New session created |
| `session.updated` | `{ info: Session }` | Session properties changed |
| `session.deleted` | `{ info: Session }` | Session deleted |
| `session.idle` | `{ sessionID: string }` | Session finished processing |
| `session.status` | `{ sessionID, status }` | Status change |
| `session.compacted` | `{ sessionID }` | Session compacted |
| `session.error` | `{ sessionID?, error }` | Error occurred |

**Implication**: We can subscribe to `session.created`/`session.deleted` to keep registry updated.

---

## Current Plugin Implementation Analysis

```typescript
// Current: Single global session binding
let connectedOpenCodeSessionId: string | null = null;

// On connect - auto-binds to most recent
const sessionsResult = await client.session.list();
const sessions = sessionsResult.data;
if (sessions && sessions.length > 0) {
  const sortedSessions = sessions.sort((a, b) => b.time.updated - a.time.updated);
  connectedOpenCodeSessionId = sortedSessions[0].id;  // SINGLE session
}

// On prompt - uses the bound session
await client.session.promptAsync({
  path: { id: connectedOpenCodeSessionId },  // Fixed ID
  body: { parts: [...] },
});
```

**Limitation**: Can only target ONE session, selected automatically.

---

## Design Verification

### ✅ Requirement 1: List Available Sessions

**API**: `client.session.list()`  
**Returns**: `Session[]` with `id`, `directory`, `title`, `time.updated`  
**Status**: SUPPORTED

### ✅ Requirement 2: Target Specific Session

**API**: `client.session.promptAsync({ path: { id: sessionId }, body: {...} })`  
**Status**: SUPPORTED - session ID is a parameter, not hardcoded

### ✅ Requirement 3: Session Lifecycle Events

**API**: `event` hook in plugin  
**Events**: `session.created`, `session.deleted`, `session.updated`  
**Status**: SUPPORTED

### ✅ Requirement 4: Per-User Session Binding

**Approach**: Store `targetOpenCodeSessionId` in `UserSession` (Mattermost user session)  
**Status**: SUPPORTED - purely plugin-side state management

---

## Implementation Considerations

### 1. Project Name Derivation

The `Session.directory` field contains the full path. To derive a project name:

```typescript
function getProjectName(session: Session): string {
  // Option 1: Use title if set
  if (session.title) return session.title;
  
  // Option 2: Extract from directory
  // "/root/gitrepos/business-automation" → "business-automation"
  return session.directory.split('/').pop() || session.id.slice(0, 6);
}
```

### 2. Short ID for User Convenience

```typescript
function getShortId(sessionId: string): string {
  return sessionId.slice(0, 6);  // First 6 chars
}
```

### 3. Session Refresh Strategy

```typescript
// Refresh on these triggers:
// 1. On connect
// 2. On !sessions command
// 3. On session.created/session.deleted events
// 4. Periodic background refresh (optional)

event: async ({ event }) => {
  if (event.type === "session.created" || event.type === "session.deleted") {
    await sessionRegistry.refresh(client);
  }
}
```

### 4. Handling Session Unavailability

```typescript
// Before sending prompt, verify session still exists
async function sendPrompt(targetSessionId: string, message: string) {
  const sessions = await client.session.list();
  const targetExists = sessions.data?.some(s => s.id === targetSessionId);
  
  if (!targetExists) {
    // Session no longer available
    throw new SessionUnavailableError(targetSessionId);
  }
  
  await client.session.promptAsync({
    path: { id: targetSessionId },
    body: { parts: [{ type: "text", text: message }] }
  });
}
```

---

## Potential Issues

### Issue 1: Session ID Uniqueness

**Concern**: Are session IDs globally unique or per-project?  
**Finding**: IDs appear to be UUIDs, globally unique.  
**Mitigation**: Use short IDs (6 chars) for display, full IDs internally.

### Issue 2: Event Subscription Reliability

**Concern**: Will we receive all session lifecycle events?  
**Finding**: Events are delivered via SSE stream (`client.event.subscribe()`).  
**Mitigation**: Periodic refresh as backup; don't rely solely on events.

### Issue 3: Race Conditions

**Concern**: User selects session that gets deleted mid-prompt.  
**Finding**: `promptAsync` will fail with error.  
**Mitigation**: Handle errors gracefully, offer alternative sessions.

### Issue 4: Multiple OpenCode Servers

**Concern**: What if multiple OpenCode servers are running?  
**Finding**: Each plugin instance connects to ONE server (the one that loaded it).  
**Mitigation**: Not an issue - plugin is scoped to its OpenCode instance.

---

## Recommended Design Adjustments

Based on this investigation, I recommend the following adjustments to the original design:

### 1. Add Event-Based Registry Updates

```typescript
// In plugin event hook
event: async ({ event }) => {
  if (!isConnected) return;
  
  // Update registry on session changes
  if (event.type === "session.created") {
    sessionRegistry.add(event.properties.info);
  } else if (event.type === "session.deleted") {
    sessionRegistry.remove(event.properties.info.id);
  }
  
  // Existing event handling...
}
```

### 2. Validate Session Before Prompt

```typescript
// Add validation step before forwarding prompt
async function handleUserMessage(post: Post): Promise<void> {
  const targetSessionId = getUserTargetSession(post.user_id);
  
  // Validate session still exists
  if (!sessionRegistry.isAvailable(targetSessionId)) {
    await notifySessionUnavailable(post.user_id, targetSessionId);
    return;
  }
  
  // Proceed with prompt...
}
```

### 3. Use Title When Available

```typescript
// Prefer session.title over derived name
function formatSessionForDisplay(session: Session): string {
  const name = session.title || session.directory.split('/').pop() || 'Unnamed';
  const shortId = session.id.slice(0, 6);
  return `${name} (\`${shortId}\`)`;
}
```

---

## Conclusion

**The proposed design is VALID and fully implementable.**

The OpenCode SDK and plugin architecture provide:
- ✅ Session listing API (`session.list()`)
- ✅ Targeted prompt delivery (`promptAsync` with session ID)
- ✅ Session lifecycle events for registry updates
- ✅ Full SDK access from plugin context

No changes to OpenCode core are required. The implementation is purely plugin-side.

**Recommended next step**: Proceed with implementation following the original design, incorporating the adjustments noted above.
