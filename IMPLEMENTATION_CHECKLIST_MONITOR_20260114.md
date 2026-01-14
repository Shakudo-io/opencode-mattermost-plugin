# Implementation Checklist: /mattermost-monitor Command

**Created**: 2026-01-14  
**Status**: In Progress  
**Target Version**: 0.2.7

---

## Overview

Add a `/mattermost-monitor` command that sends one-off Mattermost alerts when a session needs user input, even if the session isn't actively connected to Mattermost.

---

## Pre-Implementation

- [ ] **1.1** Confirm Verdaccio registry accessible
  ```bash
  curl -s http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873/-/ping
  ```

- [ ] **1.2** Verify current version (0.2.6) in package.json

- [ ] **1.3** Create feature branch
  ```bash
  git checkout -b feature/mattermost-monitor
  ```

---

## Implementation Tasks

### Phase 1: Monitor Service (`src/monitor-service.ts`) - NEW FILE

- [ ] **2.1** Create `MonitoredSession` interface
  ```typescript
  interface MonitoredSession {
    sessionId: string;
    targetUserId: string;       // Mattermost user ID to alert
    targetUsername: string;     // For display
    projectName: string;        // From session directory
    directory: string;          // Full path
    shortId: string;            // First 8 chars of session ID
    registeredAt: Date;
  }
  ```

- [ ] **2.2** Create `MonitorService` class
  - `register(sessionId, targetUser, projectInfo)` - Add session to monitoring
  - `unregister(sessionId)` - Remove session from monitoring
  - `isMonitored(sessionId)` - Check if session is being monitored
  - `get(sessionId)` - Get monitoring config for session
  - `getAll()` - List all monitored sessions

- [ ] **2.3** Create `sendEphemeralAlert(monitoredSession, alertType, details)` function
  - Creates new MattermostClient using env vars
  - Sends DM to target user
  - Closes connection immediately
  - Returns success/failure

- [ ] **2.4** Define alert types enum
  ```typescript
  type AlertType = 'permission' | 'question' | 'idle';
  ```

- [ ] **2.5** Create `formatAlertMessage(session, type, details)` function
  - Permission: "Permission request (edit file: /path/to/file)"
  - Question: "Question asked: [first 50 chars]"
  - Idle: "Session became idle"
  - Include `!use <shortId>` command

### Phase 2: Update Main Plugin (`index.ts`)

- [ ] **3.1** Import MonitorService
  ```typescript
  import { MonitorService } from "../../../src/monitor-service.js";
  ```

- [ ] **3.2** Add module-level MonitorService instance
  ```typescript
  let monitorService: MonitorService | null = null;
  ```

- [ ] **3.3** Initialize MonitorService in plugin setup (not in handleConnect)
  ```typescript
  monitorService = new MonitorService();
  ```

- [ ] **3.4** Create `mattermost_monitor` tool
  ```typescript
  const mattermostMonitorTool = tool({
    description: "Monitor this session and send a one-off Mattermost alert when user input is needed",
    args: {
      targetUser: tool.schema.string().optional()
        .describe("Mattermost username or ID to alert (default: looks up from env or fails)"),
    },
    async execute(args) { ... }
  });
  ```

- [ ] **3.5** Implement tool execution logic:
  - Validate MM credentials exist in env vars
  - Get current session ID from context
  - Resolve target user (from args or default)
  - Register session with MonitorService
  - Return confirmation message

- [ ] **3.6** Add tool to exports
  ```typescript
  tool: {
    // ... existing tools
    mattermost_monitor: mattermostMonitorTool,
  }
  ```

### Phase 3: Event Hook Updates (`index.ts`)

- [ ] **4.1** Add `permission.asked` event handler
  ```typescript
  if (event.type === "permission.asked") {
    const sessionId = (event as any).properties?.sessionID;
    if (monitorService?.isMonitored(sessionId)) {
      // Skip if this session has active MM connection
      if (sessionId === connectedOpenCodeSessionId) return;
      await handleMonitorAlert(sessionId, 'permission', event.properties);
    }
  }
  ```

- [ ] **4.2** Add `session.idle` event handler
  ```typescript
  if (event.type === "session.idle") {
    const sessionId = (event as any).properties?.sessionID;
    if (monitorService?.isMonitored(sessionId)) {
      if (sessionId === connectedOpenCodeSessionId) return;
      await handleMonitorAlert(sessionId, 'idle', {});
    }
  }
  ```

