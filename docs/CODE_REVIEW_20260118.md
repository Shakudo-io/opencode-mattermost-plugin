# OpenCode Mattermost Plugin - Code Review

**Version:** 0.2.50 | **Total Lines:** ~3,800 across 20 files  
**Date:** 2026-01-18

---

## Executive Summary

The plugin is well-architected with good separation of concerns, proper TypeScript typing, and solid error handling. However, the main `index.ts` has grown to ~1,534 lines and handles too many responsibilities. Below are specific recommendations organized by priority.

---

## High Priority Issues

### 1. `index.ts` God Object (~1,534 lines)

The main plugin file handles:
- Response context management (lines 38-305)
- Timer management (lines 157-217)  
- Connection lifecycle (lines 324-530)
- Event handling (lines 559-599, 1301-1530)
- Message routing (lines 601-728)
- Session creation (lines 753-805)
- Tool implementations (lines 979-1287)

**Recommendation:** Extract into focused modules:
```
src/
  response/
    context.ts           # ResponseContext type + formatters
    timer-manager.ts     # Tool and response timers
    stream-handler.ts    # updateResponseStream, formatFullResponse
  connection/
    lifecycle.ts         # handleConnect, handleDisconnect, handleStatus
    event-handlers.ts    # setupEventListeners, event processing
  prompts/
    thread-prompt.ts     # handleThreadPrompt
    session-creator.ts   # createNewSessionFromDm
```

### 2. Timer Cleanup Risk

The code has **two** timer maps (`activeToolTimers`, `activeResponseTimers`) but cleanup isn't guaranteed:
- `stopResponseTimer()` is called in `handleThreadPrompt` error path (line 965)
- But if a session disappears unexpectedly, timers may leak

**Recommendation:** Add a periodic cleanup sweep or use `WeakMap` tied to session lifecycle.

### 3. Memory Growth in `activeResponseContexts`

The `Map<string, ResponseContext>` stores response buffers that can grow large. Contexts are only deleted on `session.idle` event or explicit error.

**Risk:** If `session.idle` event is missed (network hiccup), contexts accumulate.

**Recommendation:** 
- Add max age check (e.g., contexts older than 30 minutes are cleaned)
- Add max buffer size limit with truncation

---

## Medium Priority Issues

### 4. Duplicate Format Functions

`formatElapsedTime`, `formatTokenCount`, `formatCost` (lines 89-108) could be shared utilities.

### 5. Magic Numbers Throughout

```typescript
const TOOL_UPDATE_INTERVAL_MS = 1000;      // line 87
const MAX_SHELL_OUTPUT_LINES = 15;         // line 219
500 // thinkingPreview length (line 279)
```

**Recommendation:** Move to config.ts or a constants file.

### 6. `SessionManager` Creates HTTP Calls Per Message

```typescript
async getOrCreateSession(mattermostUserId: string): Promise<UserSession> {
  // ... 
  const user = await this.mmClient.getUserById(mattermostUserId);  // API call
  const dmChannel = await this.mmClient.createDirectChannel(mattermostUserId);  // API call
```

**Recommendation:** Cache DM channel lookups since they don't change.

### 7. `OpenCodeSessionRegistry.refresh()` Lacks Rate Limiting

Called on every message (line 614-627) via `handleUserMessage`, could hit OpenCode API aggressively.

**Recommendation:** Add minimum interval between refreshes (e.g., 5 seconds).

### 8. Error Messages Not User-Friendly

```typescript
return `✗ Failed to connect: ${errorMsg}`;  // Raw error exposed
```

**Recommendation:** Sanitize/categorize errors for users.

---

## Code Quality Observations

### Good Patterns

- **Zod schemas** for thread mappings (`thread-mapping.ts`)
- **Proper shutdown cleanup** in `handleDisconnect` (lines 493-530)
- **Defensive null checks** throughout
- **Indexed persistence store** with `ThreadMappingStore`
- **Status indicator abstraction** for user feedback

### Needs Improvement

- **No unit tests** in the repo
- **JSDoc comments** missing on most public functions
- **Inconsistent logging** - some use template literals, some string concat
- **`any` type usage** in event handlers (~15 occurrences)

---

## Missing Features / Edge Cases

1. **No reconnection indicator in Mattermost**
   - When WebSocket reconnects, users don't know the bot went offline briefly

2. **No rate limiting for user messages**
   - A user spam-DMing could overwhelm the system

3. **Thread cleanup for orphaned sessions**
   - `cleanOrphaned()` marks them but doesn't notify users

4. **Model selection doesn't persist across reconnects**
   - Model is stored in thread mapping, but if plugin restarts, it's lost (file-based persistence helps, but verify it survives restarts)

5. **No health check endpoint**
   - Can't easily verify plugin is working without sending a message

---

## Refactoring Priority Order

1. **Extract response context handling** - Biggest bang for maintainability
2. **Add timer cleanup safeguards** - Prevents memory leaks
3. **Add basic test coverage** - At least for formatters and routing
4. **Consolidate magic numbers** - Quick win
5. **Add rate limiting** - Production stability

---

## Summary Table

| Area | Status | Effort |
|------|--------|--------|
| Architecture | Good, but index.ts too large | Medium |
| Type Safety | Good, some `any` usage | Low |
| Error Handling | Adequate | Low |
| Memory Management | Timer/context risks | Medium |
| Testing | None | High |
| Documentation | README excellent, code docs sparse | Medium |

---

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `.opencode/plugin/mattermost-control/index.ts` | ~1534 | Main plugin entry point |
| `src/clients/mattermost-client.ts` | 218 | HTTP API client using fetch |
| `src/clients/websocket-client.ts` | 200 | WebSocket for real-time events |
| `src/command-handler.ts` | 526 | Command parsing and execution |
| `src/response-streamer.ts` | 271 | Streaming/chunking responses |
| `src/thread-manager.ts` | 215 | Thread create/end/reconnect |
| `src/persistence/thread-mapping-store.ts` | 222 | File-based persistence with indexes |
| `src/config.ts` | 169 | Environment variable loading |
| `src/session-manager.ts` | 143 | User session management |
| `src/opencode-session-registry.ts` | 371 | OpenCode session discovery |
| `src/monitor-service.ts` | 223 | Session monitoring and alerts |
| `src/message-router.ts` | 132 | Thread-aware message routing |
| `src/notification-service.ts` | 119 | Status notifications |
| `src/reaction-handler.ts` | 112 | Emoji reaction handling |
