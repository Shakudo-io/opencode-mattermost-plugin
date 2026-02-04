# Kaji AI Agent - Mattermost Integration Analysis

**Document Date**: February 2, 2026  
**Plugin Version**: 0.3.45  
**Repository**: https://github.com/Shakudo-io/opencode-mattermost-plugin

---

## Executive Summary

The OpenCode Mattermost Control Plugin (Kaji) is a sophisticated integration layer that enables remote control of OpenCode AI coding sessions through Mattermost direct messages and channels. It provides real-time streaming responses, multi-session management, and advanced collaboration features including thread-per-session isolation, guest approval workflows, and scheduled task automation.

**Key Innovation**: Thread-per-session architecture ensures clean conversation isolation while enabling parallel control of multiple OpenCode sessions from a single Mattermost bot account.

---

## 1. Plugin Architecture & Core Features

### 1.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Mattermost Instance                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Bot User (@opencode-bot)                            │   │
│  │  - Receives DMs from users                           │   │
│  │  - Posts responses to threads                        │   │
│  │  - Manages file attachments                          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↕ WebSocket + REST API
┌─────────────────────────────────────────────────────────────┐
│              OpenCode Mattermost Plugin                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ WebSocket Client (Real-time Event Streaming)        │   │
│  │ - Listens for incoming DMs                          │   │
│  │ - Detects message edits and reactions               │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Message Router (Thread-Aware Routing)               │   │
│  │ - Routes messages to correct OpenCode sessions      │   │
│  │ - Handles thread context injection                  │   │
│  │ - Manages session lifecycle                         │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Response Streamer (Chunked Delivery)                │   │
│  │ - Buffers responses intelligently                   │   │
│  │ - Streams to Mattermost in real-time                │   │
│  │ - Handles message splitting (>15K chars)            │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Session Management                                  │   │
│  │ - Thread-to-session mapping persistence             │   │
│  │ - Multi-user session isolation                      │   │
│  │ - Session timeout management                        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↕ HTTP API
┌─────────────────────────────────────────────────────────────┐
│                  OpenCode Server                            │
│  - Maintains active sessions                               │
│  - Processes prompts asynchronously                        │
│  - Streams responses back to plugin                        │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Core Features

| Feature | Description | Implementation |
|---------|-------------|-----------------|
| **Thread-Per-Session** | Each OpenCode session gets dedicated Mattermost thread | ThreadManager creates root post per session |
| **Remote Control** | Send prompts via DM to control OpenCode | WebSocket listener + message router |
| **Multi-Session** | Control multiple sessions in parallel | ThreadMappingStore tracks session→thread mappings |
| **Real-time Streaming** | Responses stream back in chunks | ResponseStreamer with intelligent buffering |
| **File Attachments** | Send/receive files through Mattermost | FileHandler processes inbound/outbound files |
| **Auto-Reconnection** | WebSocket auto-reconnects with exponential backoff | WebSocketClient with retry logic |
| **Session Monitoring** | Get DM alerts when sessions need attention | MonitorService watches for permission/question/idle events |
| **Emoji Commands** | React with ✅/❌/🛑/🔁/🗑️ for quick actions | ReactionHandler processes emoji reactions |
| **Scheduled Tasks** | Cron-based task automation | SchedulerService with node-cron |

---

## 2. Integration Points: OpenCode ↔ Mattermost

### 2.1 Connection Flow

```
1. User starts OpenCode session
   ↓
2. Plugin auto-connects to Mattermost (if MATTERMOST_AUTO_CONNECT=true)
   ↓
3. WebSocket establishes real-time connection
   ↓
4. OpenCodeSessionRegistry discovers available sessions
   ↓
5. ThreadManager creates dedicated thread for each session
   ↓
6. User sends DM → Plugin routes to correct session
   ↓
7. OpenCode processes prompt asynchronously
   ↓
8. ResponseStreamer delivers chunks to Mattermost thread
```

### 2.2 Data Flow: DM → OpenCode → Response

