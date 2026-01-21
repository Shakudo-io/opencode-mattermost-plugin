# OpenCode Mattermost Plugin - Refactoring Plan

**Created**: 2026-01-20
**Current Version**: v0.2.70
**Current Size**: 1,826 lines in `index.ts`
**Target Size**: ~400 lines in `index.ts`

## Executive Summary

The plugin's main file (`index.ts`) has grown to 1,826 lines with mixed concerns: types, formatting utilities, timer management, connection handling, 9 tool definitions, and 15+ event handlers. This plan breaks it into focused modules while maintaining the same external behavior.

## Key Findings

### OpenCode Plugin System Compatibility

**Multi-file plugins are fully supported.** The plugin loader:
1. Imports the main module via `import(plugin)` 
2. Iterates all exports looking for functions that return `Hooks`
3. Each hook function receives `PluginInput` with `client`, `project`, `$`, etc.

Internal imports work normally. The `package.json` entry `"main": "index.ts"` tells Bun which file to load.

### Current Architecture Problems

| Problem | Lines Affected | Impact |
|---------|---------------|--------|
| Monolithic structure | All 1,826 | Hard to navigate |
| Global state scattered | 23-91 | Hard to test, race conditions |
| Mixed concerns | Throughout | No separation of responsibilities |
| Huge event handler block | 1451-1770 | Complex conditional logic |
| 9 tools inline | 1106-1449 | Each tool adds ~40 lines |

### Global State Analysis

```typescript
// Module-level globals that need careful handling:
let isConnected = false;                    // Connection state
let mmClient: MattermostClient | null;      // API client
let wsClient: MattermostWebSocketClient | null; // WebSocket
let sessionManager: SessionManager | null;  // User sessions
let streamer: ResponseStreamer | null;      // Response streaming
let notifications: NotificationService | null;
let fileHandler: FileHandler | null;
let reactionHandler: ReactionHandler | null;
let openCodeSessionRegistry: OpenCodeSessionRegistry | null;
let messageRouter: MessageRouter | null;
let commandHandler: CommandHandler | null;
let threadMappingStore: ThreadMappingStore | null;
let threadManager: ThreadManager | null;
let todoManager: TodoManager | null;
let questionHandler: QuestionHandler | null;
let botUser: User | null;
let projectName: string;

// State maps that track active operations:
const activeResponseContexts: Map<string, ResponseContext>;
const activeToolTimers: Map<string, ReturnType<typeof setInterval>>;
const activeResponseTimers: Map<string, ReturnType<typeof setInterval>>;
let questionCleanupTimer: ReturnType<typeof setInterval> | null;
```

**Strategy**: Create a `PluginState` singleton that encapsulates all global state, with getter/setter methods that throw if accessed before initialization.

---

## Proposed Module Structure

```
.opencode/plugin/mattermost-control/
├── index.ts                    # Plugin entry (~400 lines)
├── types.ts                    # Interfaces & type definitions (~100 lines)
├── state.ts                    # PluginState singleton (~150 lines)
├── formatters.ts               # Formatting utilities (~120 lines)
├── timers.ts                   # Timer management (~80 lines)
├── response-context.ts         # ResponseContext operations (~150 lines)
├── connection.ts               # Connect/disconnect/status (~200 lines)
├── event-handlers/
│   ├── index.ts               # Handler registration (~50 lines)
│   ├── compaction.ts          # session.compacted (~60 lines)
│   ├── message.ts             # message.updated, message.part.updated (~200 lines)
│   ├── session.ts             # session.idle, session.status (~100 lines)
│   ├── tool.ts                # tool.execute.before/after (~150 lines)
│   ├── question.ts            # question.asked (~80 lines)
│   └── misc.ts                # file.edited, todo.updated, permission.asked (~100 lines)
└── tools/
    ├── index.ts               # Tool registration (~30 lines)
    ├── connect.ts             # mattermost_connect, disconnect, status (~120 lines)
    ├── session.ts             # list_sessions, select_session, current_session (~150 lines)
    ├── monitor.ts             # mattermost_monitor, unmonitor (~100 lines)
    └── file.ts                # mattermost_send_file (~80 lines)
```

