# Multi-Tenant Access Control Implementation Plan

**Date:** 2026-01-22  
**Author:** AI Assistant  
**Status:** Draft  
**Repository:** opencode-mattermost-plugin

## Overview

This document outlines the implementation plan for exposing the OpenCode Mattermost bot to general employees with restricted access. The solution combines:

- **Option B:** Per-user session isolation with dedicated working directories
- **Option C:** Plugin-level path enforcement via `tool.execute.before` hook

## Goals

1. Allow any employee to interact with the bot via @mention in any channel/thread
2. Restrict tool access based on user/group membership
3. Restrict file system access to `/tmp` (with per-user isolation)
4. Enable file upload/download workflows within the sandbox
5. Maintain full access for admin users

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mattermost Server                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Channel A  │  │  Channel B  │  │    DM       │              │
│  │  @bot help  │  │  @bot code  │  │  @bot ...   │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
└─────────┼────────────────┼────────────────┼─────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Mattermost Plugin (Enhanced)                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Access Control Layer                    │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │   │
│  │  │ Config Mgr  │  │ User Tier   │  │ Permission  │       │   │
│  │  │ (YAML)      │  │ Resolver    │  │ Evaluator   │       │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Session Manager                         │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │   │
│  │  │ User→Session│  │ Workdir     │  │ Lifecycle   │       │   │
│  │  │ Mapping     │  │ Manager     │  │ Manager     │       │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      OpenCode Server                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Plugin Hooks                           │   │
│  │  ┌─────────────────────┐  ┌─────────────────────┐        │   │
│  │  │ tool.execute.before │  │ chat.message        │        │   │
│  │  │ (Path Enforcement)  │  │ (Tool Filtering)    │        │   │
│  │  └─────────────────────┘  └─────────────────────┘        │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Per-User Sessions                       │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐             │   │
│  │  │ Session A │  │ Session B │  │ Session C │             │   │
│  │  │ /tmp/u/A  │  │ /tmp/u/B  │  │ /tmp/u/C  │             │   │
│  │  └───────────┘  └───────────┘  └───────────┘             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      File System                                 │
│  /tmp/                                                          │
│  ├── bot-users/                                                 │
│  │   ├── {userId-A}/        # User A's sandbox                  │
│  │   ├── {userId-B}/        # User B's sandbox                  │
│  │   └── {userId-C}/        # User C's sandbox                  │
│  └── bot-shared/            # Shared directory (optional)       │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration Schema

### File Location

```
~/.config/opencode/mattermost-access.yaml
```

### Full Schema

```yaml
# Version for future migrations
version: 1

# Default permissions applied to all users before group/user overrides
defaults:
  tools:
    # Explicitly list allowed tools (everything else denied)
    read: true
    write: true
    grep: true
    glob: true
    webfetch: true
    tavily-search_tavily-search: true
    # Dangerous tools explicitly denied
    bash: false
    edit: false
    task: false
    interactive_bash: false
    
  paths:
    # Default path rules (order matters - last match wins)
    - pattern: "*"
      action: deny
    - pattern: "/tmp/bot-shared/*"
      action: allow

# Group definitions
groups:
  # Admin group - full access
  admins:
    members:
      - yevgeniy
      - other-admin
    tools: "*"  # All tools allowed
    paths:
      - pattern: "*"
        action: allow

  # Power users - more tools, own home directory
  power-users:
    members:
      - alice
      - bob
    tools:
      bash: true
      edit: true
      read: true
      write: true
      grep: true
      glob: true
      webfetch: true
      task: false  # Still no subagents
    paths:
      - pattern: "/tmp/bot-users/${userId}/*"
        action: allow
      - pattern: "/tmp/bot-shared/*"
        action: allow

  # Basic users - default group for everyone else
  basic-users:
    members: "*"  # Catch-all
    tools:
      read: true
      write: true
      grep: true
      glob: true
      webfetch: true
      tavily-search_tavily-search: true
    paths:
      - pattern: "/tmp/bot-users/${userId}/*"
        action: allow
      - pattern: "/tmp/bot-shared/*"
        action: allow

# Individual user overrides (applied after group)
users:
  # Contractor with limited extra access
  contractor-jane:
    tools:
      bash: true  # Allow bash for this user
    paths:
      - pattern: "/tmp/projects/frontend/*"
        action: allow

  # Restricted user
  intern-bob:
    tools:
      write: false  # Disable write for this user
    paths:
      - pattern: "/tmp/bot-users/${userId}/*"
        action: allow
      # No shared access

# Session configuration
sessions:
  # How to isolate sessions
  isolation: per-user  # Options: per-user, per-channel, shared
  
  # Base directory for user sandboxes
  sandboxBase: /tmp/bot-users
  
  # Shared directory (accessible by all with permission)
  sharedDir: /tmp/bot-shared
  
  # Session timeout in seconds (0 = no timeout)
  timeout: 3600
  
  # Maximum sessions per user
  maxSessionsPerUser: 3
  
  # Cleanup orphaned sessions after (seconds)
  orphanCleanupAfter: 86400

# Audit logging
audit:
  enabled: true
  logFile: /tmp/bot-audit.log
  logLevel: info  # debug, info, warn, error
  # What to log
  events:
    - tool_execution
    - path_access_denied
    - session_created
    - session_destroyed
```