```
User DM in Mattermost
    ↓
WebSocketClient receives event
    ↓
MessageRouter determines:
    - Is this a command (!sessions, !models, etc)?
    - Is this a prompt for a session?
    - Is this a response to a pending question?
    - Is this a guest approval?
    ↓
Route Type Determined:
    - main_dm_command → CommandHandler
    - main_dm_prompt → Create new session
    - thread_prompt → Send to OpenCode session
    - question_response → QuestionHandler
    - guest_approval → GuestApprovalHandler
    ↓
For thread_prompt:
    - Build context (if group DM)
    - Process file attachments
    - Inject into OpenCode session
    ↓
OpenCode processes asynchronously
    ↓
ResponseStreamer listens for:
    - message.updated events
    - message.part.updated events
    - tool execution events
    - todo updates
    ↓
Chunks delivered to Mattermost thread
    ↓
User sees real-time response
```

### 2.3 Key Integration Points

#### A. WebSocket Event Handling
```typescript
// Plugin listens for these Mattermost events:
- posted_event: New message in DM/channel
- post_edited: Message edited (for retry/correction)
- reaction_added: Emoji reactions (✅/❌/🛑/🔁/🗑️)
- user_added: User joined channel
- channel_created: New channel created
```

#### B. OpenCode Event Handling
```typescript
// Plugin listens for these OpenCode events:
- permission.asked: Session needs permission approval
- question.asked: Session asking clarification question
- session.idle: Session finished, waiting for input
- session.status: Status updates (busy, retrying, etc)
- session.compacted: Session history compacted
- message.updated: Response text updated
- message.part.updated: Streaming response chunk
- file.edited: File created/modified
- todo.updated: Todo list changed
- tool.execute.before: Tool about to execute
- tool.execute.after: Tool execution completed
```

#### C. HTTP API Integration
```typescript
// Plugin calls OpenCode HTTP API:
POST /session                    // Create new session
GET  /session/{id}/status        // Check session status
POST /session/{id}/prompt        // Send prompt
GET  /session/{id}/messages      // Fetch message history
POST /question/{id}/reply        // Answer pending question
```

---

## 3. Remote Control Capabilities

### 3.1 Available Tools (14 total)

| Tool | Purpose | Parameters |
|------|---------|------------|
| `mattermost_connect` | Establish Mattermost connection | None (uses env vars) |
| `mattermost_disconnect` | Terminate connection | None |
| `mattermost_status` | Check connection state | None |
| `mattermost_list_sessions` | List all available sessions | None |
| `mattermost_select_session` | Switch to specific session | sessionId, mattermostUserId |
| `mattermost_current_session` | Show current session | mattermostUserId (optional) |
| `mattermost_monitor` | Monitor session for events | sessionId, targetUser, persistent |
| `mattermost_unmonitor` | Stop monitoring | sessionId |
| `mattermost_send_file` | Upload file to thread | filePath, message |
| `mattermost_schedule_add` | Create scheduled task | name, cron, prompt, timezone |
| `mattermost_schedule_list` | List scheduled tasks | None |
| `mattermost_schedule_remove` | Delete scheduled task | name |
| `mattermost_schedule_enable` | Enable disabled task | name |
| `mattermost_schedule_disable` | Disable task | name |
| `mattermost_schedule_run` | Run task immediately | name |

### 3.2 User Commands (via DM)

| Command | Description | Example |
|---------|-------------|---------|
| `!sessions` | List all sessions with thread links | `!sessions` |
| `!use <id>` | Switch to specific session | `!use ses_abc123` |
| `!current` | Show current session | `!current` |
| `!models` | List available models, select by number | `!models` → `1` |
| `!model` | Show current model for session | `!model` |
| `!costs` | Show token usage and costs | `!costs` |
| `!stop` | Cancel current operation | `!stop` |
| `!merge <url>` | Merge another thread's context | `!merge https://...` |
| `!reject` | Skip pending question | `!reject` |
| `!help` | Show available commands | `!help` |

### 3.3 Emoji Commands (React to bot messages)

| Emoji | Action | Use Case |
|-------|--------|----------|
| ✅ | Approve pending permission | Grant access to guest user |
| ❌ | Deny pending permission | Reject guest access |
| 🛑 | Cancel current operation | Stop long-running task |
| 🔁 | Retry last prompt | Rerun failed operation |
| 🗑️ | Clear session files | Clean up temporary files |

---