- [ ] **4.3** Add question tool detection in `message.part.updated`
  ```typescript
  if (event.type === "message.part.updated") {
    const part = (event as any).properties?.part;
    if (part?.type === "tool" && part?.tool === "question" && part?.state?.status === "pending") {
      const sessionId = part?.sessionID;
      if (monitorService?.isMonitored(sessionId)) {
        if (sessionId === connectedOpenCodeSessionId) return;
        await handleMonitorAlert(sessionId, 'question', part.state);
      }
    }
  }
  ```

- [ ] **4.4** Create `handleMonitorAlert(sessionId, type, details)` helper
  - Get monitoring config from MonitorService
  - Call `sendEphemeralAlert()`
  - On success: unregister session (one-off)
  - On failure: log error, keep registered for retry

### Phase 4: Configuration Updates

- [ ] **5.1** Update `src/config.ts` - Add monitor config section (if needed)
  - Default alert DM format
  - Ephemeral connection timeout

- [ ] **5.2** Update `src/models/index.ts` - Add any new types

### Phase 5: Testing

- [ ] **6.1** Manual test: Run `/mattermost-monitor` in a session
  - Verify success message
  - Verify session is tracked

- [ ] **6.2** Manual test: Trigger permission request
  - Run a command that needs permission approval
  - Verify DM is sent
  - Verify session is unregistered after alert

- [ ] **6.3** Manual test: Trigger question tool
  - Have AI use question tool
  - Verify DM is sent with question context

- [ ] **6.4** Manual test: Session idle
  - Let session go idle
  - Verify DM is sent

- [ ] **6.5** Edge case: Monitor already-connected session
  - Connect session A to MM
  - Run `/mattermost-monitor` in session A
  - Verify it works but alerts go through existing connection (or skips)

- [ ] **6.6** Edge case: No MM credentials
  - Unset MATTERMOST_TOKEN
  - Run `/mattermost-monitor`
  - Verify helpful error message

---

## Deployment

- [ ] **7.1** Run typecheck
  ```bash
  bun run typecheck
  ```

- [ ] **7.2** Bump version in package.json (0.2.6 → 0.2.7)

- [ ] **7.3** Commit changes
  ```bash
  git add -A
  git commit -m "feat: Add /mattermost-monitor for one-off session alerts"
  ```

- [ ] **7.4** Publish to Verdaccio
  ```bash
  npm publish --registry http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873
  ```

- [ ] **7.5** Clear bun cache and reinstall
  ```bash
  rm -rf ~/.bun/install/cache/*
  cd /root/.config/opencode
  rm -rf node_modules/opencode-mattermost-control bun.lock
  bun add opencode-mattermost-control@0.2.7 --registry http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873
  ```

- [ ] **7.6** Verify installation
  ```bash
  cat /root/.config/opencode/node_modules/opencode-mattermost-control/package.json | grep version
  # Should show: "version": "0.2.7"
  ```

- [ ] **7.7** Restart OpenCode and test
  ```bash
  # In new opencode session:
  mattermost_monitor
  ```

---

## Post-Deployment

- [ ] **8.1** Push to GitHub
  ```bash
  git push origin feature/mattermost-monitor
  ```

- [ ] **8.2** Create PR (if needed)

- [ ] **8.3** Merge to main

- [ ] **8.4** Update README.md with new command documentation

---

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/monitor-service.ts` | **NEW** | MonitorService class + ephemeral alert sending |
| `.opencode/plugin/.../index.ts` | MODIFY | Add mattermost_monitor tool + event handlers |
| `src/config.ts` | MODIFY (if needed) | Add monitor-specific config |
| `src/models/index.ts` | MODIFY (if needed) | Add new types |
| `package.json` | MODIFY | Bump version to 0.2.7 |
| `README.md` | MODIFY | Document new command |

---

## Rollback Plan

If issues occur:
1. Revert to 0.2.6: `bun add opencode-mattermost-control@0.2.6`
2. Or unpublish: `npm unpublish opencode-mattermost-control@0.2.7 --registry http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873`

---

## Notes

- Alert is **one-off**: After sending, session is unregistered
- Sessions with active MM connection skip monitor alerts (use existing flow)
- Ephemeral connection uses same env vars as regular connection
- No persistence - monitoring expires on OpenCode restart