### TypeScript Schema Definition

```typescript
// src/access-control/schema.ts
import { z } from "zod"

const PathRule = z.object({
  pattern: z.string(),
  action: z.enum(["allow", "deny", "ask"]),
})

const ToolConfig = z.union([
  z.literal("*"),
  z.record(z.string(), z.boolean()),
])

const GroupConfig = z.object({
  members: z.union([z.literal("*"), z.array(z.string())]),
  tools: ToolConfig.optional(),
  paths: z.array(PathRule).optional(),
})

const UserConfig = z.object({
  tools: ToolConfig.optional(),
  paths: z.array(PathRule).optional(),
})

const SessionConfig = z.object({
  isolation: z.enum(["per-user", "per-channel", "shared"]).default("per-user"),
  sandboxBase: z.string().default("/tmp/bot-users"),
  sharedDir: z.string().default("/tmp/bot-shared"),
  timeout: z.number().default(3600),
  maxSessionsPerUser: z.number().default(3),
  orphanCleanupAfter: z.number().default(86400),
})

const AuditConfig = z.object({
  enabled: z.boolean().default(true),
  logFile: z.string().default("/tmp/bot-audit.log"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  events: z.array(z.string()).default(["tool_execution", "path_access_denied"]),
})

export const AccessConfig = z.object({
  version: z.number().default(1),
  defaults: z.object({
    tools: ToolConfig,
    paths: z.array(PathRule),
  }),
  groups: z.record(z.string(), GroupConfig),
  users: z.record(z.string(), UserConfig).optional(),
  sessions: SessionConfig,
  audit: AuditConfig.optional(),
})

export type AccessConfig = z.infer<typeof AccessConfig>
```

## Implementation Phases

### Phase 1: Configuration System

**Files to create:**
- `src/access-control/schema.ts` - Zod schema definitions
- `src/access-control/config.ts` - Config loading and validation
- `src/access-control/resolver.ts` - Permission resolution logic

**Tasks:**

1. **Config Loader** (`src/access-control/config.ts`)
   ```typescript
   export class AccessConfigManager {
     private config: AccessConfig
     private configPath: string
     private lastModified: number
     
     constructor(configPath?: string)
     
     // Load config from YAML file
     async load(): Promise<AccessConfig>
     
     // Reload if file changed
     async reload(): Promise<boolean>
     
     // Watch for changes
     watch(callback: (config: AccessConfig) => void): void
     
     // Get current config
     get(): AccessConfig
   }
   ```

2. **Permission Resolver** (`src/access-control/resolver.ts`)
   ```typescript
   export class PermissionResolver {
     constructor(private config: AccessConfig)
     
     // Get user's group
     getUserGroup(username: string): string | null
     
     // Resolve effective tool permissions
     resolveTools(username: string, userId: string): Record<string, boolean>
     
     // Resolve effective path rules
     resolvePaths(username: string, userId: string): PathRule[]
     
     // Check if path is allowed
     isPathAllowed(path: string, rules: PathRule[]): boolean
     
     // Check if tool is allowed
     isToolAllowed(tool: string, tools: Record<string, boolean>): boolean
     
     // Interpolate variables in pattern
     interpolate(pattern: string, vars: Record<string, string>): string
   }
   ```