## 4. Session Management Architecture

### 4.1 Thread-Per-Session Model

**Problem Solved**: Without thread isolation, multiple sessions would pollute the same DM conversation, making it impossible to track which response belongs to which session.

**Solution**: Each OpenCode session gets its own dedicated Mattermost thread.

```
Main DM Channel
├── !sessions command
├── !help command
└── [Thread 1] Session A (ses_abc123)
    ├── User: "Create a REST API"
    ├── Bot: [Streaming response...]
    ├── User: "Add authentication"
    └── Bot: [Streaming response...]
└── [Thread 2] Session B (ses_def456)
    ├── User: "Fix the bug"
    ├── Bot: [Streaming response...]
    └── User: "Run tests"
```

### 4.2 ThreadMappingStore (Persistence)

Stores mappings between Mattermost threads and OpenCode sessions:

```typescript
interface ThreadSessionMapping {
  sessionId: string;              // OpenCode session ID
  threadRootPostId: string;       // Mattermost thread root post ID
  shortId: string;                // First 8 chars of session ID
  mattermostUserId: string;       // User who owns this session
  dmChannelId: string;            // DM channel ID
  channelId: string;              // Actual channel (DM or group/public/private)
  projectName: string;            // Project name
  directory: string;              // Working directory
  sessionTitle: string;           // Session title
  status: "active" | "ended" | "orphaned" | "merged";
  createdAt: string;              // ISO timestamp
  lastActivityAt: string;         // ISO timestamp
  model?: { providerID: string; modelID: string };  // Selected model
  approveAllUsers?: boolean;      // Guest approval policy
  approveNextMessage?: boolean;   // One-time approval
  approvedUsers?: string[];       // Pre-approved user IDs
  mergedInto?: string;            // If merged, which session
  endedAt?: string;               // When session ended
}
```

**Persistence**: Stored in `~/.config/opencode/thread-mappings.json`

### 4.3 Session Lifecycle

```
1. CREATE
   - User sends DM or @mentions bot in channel
   - ThreadManager creates new OpenCode session
   - ThreadManager creates Mattermost thread root post
   - ThreadMappingStore records mapping

2. ACTIVE
   - User sends prompts in thread
   - MessageRouter routes to correct session
   - ResponseStreamer delivers responses
   - ThreadMappingStore updates lastActivityAt

3. IDLE
   - Session finishes processing
   - MonitorService sends alert if monitoring enabled
   - User can send new prompt to continue

4. ENDED
   - User closes OpenCode session
   - ThreadManager marks thread as ended
   - New prompts in thread are rejected with guidance

5. MERGED
   - User runs !merge command
   - MergeHandler summarizes source thread
   - Context injected into destination thread
   - Source thread marked as merged (locked)
```

### 4.4 Multi-User Session Isolation

**Owner Filtering**: Each OpenCode instance can be configured to only respond to a specific user:

```bash
# User A's environment
export MATTERMOST_OWNER_USER_ID="user_a_id"

# User B's environment
export MATTERMOST_OWNER_USER_ID="user_b_id"

# Same bot account, different instances, isolated sessions
```

**Guest Approval**: In shared channels, non-owner users must be approved:

```
1. User A (owner) creates session by @mentioning bot
2. User B @mentions bot in same thread
3. Bot posts approval request to User A
4. User A replies: 1 (once), 2 (user), or 3 (all)
5. If approved, User B's message is processed
```

---

## 5. Notification & Alerting Features

### 5.1 Session Monitoring

**Purpose**: Get DM alerts when sessions need attention without staying connected.

```typescript
// Start monitoring
mattermost_monitor(sessionId="ses_abc123", targetUser="alice")

// Alerts sent for:
- Permission requested: "Session waiting for permission approval"
- Question asked: "Session asking clarification question"
- Session idle: "Session finished, waiting for input"
```

**Alert Format**:
```
🔔 OpenCode Session Alert

Project: my-awesome-app
Session: ses_abc1 - Building REST API
Directory: /home/user/projects/my-awesome-app

⏳ Alert: Session is idle (waiting for input)

Use `!use ses_abc1` in DM to connect to this session.
```

### 5.2 Notification Service