**Total estimated**: ~1,950 lines (slight increase due to module boilerplate), but main file drops from 1,826 to ~400.

---

## Extraction Phases

### Phase 1: Extract `types.ts` (LOW RISK)

**What to move** (lines 40-91):
```typescript
// Types with no dependencies - pure data definitions
interface ActiveTool { name: string; startTime: number; }
interface TodoItem { id: string; content: string; status: string; priority: string; }
interface TokenInfo { input: number; output: number; reasoning: number; cache: {...} }
interface CostInfo { sessionTotal: number; currentMessage: number; tokens: TokenInfo; }
interface ResponseContext { 
  opencodeSessionId: string;
  mmSession: any;
  streamCtx: any;
  // ... all fields
}
```

**Export pattern**:
```typescript
// types.ts
export interface ActiveTool { ... }
export interface TodoItem { ... }
export interface TokenInfo { ... }
export interface CostInfo { ... }
export interface ResponseContext { ... }
```

**Import in index.ts**:
```typescript
import type { ActiveTool, TodoItem, ResponseContext, CostInfo } from "./types.js";
```

**Risk**: None. Pure type definitions with no runtime behavior.

---

### Phase 2: Extract `formatters.ts` (LOW RISK)

**What to move** (lines 95-360):
```typescript
// Pure functions - no side effects, no state access
function formatElapsedTime(ms: number): string
function formatTokenCount(tokens: number): string
function formatCost(cost: number): string
function formatCostStatus(cost: CostInfo): string
function formatToolStatus(toolCalls, activeTool, compactionCount, cost, responseStartTime, awaitingContinuation): string
function formatShellOutput(shellOutput, lastOutputTime?, toolStartTime?): string
function formatTodoStatus(todos: TodoItem[]): string
function formatFullResponse(ctx: ResponseContext): string

// Also move these constants:
const TODO_STATUS_ICONS: Record<string, string>
const MAX_SHELL_OUTPUT_LINES = 15
const BASH_HEARTBEAT_THRESHOLD_MS = 10_000
```

**Dependencies**: Only imports from `./types.ts`

**Export pattern**:
```typescript
// formatters.ts
import type { ResponseContext, TodoItem, CostInfo, ActiveTool } from "./types.js";

export const TODO_STATUS_ICONS = { ... };
export const MAX_SHELL_OUTPUT_LINES = 15;
export const BASH_HEARTBEAT_THRESHOLD_MS = 10_000;

export function formatElapsedTime(ms: number): string { ... }
export function formatTokenCount(tokens: number): string { ... }
export function formatCost(cost: number): string { ... }
export function formatCostStatus(cost: CostInfo): string { ... }
export function formatToolStatus(...): string { ... }
export function formatShellOutput(...): string { ... }
export function formatTodoStatus(todos: TodoItem[]): string { ... }
export function formatFullResponse(ctx: ResponseContext): string { ... }
```

**Risk**: Low. Pure functions with clear inputs/outputs.

---

### Phase 3: Extract `state.ts` (MEDIUM RISK)

Create a PluginState singleton that manages all global state:

```typescript
// state.ts
import type { ResponseContext } from "./types.js";
import type { MattermostClient } from "../../../src/clients/mattermost-client.js";
import type { MattermostWebSocketClient } from "../../../src/clients/websocket-client.js";
// ... other imports

class PluginStateManager {
  private _isConnected = false;
  private _mmClient: MattermostClient | null = null;
  private _wsClient: MattermostWebSocketClient | null = null;
  private _sessionManager: SessionManager | null = null;
  private _streamer: ResponseStreamer | null = null;
  // ... all other state fields
  
  private _activeResponseContexts = new Map<string, ResponseContext>();
  private _activeToolTimers = new Map<string, ReturnType<typeof setInterval>>();
  private _activeResponseTimers = new Map<string, ReturnType<typeof setInterval>>();
  private _questionCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // Getters that throw if not initialized
  get mmClient(): MattermostClient {
    if (!this._mmClient) throw new Error("Plugin not connected");
    return this._mmClient;
  }
  
  get isConnected(): boolean {
    return this._isConnected;
  }
  
  // Safe getters that return null
  get mmClientOrNull(): MattermostClient | null {
    return this._mmClient;
  }
  
  // Setters
  setConnected(client: MattermostClient, wsClient: MattermostWebSocketClient, ...): void {
    this._isConnected = true;
    this._mmClient = client;
    this._wsClient = wsClient;
    // ...
  }
  
  disconnect(): void {
    this._isConnected = false;
    this._mmClient = null;
    // ...
  }
  
  // Response context operations
  getResponseContext(sessionId: string): ResponseContext | undefined { ... }
  setResponseContext(sessionId: string, ctx: ResponseContext): void { ... }
  deleteResponseContext(sessionId: string): void { ... }
  
  // Timer operations
  setToolTimer(sessionId: string, timer: ReturnType<typeof setInterval>): void { ... }
  clearToolTimer(sessionId: string): void { ... }
  // ...
}

export const PluginState = new PluginStateManager();
```

**Risk**: Medium. Requires updating all global state access points, but isolates state management.

---

### Phase 4: Extract `timers.ts` (LOW RISK)

**What to move** (lines 167-253):
```typescript
// Timer management functions
function startActiveToolTimer(sessionId: string): void
function stopActiveToolTimer(sessionId: string): void
function startResponseTimer(sessionId: string): void
function stopResponseTimer(sessionId: string): void
function startQuestionCleanupTimer(): void
function stopQuestionCleanupTimer(): void

// Constants
const TOOL_UPDATE_INTERVAL_MS = 1000
const QUESTION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const QUESTION_EXPIRY_MS = 30 * 60 * 1000
```

**Dependencies**: 
- `./state.ts` (for timer maps, questionHandler)
- `./response-context.ts` (for updateResponseStream)

**Export pattern**:
```typescript
// timers.ts
import { PluginState } from "./state.js";
import { updateResponseStream } from "./response-context.js";

export const TOOL_UPDATE_INTERVAL_MS = 1000;
export const QUESTION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const QUESTION_EXPIRY_MS = 30 * 60 * 1000;

export function startActiveToolTimer(sessionId: string): void { ... }
export function stopActiveToolTimer(sessionId: string): void { ... }
export function startResponseTimer(sessionId: string): void { ... }
export function stopResponseTimer(sessionId: string): void { ... }
export function startQuestionCleanupTimer(): void { ... }
export function stopQuestionCleanupTimer(): void { ... }
```

---

### Phase 5: Extract `response-context.ts` (MEDIUM RISK)

**What to move**:
- `activeResponseContexts` Map management
- `updateResponseStream()` function
- Response context creation/cleanup helpers