**Estimated effort:** 1-2 days

---

### Phase 2: Session Management

**Files to create:**
- `src/access-control/session-manager.ts` - User-to-session mapping
- `src/access-control/sandbox.ts` - Sandbox directory management

**Tasks:**

1. **Session Manager** (`src/access-control/session-manager.ts`)
   ```typescript
   interface UserSession {
     sessionId: string
     userId: string
     username: string
     workdir: string
     createdAt: number
     lastActivity: number
   }
   
   export class SessionManager {
     private sessions: Map<string, UserSession>
     private userToSession: Map<string, string[]>  // userId -> sessionIds
     
     constructor(
       private config: AccessConfig,
       private openCodeClient: OpenCodeClient
     )
     
     // Get or create session for user
     async getOrCreateSession(userId: string, username: string): Promise<UserSession>
     
     // Get existing session
     getSession(userId: string): UserSession | null
     
     // Create new session with user's sandbox
     async createSession(userId: string, username: string): Promise<UserSession>
     
     // Destroy session
     async destroySession(sessionId: string): Promise<void>
     
     // Cleanup expired sessions
     async cleanupExpired(): Promise<number>
     
     // Get all sessions for user
     getUserSessions(userId: string): UserSession[]
   }
   ```

2. **Sandbox Manager** (`src/access-control/sandbox.ts`)
   ```typescript
   export class SandboxManager {
     constructor(private config: AccessConfig)
     
     // Get sandbox path for user
     getUserSandbox(userId: string): string
     
     // Ensure sandbox directory exists
     async ensureSandbox(userId: string): Promise<string>
     
     // Cleanup user sandbox
     async cleanupSandbox(userId: string): Promise<void>
     
     // Get shared directory path
     getSharedDir(): string
     
     // Ensure shared directory exists
     async ensureSharedDir(): Promise<string>
   }
   ```

**Estimated effort:** 1-2 days

---

### Phase 3: Tool Filtering Integration

**Files to modify:**
- `.opencode/plugin/mattermost-control/index.ts` - Add tool filtering to prompt calls

**Tasks:**

1. **Modify message handling to include tool filtering**
   ```typescript
   // In handleMattermostMessage or equivalent
   async function handleUserMessage(
     userId: string,
     username: string,
     message: string,
     channelId: string
   ) {
     const resolver = getPermissionResolver()
     const sessionManager = getSessionManager()
     
     // Get or create user's session
     const session = await sessionManager.getOrCreateSession(userId, username)
     
     // Resolve tool permissions for this user
     const tools = resolver.resolveTools(username, userId)
     
     // Store user context for path enforcement hook
     setCurrentUserContext({
       userId,
       username,
       sessionId: session.sessionId,
       pathRules: resolver.resolvePaths(username, userId),
     })
     
     // Send prompt with tool restrictions
     await client.session.message({
       sessionId: session.sessionId,
       tools: tools,  // Tool whitelist/blacklist
       parts: [{ type: "text", text: message }],
     })
   }
   ```

**Estimated effort:** 0.5-1 day

---

### Phase 4: Path Enforcement Hook

**Files to create:**
- `src/access-control/path-enforcer.ts` - Path validation logic

**Files to modify:**
- `.opencode/plugin/mattermost-control/index.ts` - Register hook

**Tasks:**

1. **Path Enforcer** (`src/access-control/path-enforcer.ts`)
   ```typescript
   // Tools that have path arguments
   const PATH_TOOLS: Record<string, string[]> = {
     read: ["filePath"],
     write: ["filePath"],
     edit: ["filePath"],
     glob: ["path"],
     grep: ["path"],
     bash: ["workdir"],  // Also need to parse command for paths
     ls: ["path"],
     patch: ["filePath"],
   }
   
   export class PathEnforcer {
     constructor(private resolver: PermissionResolver)
     
     // Extract paths from tool arguments
     extractPaths(tool: string, args: any): string[]
     
     // Validate all paths against rules
     validatePaths(
       paths: string[],
       rules: PathRule[],
       workdir: string
     ): { allowed: boolean; denied: string[] }
     
     // Parse bash command for potential paths (heuristic)
     parseBashPaths(command: string, workdir: string): string[]
     
     // Enforce path rules - throws if denied
     enforce(
       tool: string,
       args: any,
       userContext: UserContext
     ): void
   }
   ```