Sends notifications for:
- ✅ Completion: "Session finished successfully"
- ❌ Errors: "Session encountered an error"
- ⏳ Status: "Session is processing..."
- 🔔 Permission: "Session needs permission approval"

**Configuration**:
```bash
export OPENCODE_MM_NOTIFY_COMPLETION="true"
export OPENCODE_MM_NOTIFY_PERMISSION="true"
export OPENCODE_MM_NOTIFY_ERROR="true"
export OPENCODE_MM_NOTIFY_STATUS="true"
```

### 5.3 Real-time Status Display

**Status Indicator** shows:
- 💻 Processing state with elapsed time: `💻 Processing... (15s)`
- 🔧 Tool execution: `🔧 Running bash command (3s)`
- 💰 Cost tracking: `💰 $0.45 (+$0.03) | 125K tok`
- 📝 Todo progress: `📝 3/5 tasks completed`

---

## 6. Advanced Features

### 6.1 File Path Completion (`!!`)

**Feature**: Reference files directly in prompts using `!!` prefix.

```
User: Look at !!src/config and tell me what settings are available
Bot: [Finds src/config.ts, includes content, responds]
```

**Implementation**:
- FileCompletionHandler scans project for matching files
- Fuzzy matching if multiple matches
- User selects from options
- File content injected into prompt

### 6.2 Thread Merging

**Feature**: Merge context from one thread into another.

```
User: !merge https://mattermost.dev.hyperplane.dev/shakudo/pl/abc123xyz
Bot: [Summarizes source thread with AI, injects into destination]
```

**Process**:
1. MergeHandler fetches source thread messages
2. Claude Haiku summarizes conversation
3. Summary injected into destination thread
4. Source thread marked as merged (locked)

### 6.3 Group DM Context Injection

**Feature**: In group DMs, bot automatically includes context from recent messages.

```
Alice: Hey team, I'm seeing a weird error in the logs
Bob: Can you paste the stack trace?
Alice: [pastes error]
You: @opencode-bot can you explain what's causing this?
Bot: [Reads context from Alice/Bob, responds with full understanding]
```

**Implementation**:
- ContextBuilder reads last 5 messages
- If >8K chars, summarizes with Claude Haiku
- Context injected as prefix to prompt
- Preserves conversation flow

### 6.4 Scheduled Tasks (Cron)

**Feature**: Automate recurring prompts with cron expressions.

```bash
mattermost_schedule_add \
  name="morning-status" \
  cron="0 9 * * *" \
  prompt="Give me a summary of pending PRs" \
  timezone="America/New_York"
```

**Implementation**:
- SchedulerService uses node-cron
- ScheduleStore persists in `~/.config/opencode/schedules.json`
- Runs in background, sends results via DM
- Supports enable/disable/run-now operations

### 6.5 Question Tool Support

**Feature**: When OpenCode asks clarification questions, they appear in Mattermost with numbered options.

```
### ❓ Language

Which language would you like to use?

**1.** TypeScript - Modern JavaScript with types
**2.** Python - Great for data science
**3.** Other - Type your own answer

---
Reply with a number or type your answer
Use `!reject` to skip this question
```

**Implementation**:
- QuestionHandler intercepts question.asked events
- Formats options as numbered list
- Listens for user reply
- Submits answer back to OpenCode via HTTP API

---

## 7. Component Breakdown

### 7.1 Clients Layer

| Component | Responsibility |
|-----------|-----------------|
| **MattermostClient** | HTTP API client for posts, channels, files, reactions |
| **WebSocketClient** | Real-time event streaming for instant message detection |

### 7.2 Persistence Layer

| Component | Responsibility |
|-----------|-----------------|
| **ThreadMappingStore** | Persists thread-to-session mappings with indexes |
| **ScheduleStore** | Persists cron-based scheduled tasks |
| **TeamStore** | Caches team information for performance |

### 7.3 Routing & Message Handling

| Component | Responsibility |
|-----------|-----------------|
| **MessageRouter** | Routes messages to correct sessions based on thread context |
| **CommandHandler** | Processes `!commands` for session management |
| **ReactionHandler** | Emoji-based command execution (✅/❌/🛑/🔁/🗑️) |

### 7.4 Session Management