```typescript
// response-context.ts
import { PluginState } from "./state.js";
import type { ResponseContext } from "./types.js";
import { formatFullResponse } from "./formatters.js";
import { log } from "../../../src/logger.js";

export function createResponseContext(params: {
  opencodeSessionId: string;
  mmSession: any;
  streamCtx: any;
  threadRootPostId?: string;
}): ResponseContext {
  return {
    ...params,
    responseBuffer: "",
    thinkingBuffer: "",
    toolCalls: [],
    activeTool: null,
    shellOutput: "",
    shellOutputLastUpdate: 0,
    lastUpdateTime: Date.now(),
    compactionCount: 0,
    todos: [],
    cost: { sessionTotal: 0, currentMessage: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    responseStartTime: Date.now(),
    awaitingContinuation: false,
    inCompactionSummary: false,
  };
}

export async function updateResponseStream(sessionId: string): Promise<void> {
  const ctx = PluginState.getResponseContext(sessionId);
  const streamer = PluginState.streamerOrNull;
  if (!ctx || !streamer) return;
  
  const formattedOutput = formatFullResponse(ctx);
  
  try {
    await streamer.updateStream(ctx.streamCtx, formattedOutput);
  } catch (e) {
    log.error("Failed to update stream:", e);
  }
}

export function finalizeResponseContext(sessionId: string): void {
  // Cleanup logic
  PluginState.deleteResponseContext(sessionId);
}
```

---

### Phase 6: Extract `connection.ts` (MEDIUM RISK)

**What to move** (lines 380-617):
- `handleConnect()` function
- `handleDisconnect()` function  
- `handleStatus()` function
- Client initialization logic
- Session registry callbacks

```typescript
// connection.ts
import { PluginState } from "./state.js";
import { startQuestionCleanupTimer, stopQuestionCleanupTimer } from "./timers.js";
import { setupEventListeners } from "./event-handlers/index.js";
import { log } from "../../../src/logger.js";
// ... other imports

export async function handleConnect(config: Config, projectName: string): Promise<string> {
  if (PluginState.isConnected) {
    return `Already connected...`;
  }
  // ... connection logic
}

export async function handleDisconnect(): Promise<string> {
  // ... disconnect logic
}

export function handleStatus(): string {
  // ... status logic
}
```

---

### Phase 7: Extract `event-handlers/` Directory (MEDIUM-HIGH RISK)

This is the largest extraction. Create focused handler modules:

#### `event-handlers/index.ts`
```typescript
import { handleSessionCompacted } from "./compaction.js";
import { handleMessageUpdated, handleMessagePartUpdated } from "./message.js";
import { handleSessionIdle, handleSessionStatus } from "./session.js";
import { handleToolExecuteBefore, handleToolExecuteAfter } from "./tool.js";
import { handleQuestionAsked } from "./question.js";
import { handleFileEdited, handleTodoUpdated, handlePermissionAsked } from "./misc.js";

export function setupAllEventHandlers(client: OpencodeClient): void {
  // Register all handlers
}

export {
  handleSessionCompacted,
  handleMessageUpdated,
  handleMessagePartUpdated,
  // ...
};
```

#### `event-handlers/compaction.ts`
```typescript
// Lines 1580-1610 - session.compacted handler
export function handleSessionCompacted(event: SessionCompactedEvent): void {
  // Reset inCompactionSummary flag
  // Handle continuation logic
}

// Lines 1627-1630 - compaction detection in message.updated
export function isCompactionMessage(event: MessageUpdatedEvent): boolean {
  return event.properties?.agent === "compaction" || event.properties?.summary === true;
}
```

#### `event-handlers/message.ts`
```typescript
// Lines 1614-1700 - message.updated & message.part.updated handlers
export async function handleMessageUpdated(event: MessageUpdatedEvent): Promise<void> {
  // Initialize response context
  // Detect compaction messages
}

export async function handleMessagePartUpdated(event: MessagePartUpdatedEvent): Promise<void> {
  // Handle text parts
  // Handle thinking parts
  // Skip if inCompactionSummary
}
```

#### `event-handlers/session.ts`
```typescript
// Lines 1702-1750 - session.idle & session.status handlers
export async function handleSessionIdle(event: SessionIdleEvent): Promise<void> {
  // Finalize response
  // Check awaitingContinuation and inCompactionSummary
}

export function handleSessionStatus(event: SessionStatusEvent): void {
  // Handle permission.asked, question.asked, etc.
}
```