2. **Register hook in plugin**
   ```typescript
   // In plugin hooks
   export const hooks: Hooks = {
     // ... existing hooks
     
     "tool.execute.before": async (input, output) => {
       const userContext = getCurrentUserContext()
       if (!userContext) return  // Admin or no context
       
       const enforcer = getPathEnforcer()
       
       try {
         enforcer.enforce(input.tool, output.args, userContext)
       } catch (error) {
         // Log denied access
         await auditLog({
           event: "path_access_denied",
           userId: userContext.userId,
           tool: input.tool,
           path: error.deniedPath,
           timestamp: Date.now(),
         })
         throw error  // Re-throw to abort tool execution
       }
     },
   }
   ```

**Estimated effort:** 1-2 days

---

### Phase 5: Audit Logging

**Files to create:**
- `src/access-control/audit.ts` - Audit logging system

**Tasks:**

1. **Audit Logger** (`src/access-control/audit.ts`)
   ```typescript
   interface AuditEvent {
     timestamp: number
     event: string
     userId: string
     username: string
     sessionId?: string
     tool?: string
     path?: string
     allowed?: boolean
     metadata?: Record<string, any>
   }
   
   export class AuditLogger {
     private logStream: WriteStream
     
     constructor(private config: AuditConfig)
     
     // Log an event
     async log(event: AuditEvent): Promise<void>
     
     // Query recent events
     async query(filter: Partial<AuditEvent>, limit?: number): Promise<AuditEvent[]>
     
     // Rotate log file
     async rotate(): Promise<void>
   }
   ```

**Estimated effort:** 0.5 day

---

### Phase 6: Testing & Documentation

**Files to create:**
- `src/access-control/__tests__/resolver.test.ts`
- `src/access-control/__tests__/session-manager.test.ts`
- `src/access-control/__tests__/path-enforcer.test.ts`
- `docs/access-control.md`

**Tasks:**

1. **Unit tests for permission resolution**
   - Test group membership resolution
   - Test tool permission merging
   - Test path rule evaluation
   - Test variable interpolation

2. **Integration tests**
   - Test session creation/destruction
   - Test tool filtering in API calls
   - Test path enforcement hook

3. **Documentation**
   - Config file reference
   - Setup guide
   - Troubleshooting guide

**Estimated effort:** 1-2 days

---

## File Structure

```
opencode-mattermost-plugin/
├── src/
│   ├── access-control/
│   │   ├── index.ts              # Public exports
│   │   ├── schema.ts             # Zod schemas
│   │   ├── config.ts             # Config loading
│   │   ├── resolver.ts           # Permission resolution
│   │   ├── session-manager.ts    # Session management
│   │   ├── sandbox.ts            # Sandbox directory mgmt
│   │   ├── path-enforcer.ts      # Path validation
│   │   ├── audit.ts              # Audit logging
│   │   └── __tests__/
│   │       ├── resolver.test.ts
│   │       ├── session-manager.test.ts
│   │       └── path-enforcer.test.ts
│   └── ...existing files
├── .opencode/
│   └── plugin/
│       └── mattermost-control/
│           ├── index.ts          # Modified: add hooks
│           └── ...existing files
├── docs/
│   ├── access-control.md         # User documentation
│   └── plans/
│       └── multi-tenant-access-control_20260122.md  # This file
└── examples/
    └── mattermost-access.yaml    # Example config
```

## Timeline

| Phase | Description | Effort | Dependencies |
|-------|-------------|--------|--------------|
| 1 | Configuration System | 1-2 days | None |
| 2 | Session Management | 1-2 days | Phase 1 |
| 3 | Tool Filtering Integration | 0.5-1 day | Phase 1, 2 |
| 4 | Path Enforcement Hook | 1-2 days | Phase 1, 2, 3 |
| 5 | Audit Logging | 0.5 day | Phase 1 |
| 6 | Testing & Documentation | 1-2 days | All phases |