| Component | Responsibility |
|-----------|-----------------|
| **SessionManager** | Per-user session tracking with timeout management |
| **OpenCodeSessionRegistry** | Discovers and tracks all available OpenCode sessions |
| **ThreadManager** | Creates and manages session threads, handles lifecycle |

### 7.5 Response Delivery

| Component | Responsibility |
|-----------|-----------------|
| **ResponseStreamer** | Chunked message delivery to correct thread |
| **StatusIndicator** | Real-time status display with timing |
| **NotificationService** | Completion, error, and status notifications |

### 7.6 Advanced Features

| Component | Responsibility |
|-----------|-----------------|
| **FileHandler** | Inbound/outbound file attachment processing |
| **FileCompletionHandler** | `!!` file path completion with fuzzy matching |
| **QuestionHandler** | AI question tool support with user responses |
| **GuestApprovalHandler** | Cross-user approval for shared channel sessions |
| **SessionOwnershipHandler** | Ownership confirmation for group DM sessions |
| **MergeHandler** | Thread merging with AI summarization |
| **ContextBuilder** | Builds thread context for group DMs with optional Haiku summarization |
| **MonitorService** | Session event monitoring and DM alerts |
| **SchedulerService** | Cron-based scheduled task execution |
| **TodoManager** | Todo list tracking during operations |

---

## 8. Configuration & Deployment

### 8.1 Environment Variables

**Required**:
```bash
MATTERMOST_TOKEN="bot-access-token"
MATTERMOST_URL="https://mattermost.example.com/api/v4"
```

**Optional**:
```bash
# Connection
MATTERMOST_WS_URL="wss://mattermost.example.com/api/v4/websocket"
MATTERMOST_AUTO_CONNECT="true"
MATTERMOST_RECONNECT_INTERVAL="5000"
MATTERMOST_MAX_RECONNECT_ATTEMPTS="10"

# Streaming
OPENCODE_MM_BUFFER_SIZE="50"
OPENCODE_MM_MAX_DELAY="500"
OPENCODE_MM_EDIT_RATE_LIMIT="10"
OPENCODE_MM_MAX_POST_LENGTH="15000"

# Sessions
OPENCODE_MM_SESSION_TIMEOUT="3600000"
OPENCODE_MM_MAX_SESSIONS="50"
OPENCODE_MM_AUTO_CREATE_SESSION="true"
OPENCODE_MM_ALLOWED_CHANNEL_TYPES="D,G,O,P"

# Multi-user
MATTERMOST_OWNER_USER_ID=""  # For owner filtering

# Files
OPENCODE_MM_MAX_FILE_SIZE="10485760"
OPENCODE_MM_ALLOWED_EXTENSIONS="*"

# Notifications
OPENCODE_MM_NOTIFY_COMPLETION="true"
OPENCODE_MM_NOTIFY_PERMISSION="true"
OPENCODE_MM_NOTIFY_ERROR="true"
OPENCODE_MM_NOTIFY_STATUS="true"
```

### 8.2 Installation

```bash
# Global install
bun add -g opencode-mattermost-control

# Or from source
git clone https://github.com/Shakudo-io/opencode-mattermost-plugin.git
cd opencode-mattermost-plugin
bun install
```

### 8.3 Multi-Session Setup

For controlling multiple sessions in parallel, use shared server mode:

```bash
# Terminal 1: Start shared server
opencode serve --port 4096

# Terminal 2: Attach first TUI
cd /path/to/project-a
opencode attach http://localhost:4096

# Terminal 3: Attach second TUI
cd /path/to/project-b
opencode attach http://localhost:4096
```

Helper script:
```bash
./opencode-shared  # Auto-manages shared server
```

---

## 9. Security & Safety Features

### 9.1 Owner Filtering

Prevents unauthorized access when sharing bot account:

```bash
export MATTERMOST_OWNER_USER_ID="user_id_here"
# Only this user's DMs are processed
```

### 9.2 Guest Approval Workflow

In shared channels, non-owners must be approved:

```
1. Owner creates session
2. Guest @mentions bot
3. Owner approves (once, user, or all)
4. Guest message processed
```

### 9.3 Session Ownership Confirmation

In group DMs/channels, bot confirms ownership:

```
Bot: "This will create a new OpenCode session. Confirm?"
User: "yes"
Bot: [Creates session]
```

### 9.4 File Size Limits

```bash
OPENCODE_MM_MAX_FILE_SIZE="10485760"  # 10MB default
OPENCODE_MM_ALLOWED_EXTENSIONS="*"    # Configurable
```

---

## 10. Performance Optimizations

### 10.1 Intelligent Buffering

ResponseStreamer buffers responses before posting:
- Waits for 50 characters (configurable)
- Or 500ms timeout (configurable)
- Reduces API calls, improves readability

### 10.2 Message Splitting

Large responses split into multiple posts:
- Max 15,000 chars per post (configurable)
- Maintains thread continuity
- Prevents Mattermost API limits

### 10.3 Context Summarization

Group DM context automatically summarized if >8K chars:
- Uses Claude Haiku for speed
- Preserves key information
- Reduces token usage

### 10.4 Session Timeout Management

```bash
OPENCODE_MM_SESSION_TIMEOUT="3600000"  # 1 hour
# Inactive sessions cleaned up automatically
```

---

## 11. Troubleshooting & Debugging

### 11.1 Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Bot not responding | Wrong MATTERMOST_OWNER_USER_ID | Verify user ID in Mattermost profile |
| WebSocket disconnects | Network issues | Check connectivity, auto-reconnect will retry |
| Plugin not loading | OpenCode version incompatibility | Downgrade to v1.1.28 |
| Messages not appearing | Bot not in channel | Add bot to channel, @mention it |
| Permission errors | Bot lacks permissions | Grant post/read/upload permissions |

### 11.1 Logging

```bash
tail -f /tmp/opencode-mattermost-plugin.log
```

**Log levels**:
- `[Plugin]` - Plugin lifecycle
- `[ThreadManager]` - Thread creation/management
- `[MessageRouter]` - Message routing decisions
- `[ResponseStreamer]` - Response delivery
- `[QuestionHandler]` - Question handling
- `[GuestApproval]` - Guest approval workflow
- `[FileCompletion]` - File path completion

---

## 12. Integration Capabilities Summary

### 12.1 What Kaji Can Do

✅ **Remote Control**
- Send prompts to OpenCode via Mattermost DM
- Control multiple sessions in parallel
- Switch between sessions with `!use`

✅ **Real-time Collaboration**
- Stream responses in real-time
- Share files through Mattermost
- Get alerts when sessions need attention

✅ **Advanced Session Management**
- Thread-per-session isolation
- Guest approval for shared channels
- Session monitoring without staying connected

✅ **Automation**
- Scheduled tasks with cron expressions
- Emoji-based quick commands
- File path completion with `!!`

✅ **Team Collaboration**
- Multi-user support with owner filtering
- Group DM context injection
- Thread merging for conversation continuity

### 12.2 What Kaji Cannot Do

❌ **Direct Code Execution**: Kaji doesn't execute code, it routes prompts to OpenCode
❌ **Persistent State**: Sessions are tied to OpenCode server lifecycle
❌ **Cross-Workspace**: One bot per Mattermost instance
❌ **Offline Operation**: Requires active Mattermost and OpenCode connection

---

## 13. Conclusion

The OpenCode Mattermost Control Plugin (Kaji) represents a sophisticated integration between two powerful systems:

1. **OpenCode**: AI-powered coding assistant with session management
2. **Mattermost**: Team communication platform with extensibility

**Key Strengths**:
- Thread-per-session architecture enables clean multi-session management
- Real-time streaming provides responsive user experience
- Comprehensive permission/approval workflows ensure safety
- Flexible configuration supports diverse deployment scenarios

**Use Cases**:
- Remote code development from Mattermost
- Team collaboration on coding tasks
- Automated code generation and refactoring
- Scheduled code analysis and reporting
- Multi-developer parallel session management

**Future Enhancements**:
- Persistent session state across OpenCode restarts
- Advanced analytics and reporting
- Custom command extensions
- Integration with other chat platforms

---

**Document Generated**: February 2, 2026  
**Plugin Repository**: https://github.com/Shakudo-io/opencode-mattermost-plugin  
**License**: MIT