#### `event-handlers/tool.ts`
```typescript
// Lines 1772-1822 - tool execution hooks
export function handleToolExecuteBefore(event: ToolExecuteBeforeEvent): void {
  // Set activeTool
  // Handle bash output streaming
}

export function handleToolExecuteAfter(event: ToolExecuteAfterEvent): void {
  // Clear activeTool
  // Record tool call
}
```

---

### Phase 8: Extract `tools/` Directory (LOW RISK)

Each tool is self-contained:

#### `tools/index.ts`
```typescript
import { connectTools } from "./connect.js";
import { sessionTools } from "./session.js";
import { monitorTools } from "./monitor.js";
import { fileTools } from "./file.js";

export const allTools = {
  ...connectTools,
  ...sessionTools,
  ...monitorTools,
  ...fileTools,
};
```

#### `tools/connect.ts`
```typescript
import { tool } from "@opencode-ai/plugin";
import { handleConnect, handleDisconnect, handleStatus } from "../connection.js";

export const connectTools = {
  mattermost_connect: tool({
    description: "Connect to Mattermost...",
    args: {},
    async execute() {
      return handleConnect();
    }
  }),
  mattermost_disconnect: tool({ ... }),
  mattermost_status: tool({ ... }),
};
```

#### `tools/session.ts`
```typescript
export const sessionTools = {
  mattermost_list_sessions: tool({ ... }),
  mattermost_select_session: tool({ ... }),
  mattermost_current_session: tool({ ... }),
};
```

#### `tools/monitor.ts`
```typescript
export const monitorTools = {
  mattermost_monitor: tool({ ... }),
  mattermost_unmonitor: tool({ ... }),
};
```

#### `tools/file.ts`
```typescript
export const fileTools = {
  mattermost_send_file: tool({ ... }),
};
```

---

## Final `index.ts` Structure (~400 lines)

After extraction, `index.ts` becomes a slim orchestration file:

```typescript
// index.ts - ~400 lines
import type { Plugin } from "@opencode-ai/plugin";
import { PluginState } from "./state.js";
import { handleConnect, handleDisconnect, handleStatus } from "./connection.js";
import { setupAllEventHandlers } from "./event-handlers/index.js";
import { allTools } from "./tools/index.js";
import { loadConfig } from "../../../src/config.js";
import { log } from "../../../src/logger.js";

export const MattermostControlPlugin: Plugin = async ({ client, project, directory, serverUrl, $ }) => {
  const config = loadConfig();
  const projectName = directory.split("/").pop() || "opencode";
  
  // Initialize state
  PluginState.initialize({ config, projectName, opencodeBaseUrl: serverUrl.origin });
  
  // Auto-connect if configured
  if (config.mattermost.autoConnect && config.mattermost.token) {
    setTimeout(() => handleConnect(config, projectName), 100);
  }
  
  return {
    tool: allTools,
    event: async ({ event }) => {
      // Route events to handlers
      setupAllEventHandlers(client);
    },
    "tool.execute.before": async (input, output) => {
      // Delegate to handler
    },
    "tool.execute.after": async (input, output) => {
      // Delegate to handler
    },
  };
};

export default MattermostControlPlugin;
```

---

## Migration Strategy

### Recommended Order