**Total estimated effort:** 5-10 days

## Security Considerations

### Path Traversal Prevention

```typescript
// Always resolve to absolute path and check containment
function isPathAllowed(targetPath: string, rules: PathRule[], workdir: string): boolean {
  // Resolve to absolute path
  const absolutePath = path.isAbsolute(targetPath) 
    ? path.resolve(targetPath)
    : path.resolve(workdir, targetPath)
  
  // Normalize to prevent ../../../etc/passwd attacks
  const normalizedPath = path.normalize(absolutePath)
  
  // Check against rules
  return evaluatePathRules(normalizedPath, rules)
}
```

### Bash Command Analysis

Bash commands can contain arbitrary paths. We should:

1. **Parse common patterns:**
   ```typescript
   // Detect paths in bash commands
   const PATH_PATTERNS = [
     /(?:cat|head|tail|less|more)\s+([^\s|>]+)/g,
     /(?:rm|mkdir|rmdir|touch)\s+(?:-\w+\s+)*([^\s]+)/g,
     /(?:cp|mv)\s+(?:-\w+\s+)*([^\s]+)\s+([^\s]+)/g,
     /(?:cd)\s+([^\s;&|]+)/g,
     />\s*([^\s]+)/g,  // Output redirection
     />>\s*([^\s]+)/g, // Append redirection
   ]
   ```

2. **Whitelist safe commands for basic users:**
   ```yaml
   # In config
   groups:
     basic-users:
       bash:
         allowed_commands:
           - curl
           - wget
           - python
           - node
         blocked_patterns:
           - "rm -rf"
           - "sudo"
           - "> /"
           - ">> /"
   ```

### Symlink Attacks

```typescript
// Check for symlinks that escape sandbox
async function validateNoSymlinkEscape(filepath: string, allowedRoots: string[]): Promise<boolean> {
  try {
    const realPath = await fs.realpath(filepath)
    return allowedRoots.some(root => realPath.startsWith(root))
  } catch {
    // File doesn't exist yet - validate parent
    const parent = path.dirname(filepath)
    return validateNoSymlinkEscape(parent, allowedRoots)
  }
}
```

## Rollout Plan

### Stage 1: Internal Testing (Week 1)
- Deploy to test environment
- Test with 2-3 internal users
- Validate tool filtering works
- Validate path enforcement works
- Monitor audit logs

### Stage 2: Limited Beta (Week 2)
- Enable for power-users group
- Monitor for false positives (legitimate access denied)
- Tune path rules based on feedback
- Validate session isolation

### Stage 3: General Availability (Week 3+)
- Enable for all employees
- Monitor audit logs for suspicious activity
- Document common use cases
- Create FAQ for users

## Open Questions

1. **Session persistence:** Should sessions survive server restart?
   - Option A: Store in SQLite/file
   - Option B: Ephemeral (recreate on restart)

2. **Rate limiting:** Should we add per-user rate limits?
   - Requests per minute
   - Tool calls per session

3. **File upload/download:** How should users get files in/out of sandbox?
   - Option A: Mattermost file attachments
   - Option B: Shared directory
   - Option C: Presigned URLs

4. **MCP tools:** How to handle MCP-provided tools?
   - Should they be subject to the same filtering?
   - Some MCP tools may have their own path handling

## Appendix: Example Interactions

### Basic User Interaction

```
User @alice in #general:
  @bot help me analyze this CSV data

Bot:
  I'd be happy to help! Please upload your CSV file.

User uploads: sales_data.csv

Bot:
  I've received your file. Let me analyze it...
  [Internally: file saved to /tmp/bot-users/alice123/sales_data.csv]
  
  Here's what I found:
  - 1,234 rows
  - Columns: date, product, quantity, revenue
  ...

User:
  @bot can you read /etc/passwd

Bot:
  ⚠️ I don't have access to that location. I can only work with files in your sandbox directory.
  
  If you'd like me to analyze a file, please upload it and I'll save it to your workspace.
```

### Admin User Interaction

```
User @yevgeniy in DM:
  Look at /root/gitrepos/myproject/src/main.ts and suggest improvements

Bot:
  [Full access - reads the file]
  
  Here are my suggestions for main.ts:
  ...
```