1. **types.ts** - Zero risk, no runtime changes
2. **formatters.ts** - Pure functions, easy to test
3. **state.ts** - Central state management (affects all subsequent phases)
4. **timers.ts** - Depends on state.ts
5. **response-context.ts** - Depends on state.ts, formatters.ts
6. **connection.ts** - Depends on state.ts, timers.ts
7. **event-handlers/** - Depends on state.ts, response-context.ts
8. **tools/** - Depends on connection.ts

### Per-Phase Checklist

For each phase:
- [ ] Create new file with extracted code
- [ ] Add imports/exports
- [ ] Update index.ts imports
- [ ] Remove extracted code from index.ts
- [ ] Run `bun run typecheck`
- [ ] Manual test: connect, send prompt, verify response
- [ ] Commit with message `refactor(plugin): extract {module}`

### Testing Strategy

After each extraction:
1. **Type check**: `bun run typecheck`
2. **Manual smoke test**:
   - Connect to Mattermost
   - Send a simple prompt
   - Verify response streams correctly
   - Verify tool execution displays
   - Check compaction handling (if applicable)
3. **Publish patch version** after each stable phase

---

## Risk Mitigation

### Circular Dependencies
- **Prevention**: State module has no imports from other local modules
- **Detection**: TypeScript will error on circular imports

### Runtime Errors
- **Prevention**: PluginState getters throw early if not initialized
- **Rollback**: Each phase is a separate commit, easy to revert

### State Race Conditions
- **Current risk**: Already exists with scattered globals
- **Improvement**: Centralized state makes synchronization easier

---

## Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| index.ts lines | 1,826 | ~400 |
| Max file size | 1,826 | ~200 |
| Modules | 1 | 12 |
| Testable units | 0 | 8+ |
| Circular deps | 0 | 0 |

---

## Timeline Estimate

| Phase | Complexity | Est. Time |
|-------|-----------|-----------|
| Phase 1: types.ts | Low | 15 min |
| Phase 2: formatters.ts | Low | 30 min |
| Phase 3: state.ts | Medium | 1 hour |
| Phase 4: timers.ts | Low | 30 min |
| Phase 5: response-context.ts | Medium | 45 min |
| Phase 6: connection.ts | Medium | 1 hour |
| Phase 7: event-handlers/ | High | 2 hours |
| Phase 8: tools/ | Low | 1 hour |
| **Total** | | **~7 hours** |

---

## Appendix: Line-by-Line Mapping

### Current index.ts Structure

| Lines | Content | Target Module |
|-------|---------|---------------|
| 1-22 | Imports | index.ts (keep) |
| 23-39 | Global state declarations | state.ts |
| 40-91 | Interface definitions | types.ts |
| 92-94 | activeResponseContexts Map | state.ts |
| 95-166 | Format functions + constants | formatters.ts |
| 167-253 | Timer functions + constants | timers.ts |
| 254-360 | formatShellOutput, formatTodoStatus, formatFullResponse | formatters.ts |
| 362-379 | Plugin entry, config load | index.ts (keep) |
| 380-549 | handleConnect | connection.ts |
| 551-591 | handleDisconnect | connection.ts |
| 593-617 | handleStatus | connection.ts |
| 619-659 | setupEventListeners (WS) | connection.ts |
| 661-834 | handleUserMessage, routing | event-handlers/routing.ts |
| 836-911 | Helpers (convertLegacyRoute, etc.) | connection.ts |
| 913-1104 | handleThreadPrompt | event-handlers/message.ts |
| 1106-1180 | mattermost_connect tool | tools/connect.ts |
| 1182-1210 | mattermost_disconnect tool | tools/connect.ts |
| 1212-1240 | mattermost_status tool | tools/connect.ts |
| 1242-1280 | mattermost_list_sessions tool | tools/session.ts |
| 1282-1340 | mattermost_select_session tool | tools/session.ts |
| 1342-1380 | mattermost_current_session tool | tools/session.ts |
| 1382-1420 | mattermost_monitor tool | tools/monitor.ts |
| 1422-1449 | mattermost_send_file tool | tools/file.ts |
| 1451-1510 | permission.asked handler | event-handlers/misc.ts |
| 1512-1578 | question.asked handler | event-handlers/question.ts |
| 1580-1612 | session.compacted handler | event-handlers/compaction.ts |
| 1614-1700 | message.updated, message.part.updated | event-handlers/message.ts |
| 1702-1770 | session.idle, session.status | event-handlers/session.ts |
| 1772-1822 | tool.execute.before/after | event-handlers/tool.ts |
| 1824-1826 | Export | index.ts (keep) |
