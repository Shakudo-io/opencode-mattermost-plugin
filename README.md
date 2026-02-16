# OpenCode Mattermost Control Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/opencode-mattermost-control.svg)](https://www.npmjs.com/package/opencode-mattermost-control)

Control [OpenCode](https://opencode.ai) remotely via Mattermost direct messages. Send prompts to your OpenCode session by messaging a bot user, and receive real-time streaming responses.

---

## Changelog

- **0.3.98** — Delegation now requires explicit `!@owner` syntax (e.g., `@kaji !@christine fix this`); plain `@kaji @person` no longer triggers delegation
- **0.3.97** — Hardened delegation access control (team membership required, early mention parsing), switched merge summarization to Gemini 3 Flash
- **0.3.95** — Delegation requires team membership; owner tagging `@kaji @other_user` stays silent for other Kaji to handle
- **0.3.94** — Teammate delegated sessions: tag `@kaji` + `@owner` to start a session on behalf of the owner

---

## Features

### Core Features
- **Thread-Per-Session**: Each OpenCode session automatically gets its own dedicated Mattermost thread for clean conversation isolation
- **Remote Control**: Send prompts to OpenCode via Mattermost DMs
- **Bi-directional TUI Sync**: Messages typed in the OpenCode TUI appear in Mattermost, and assistant responses stream back - full conversation visibility regardless of where you interact
- **Multi-Session Management**: Control multiple OpenCode sessions in parallel via separate threads
- **Session Monitoring**: Get DM alerts when sessions need attention (permission requests, idle, questions)
- **Real-time Streaming**: Responses stream back in chunks with intelligent buffering
- **File Attachments**: Send and receive files through Mattermost
- **Automatic Reconnection**: WebSocket auto-reconnects with exponential backoff

### Real-time Status Display
- **Enhanced Status Indicator**: Shows processing state with elapsed time (e.g., `💻 Processing... (15s)`)
- **Tool Execution Display**: See which tools are being executed in real-time with timing
- **Live Shell Output**: Bash command output streams directly to Mattermost as it executes
- **Todo List Tracking**: View task progress during complex multi-step operations
- **Cost & Token Tracking**: Monitor LLM costs and token usage per session (e.g., `💰 $0.45 (+$0.03) | 125K tok`)

### Model Selection
- **Per-Session Model Switching**: Use `!models` to list available models, select by number
- **Model Persistence**: Selected model persists for the session thread
- **Multi-Provider Support**: Switch between providers (Anthropic, OpenAI, etc.) on the fly

### Multi-User Support
- **Owner Filtering**: Set `MATTERMOST_OWNER_USER_ID` to ensure your OpenCode instance only responds to your DMs
- **Shared Bot Account**: Multiple users can run separate OpenCode instances with the same bot
- **Per-User Sessions**: Each user's sessions are isolated

### Channel Support (Group DMs, Public & Private Channels)
- **Any Channel Type**: Bot works in 1:1 DMs, Group DMs, Public channels (`O`), and Private channels (`P`)
- **Selective Response**: In channels (non-1:1 DM), the bot only responds when explicitly @mentioned (e.g., `@opencode-bot help me with this`)
- **Thread Context Injection**: When responding in channels, the bot automatically includes context from the last 5 messages in the thread
- **Smart Context Summarization**: If thread context exceeds 8K characters, it's automatically summarized using Claude Haiku to stay within token limits
- **1:1 DM Behavior Unchanged**: Direct messages respond to all messages without requiring @mention
- **Configurable Channel Types**: Use `OPENCODE_MM_ALLOWED_CHANNEL_TYPES` to restrict which channel types the bot responds to

### Emoji Commands
React to any bot message with these emojis:
- ✅ Approve pending permission
- ❌ Deny pending permission  
- 🛑 Cancel current operation
- 🔁 Retry last prompt
- 🗑️ Clear session files

### Notifications
- Get notified on completion, errors, and status changes

---

## Quick Start for Humans

### Prerequisites

- [OpenCode](https://opencode.ai) installed and configured
- A Mattermost instance with API access
- A Mattermost bot account with appropriate permissions
- [Bun](https://bun.sh) runtime (recommended) or Node.js 18+

### Step 1: Install the Plugin

```bash
# Using bun (recommended)
bun add -g opencode-mattermost-control

# Or using npm
npm install -g opencode-mattermost-control
```

### Step 2: Create a Mattermost Bot

1. Go to your Mattermost **System Console** → **Integrations** → **Bot Accounts**
2. Click **Add Bot Account**
3. Give it a username (e.g., `opencode-bot`) and description
4. Copy the generated **Access Token** - you'll need this!

### Step 3: Set Environment Variables

```bash
export MATTERMOST_TOKEN="your-bot-access-token"
export MATTERMOST_URL="https://your-mattermost-instance.com/api/v4"
```

### Step 4: Connect from OpenCode

```bash
# Start OpenCode in your project
opencode

# Then type or use the tool:
mattermost_connect
```

You should see:
```
✓ Connected to Mattermost as @opencode-bot
✓ Listening for DMs
✓ Project: your-project-name
```

### Step 5: Send Prompts via DM

Open Mattermost, find your bot user, and send it a direct message:
```
Create a hello world function in Python
```

The response will stream back in real-time!

---

## Quick Start for AI Agents

If you're an AI agent setting up this plugin, follow these steps:

### 1. Install

```bash
bun add -g opencode-mattermost-control
```

### 2. Configure Environment

Set these environment variables before starting OpenCode:

```bash
export MATTERMOST_TOKEN="<bot-access-token>"
export MATTERMOST_URL="https://<mattermost-host>/api/v4"
```

### 3. Connect

Use the `mattermost_connect` tool to establish connection:

```
mattermost_connect
```

### 4. Verify Connection

Use `mattermost_status` to confirm the connection is active.

### 5. Available Tools

| Tool | Purpose |
|------|---------|
| `mattermost_connect` | Establish connection to Mattermost |
| `mattermost_disconnect` | Terminate connection |
| `mattermost_status` | Check connection state |
| `mattermost_list_sessions` | List available OpenCode sessions |
| `mattermost_select_session` | Select which session receives prompts |
| `mattermost_current_session` | Show currently targeted session |
| `mattermost_monitor` | Monitor session for events (permission, idle, question) |
| `mattermost_unmonitor` | Stop monitoring a session |
| `mattermost_send_file` | Upload a file to the current Mattermost thread |
| `mattermost_schedule_add` | Create a scheduled task with cron expression |
| `mattermost_schedule_list` | List all scheduled tasks |
| `mattermost_schedule_remove` | Delete a scheduled task |
| `mattermost_schedule_enable` | Enable a disabled scheduled task |
| `mattermost_schedule_disable` | Disable a scheduled task |
| `mattermost_schedule_run` | Run a scheduled task immediately |

### 6. Handling DMs

Once connected, DMs to the bot are processed as follows:

**Prompt Format:**
```
[Mattermost DM from @username]
[Reply-To: thread=abc123 post=xyz789 channel=dm_channel_id]
<user's message>
```

The `Reply-To` line provides context for agents with other Mattermost integrations (MCP servers, direct API) to reply to the correct thread.

**Auto-Session Creation:**
When a user sends a prompt in the main DM channel (not in a thread), a new OpenCode session is automatically created with its own dedicated thread. This makes the main DM the "new session launcher" - use threads to continue existing sessions. This can be disabled with `OPENCODE_MM_AUTO_CREATE_SESSION=false`.

### 7. Session Commands

Users can send these commands via DM to manage sessions:
- `!sessions` - List all available OpenCode sessions
- `!use <id>` - Switch to a specific session
- `!current` - Show currently selected session
- `!models` - List available models and select one for the current session
- `!model` - Show the currently selected model for this session
- `!team` - Show team status; `!team add @user` / `!team remove @user` / `!team list`
- `!help` - Show available commands

---

## Installation Options

### Option A: Global Install (Recommended)

```bash
# Install globally with bun
bun add -g opencode-mattermost-control

# Or with npm
npm install -g opencode-mattermost-control
```

### Option B: From Source

```bash
git clone https://github.com/Shakudo-io/opencode-mattermost-plugin.git
cd opencode-mattermost-plugin
bun install
```

### Option C: Per-Project

Add to your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-mattermost-control"]
}
```

---

## Configuration Reference

### Environment Variables

```bash
# Required
export MATTERMOST_TOKEN="your-bot-access-token"
export MATTERMOST_URL="https://your-mattermost-instance.com/api/v4"

# Optional (with defaults)
export MATTERMOST_WS_URL="wss://your-mattermost-instance.com/api/v4/websocket"
export MATTERMOST_TEAM="your-team-name"
export MATTERMOST_DEBUG="false"
export MATTERMOST_AUTO_CONNECT="true"            # auto-connect on plugin load

# Advanced options
export MATTERMOST_RECONNECT_INTERVAL="5000"      # ms between reconnect attempts
export MATTERMOST_MAX_RECONNECT_ATTEMPTS="10"   # max reconnection tries

# Streaming configuration
export OPENCODE_MM_BUFFER_SIZE="50"              # characters before flushing
export OPENCODE_MM_MAX_DELAY="500"               # max ms before forced flush
export OPENCODE_MM_EDIT_RATE_LIMIT="10"          # max edits per second
export OPENCODE_MM_MAX_POST_LENGTH="15000"       # max chars before splitting into multiple posts

# Session configuration
export OPENCODE_MM_SESSION_TIMEOUT="3600000"     # 1 hour in ms
export OPENCODE_MM_MAX_SESSIONS="50"             # max concurrent sessions
export OPENCODE_MM_ALLOWED_USERS=""              # comma-separated user IDs (empty = all)
export OPENCODE_MM_AUTO_CREATE_SESSION="true"    # auto-create session from main DM
export OPENCODE_MM_ALLOWED_CHANNEL_TYPES="D,G,O,P"  # allowed channel types (D=DM, G=Group, O=Public, P=Private)
export OPENCODE_MM_DEFAULT_CHANNEL_ID=""         # Channel ID for bi-directional TUI sync
                                                 # When set, TUI messages sync to Mattermost threads

# Multi-user / Owner filtering
export MATTERMOST_OWNER_USER_ID=""               # Only respond to DMs from this user ID
                                                 # Allows multiple OpenCode instances to share one bot

# File handling
export OPENCODE_MM_TEMP_DIR="/tmp/opencode-mm-plugin"
export OPENCODE_MM_MAX_FILE_SIZE="10485760"      # 10MB
export OPENCODE_MM_ALLOWED_EXTENSIONS="*"        # comma-separated or * for all

# Notifications
export OPENCODE_MM_NOTIFY_COMPLETION="true"
export OPENCODE_MM_NOTIFY_PERMISSION="true"
export OPENCODE_MM_NOTIFY_ERROR="true"
export OPENCODE_MM_NOTIFY_STATUS="true"

# Logging
export MM_PLUGIN_LOG_FILE="/tmp/opencode-mattermost-plugin.log"

# PostgreSQL State Management (Multi-Instance Support)
# Set OPENCODE_MM_POSTGRES_ENABLED=true to enable Postgres (disabled by default)
# See "Migrating to PostgreSQL" section below for full setup guide
export OPENCODE_MM_POSTGRES_ENABLED="false"      # Enable Postgres state management
export OPENCODE_MM_SUPABASE_URL=""               # Supabase/PostgREST URL
export OPENCODE_MM_SUPABASE_ANON_KEY=""          # Supabase anon key (JWT)
export OPENCODE_MM_SUPABASE_SCHEMA="opencode_mattermost"  # Database schema name
export OPENCODE_MM_MIGRATION_PHASE="1"           # Migration phase (1, 2, or 3)
export OPENCODE_MM_HEARTBEAT_INTERVAL="30000"    # Instance heartbeat interval (ms)
export OPENCODE_MM_DEAD_INSTANCE_TIMEOUT="90000" # Mark instance dead after (ms)
export OPENCODE_MM_CLAIM_DURATION="60000"        # Thread claim duration (ms)
```

### Storage Modes

The plugin supports two storage modes for persisting thread mappings, scheduled tasks, and other state:

#### Local JSON Files (Default)

By default, the plugin stores all state in local JSON files. **This is the recommended mode for single-instance deployments.**

**No configuration required** - just set the required Mattermost environment variables and the plugin will use local JSON files automatically.

Files are stored in `~/.config/opencode/`:
- `mattermost-threads.json` - Thread-to-session mappings
- `mattermost-schedules.json` - Scheduled tasks
- `mattermost-teams.json` - Team configuration

**Advantages:**
- Zero setup required
- No external dependencies
- Works offline
- Simple debugging (just read the JSON files)

**When to use:**
- Single OpenCode instance
- Development/testing
- Personal use
- When you don't need cross-instance coordination

#### PostgreSQL State Management (Multi-Instance)

For multi-instance deployments (multiple OpenCode instances sharing the same Mattermost bot), enable PostgreSQL-backed state management.

**To enable:**
```bash
export OPENCODE_MM_POSTGRES_ENABLED="true"
export OPENCODE_MM_SUPABASE_URL="https://your-project.supabase.co"
export OPENCODE_MM_SUPABASE_ANON_KEY="your-anon-key"
```

**Benefits:**
- Thread mappings shared across instances
- Scheduled tasks with single-execution guarantee (leader election)
- Team configuration sharing
- Graceful degradation to local JSON if database unavailable

**Migration Phases:**

| Phase | Description | Behavior |
|-------|-------------|----------|
| **1** | Dual-write (default) | Write to both JSON and Postgres, read from JSON |
| **2** | Migration | Write to both, read from Postgres (with JSON fallback) |
| **3** | Postgres-only | Postgres is primary, JSON only for degraded mode |

**When to use:**
- Multiple OpenCode instances sharing one bot
- Production deployments requiring high availability
- Team environments with shared scheduled tasks

See [Migrating to PostgreSQL](#migrating-to-postgresql) for step-by-step setup.

### OpenCode Configuration

Add to global config (`~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["opencode-mattermost-control"]
}
```

Or per-project (`opencode.json` in project root):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-mattermost-control"]
}
```

---

## Usage Examples

### Basic Workflow

```bash
# 1. Start OpenCode
opencode

# 2. Connect to Mattermost
> mattermost_connect
✓ Connected to Mattermost as @your-bot
✓ Listening for DMs

# 3. Check status anytime
> mattermost_status

# 4. Disconnect when done
> mattermost_disconnect
```

### Thread-Per-Session Workflow

When the plugin connects, it automatically creates a dedicated Mattermost thread for each active OpenCode session. This provides clean conversation isolation and parallel session control.

**How it works:**
1. When a new OpenCode session starts, a thread is automatically created in your DM with the bot
2. The thread root post shows session info (project, directory, session ID)
3. Post in the thread to send prompts to that specific session
4. Responses stream back to the same thread
5. When the session ends, the thread is marked as ended

**Example:**
```
Bot: 🚀 OpenCode Session Started

     Project: my-awesome-app
     Directory: /home/user/projects/my-awesome-app
     Session: ses_abc1
     Started: 2024-01-15T10:30:00.000Z

     Reply in this thread to send prompts to this session.

You (in thread): List all TypeScript files
Bot (in thread): [Streaming response...]
```

**Main DM commands:**
- `!sessions` - List all sessions with links to their threads
- `!help` - Show available commands

**Thread behavior:**
- Prompts in main DM (outside threads) are rejected with guidance to use session threads
- Each thread maps to exactly one OpenCode session
- Thread posts are routed to the correct session automatically
- Ended sessions show a completion message and reject new prompts

### Bi-directional TUI Sync

Keep your Mattermost thread in sync with your TUI session. When you type in the OpenCode TUI, your messages and the assistant's responses automatically appear in Mattermost - perfect for maintaining a complete conversation history or collaborating with others.

**How it works:**
1. Messages you type in the TUI appear in Mattermost with a `:keyboard: **[TUI]**` prefix
2. Assistant responses stream to Mattermost just like Mattermost-originated conversations
3. Your Mattermost thread becomes a complete log of all interactions, regardless of where they originated

**Setup:**

Set the default channel where TUI-started sessions should create threads:

```bash
export OPENCODE_MM_DEFAULT_CHANNEL_ID="your-channel-id"
```

To find your channel ID:
- Open Mattermost in a browser
- Navigate to the channel you want to use (your DM with the bot works great)
- The channel ID is in the URL: `https://mattermost.example.com/.../channels/{channel-id}`
- Or use the Mattermost API: `GET /api/v4/users/me/channels`

**Example flow:**
```
[In your TUI]
You: What files are in this project?

[In Mattermost thread - appears automatically]
:keyboard: **[TUI]** What files are in this project?

Bot: Here are the files in your project:
     - src/index.ts
     - src/config.ts
     - package.json
     ...
```

**Notes:**
- TUI sync only works for sessions that have a mapped Mattermost thread
- If `OPENCODE_MM_DEFAULT_CHANNEL_ID` is set, new TUI sessions automatically get a thread created
- Messages from Mattermost that were forwarded to the TUI are not echoed back (no loops)

### Sending Files to Mattermost

OpenCode can send files directly to your Mattermost conversation thread using the `mattermost_send_file` tool:

**Example conversation:**
```
You (in thread): Create a Python script that generates a report and send it to me
Bot: [Creates the file using Write tool]
Bot: [Uses mattermost_send_file to upload report.py]
     File sent to Mattermost: report.py
```

The tool automatically posts the file to the correct thread. Users can simply ask:
- "Send me the file you just created"
- "Upload that script to Mattermost"
- "Give me the report.pdf"

**Supported file types:** All common types including code files, documents (PDF, MD, TXT), images (PNG, JPG, GIF), and archives (ZIP).

**Size limit:** 10MB by default (configurable via `OPENCODE_MM_MAX_FILE_SIZE`).

### Session Management Commands

When connected, you can manage multiple OpenCode sessions via DM commands:

| Command | Description |
|---------|-------------|
| `!sessions` | List all available OpenCode sessions with thread links |
| `!models` | List available models grouped by provider, select by number |
| `!model` | Show the currently selected model for this session |
| `!costs` | Show LLM token usage and costs for the current session |
| `!stop` | Cancel the current processing operation |
| `!merge <url>` | Merge another thread's conversation into the current session |
| `!reject` | Skip/cancel a pending AI question |
| `!team` | Show team status and settings |
| `!team add @user` | Add a teammate (can bypass guest approval, initiate delegation) |
| `!team remove @user` | Remove a teammate |
| `!team list` | List all current teammates |
| `!help` | Display available commands and thread workflow |

**Example:**
```
You: !sessions
Bot: 📋 Available Sessions (2)

     1. 🟢 my-awesome-app (ses_abc1) - 5m ago
        📁 /home/user/projects/my-awesome-app
        🔗 Thread: [Click to open]

     2. 🟢 another-project (ses_def2) - 2h ago
        📁 /home/user/projects/another-project
        🔗 Thread: [Click to open]

     Reply in a session thread to send prompts.
```

### Model Selection

Switch between different LLM models on a per-session basis:

```
You: !models
Bot: 🤖 Available Models

     Anthropic
       1. claude-sonnet-4-20250514
       2. claude-3-5-haiku-20241022

     OpenAI
       3. gpt-4o
       4. o3

     Reply with a number to select a model.

You: 1
Bot: ✅ Model set to claude-sonnet-4-20250514 (Anthropic) for this session.
```

The selected model persists for the session thread. Use `!model` to check the current selection.

### Cost Tracking

Monitor LLM token usage and costs for your session using the `!costs` command:

```
You: !costs
Bot: 💰 Session Costs (ses_abc1)

     Total Cost: $0.47
     Input Tokens: 125,432
     Output Tokens: 8,291
     
     Model: claude-sonnet-4-20250514
```

The status indicator also shows running costs during responses: `💰 $0.45 (+$0.03) | 125K tok`

### Thread Merging

Merge the context from one thread into another using the `!merge` command. This is useful when you want to continue a conversation from a different session thread while preserving its context.

**Usage:**
```
!merge https://mattermost.example.com/team/pl/postid123
```

**How it works:**
1. Copy the URL of the thread you want to merge (source thread)
2. Go to the thread you want to merge INTO (destination thread)
3. Type `!merge <url>` with the source thread URL
4. The source thread's conversation is summarized using AI and injected into the destination thread
5. The source thread is marked as "merged" and locked

**Example:**
```
[In destination thread]
You: !merge https://mattermost.dev.hyperplane.dev/shakudo/pl/abc123xyz

Bot: 🔀 **Merged Thread Context**

     Merged conversation from [my-project (ses_abc1)](link):

     ---
     
     **Summary:**
     - User requested implementation of a REST API for user management
     - Discussed authentication approach (JWT tokens)
     - Created User model with email, password, and role fields
     - TODO: Implement password hashing and token refresh
     
     ---
     _Merged by @alice at 2026-01-26 15:30_
```

**Source thread after merge:**
```
Bot: 🔒 **Thread Merged**

     This conversation has been merged into another thread.
     Continue the conversation [here](link).

     _Merged at 2026-01-26 15:30_
```

**Restrictions:**
- Can only merge threads from the same OpenCode instance
- Cannot merge a thread into itself
- Cannot merge an already-merged thread
- Must have an active session in the destination thread

**What gets preserved:**
- AI-generated summary of key decisions and context
- Requirements and constraints discussed
- Actions taken and their outcomes
- Unfinished work and next steps

### File Path Completion (`!!`)

Reference files directly in your prompts using the `!!` prefix. The bot will automatically find and include matching files from your project.

**Usage:**
```
You: Look at !!src/config and tell me what settings are available
Bot: [Finds src/config.ts or similar, includes content, then responds]
```

**How it works:**
1. Type `!!` followed by a partial file path (e.g., `!!src/resp`)
2. The bot searches for matching files in your project
3. If exact match: file content is automatically included
4. If multiple matches: bot prompts you to select from options

**Example with fuzzy matching:**
```
You: Check !!handler for bugs

Bot: 🔍 Multiple files match "handler". Select one or more:

     1. src/command-handler.ts
     2. src/file-handler.ts
     3. src/question-handler.ts
     4. src/reaction-handler.ts

     Reply with number(s) separated by commas (e.g., "1,3")

You: 1,2
Bot: [Includes both files and processes the original request]
```

**Notes:**
- `!!` references inside code blocks are ignored
- You can include multiple `!!` references in one message
- Works with partial paths and fuzzy matching

### Channel Usage (Group DMs, Public & Private Channels)

The bot can participate in any channel it's a member of: Group DMs, Public channels, and Private channels. In these channels, the bot uses **selective response** - it only responds when explicitly @mentioned.

**Supported channel types:**
- `D` - 1:1 Direct Messages (no @mention required)
- `G` - Group Direct Messages (@mention required)
- `O` - Public Channels (@mention required)
- `P` - Private Channels (@mention required)

**How it works:**
1. Add the bot to a channel (Group DM, public, or private channel)
2. @mention the bot when you want it to respond: `@opencode-bot explain this error`
3. The bot automatically includes context from recent messages in the thread
4. Messages without @mention are silently ignored

**Example:**
```
Alice: Hey team, I'm seeing a weird error in the logs
Bob: Can you paste the stack trace?
Alice: [pastes error]
You: @opencode-bot can you explain what's causing this NullPointerException?
Bot: [Responds with explanation, having read the context from Alice and Bob's messages]
```

**Context handling:**
- The bot reads the last 5 messages from the thread to understand the conversation
- If the context is too long (>8K characters), it's automatically summarized using Claude Haiku
- This ensures the bot has relevant context without consuming excessive tokens

**Restricting channel types:**
You can limit which channel types the bot responds to using the `OPENCODE_MM_ALLOWED_CHANNEL_TYPES` environment variable:
```bash
# Only allow DMs and Group DMs (no public/private channels)
export OPENCODE_MM_ALLOWED_CHANNEL_TYPES="D,G"

# Only allow DMs (default 1:1 behavior)
export OPENCODE_MM_ALLOWED_CHANNEL_TYPES="D"

# All channel types (default)
export OPENCODE_MM_ALLOWED_CHANNEL_TYPES="D,G,O,P"
```

**Note:** In regular 1:1 DMs, the bot responds to all messages without requiring @mention.

### Guest Approval in Channels

When multiple users are in a channel with the bot, each OpenCode instance only processes messages from its owner (the user who owns the session). If another user @mentions the bot, the thread owner must approve the request.

**How it works:**
1. User A (thread owner) creates a session by @mentioning the bot
2. User B @mentions the bot in the same thread: `@opencode-bot help me with this`
3. The bot posts an approval request visible to User A:
   ```
   🔔 Guest Access Request
   
   @userB wants to send a prompt to your session.
   
   **Options:**
   - Reply `1` to approve this message only
   - Reply `2` to approve @userB permanently for this thread
   - Reply `3` to approve ALL users in this thread
   - Reply `deny` to reject
   
   ⏰ Request expires in 30 minutes
   ```
4. User A replies with `1`, `2`, or `3`
5. If approved, the original message from User B is processed

**Approval options:**
- **1 (Once)**: Approve this single message, future messages from this user still require approval
- **2 (User)**: Permanently approve this user - their future @mentions are processed automatically
- **3 (All)**: Approve all users - any user in the channel can send prompts without approval

**Persistence:** User approvals (option 2) and "approve all" settings (option 3) are stored in the thread mapping and persist across sessions.

**Example flow:**
```
[Channel: #engineering with Alice, Bob, opencode-bot]

Alice: @opencode-bot analyze this code
Bot: [Creates session, responds to Alice]

Bob: @opencode-bot can you also check for security issues?
Bot: 🔔 Guest Access Request
     @bob wants to send a prompt to your session...
     Reply 1/2/3 or deny

Alice: 2
Bot: ✅ @bob is now approved for this thread.
Bot: [Processes Bob's request about security issues]

Bob: @opencode-bot what about performance?
Bot: [Processes automatically - Bob is pre-approved]
```

### Team Management

Manage who can interact with your Kaji instance using the `!team` commands in a DM with Kaji:

| Command | Description |
|---------|-------------|
| `!team add @username` | Add a teammate |
| `!team remove @username` | Remove a teammate |
| `!team list` | List all current teammates |
| `!team` | Show team status and settings |

**Access tiers:**

| Tier | Who | Can do |
|------|-----|--------|
| **Owner** | Set via `MATTERMOST_OWNER_USER_ID` | Full access — create sessions, manage team, approve guests |
| **Team members** | Added via `!team add` | Bypass guest approval, initiate delegated sessions, approve guests in threads |
| **Everyone else** | Anyone not above | Need per-session approval from owner or team member to use a session |

**Example:**
```
You: !team add @bonnie
Bot: ✅ @bonnie added to your team.

You: !team add @yiran
Bot: ✅ @yiran added to your team.

You: !team list
Bot: 👥 Team Members (2)
     1. @bonnie
     2. @yiran
```

### Teammate Delegation

Teammates can start sessions on behalf of the owner by using the **`!@` delegation syntax** — tagging Kaji and using `!@owner` in a channel where all three are members.

The `!@` prefix is deliberate opt-in. Plain `@mentions` of other users alongside `@kaji` do **not** trigger delegation, so casual conversation that happens to mention both won't accidentally start sessions.

**Usage:**
```
@kaji !@christine please fix the login bug on line 42
```

This creates a session **owned by @christine**, using her Kaji instance. The teammate is auto-approved and can keep sending prompts and approve others to collaborate in the thread.

**Session announcement:**
```
🚀 OpenCode Session Started

Owner: @christine
Started by: @bonnie
Project: my-project
Session: a1b2c3d4
```

**How each scenario is handled:**

| Who | Message | Result |
|-----|---------|--------|
| Team member | `@kaji !@owner` in shared channel | Delegated session created under owner's Kaji |
| Team member | `@kaji @owner` (without `!`) | No delegation — treated as normal @kaji mention |
| Team member | `@kaji` only (without owner) | Owner's Kaji stays silent; teammate's own Kaji may respond |
| Non-team-member | `@kaji !@owner` | Owner's Kaji does not respond (not a team member) |
| Owner | `@kaji` only | Standard session creation (ownership confirmation) |
| Owner | `@kaji !@another_user` | Owner's Kaji stays silent; other user's Kaji handles it |
| Anyone | `@kaji !@owner` in channel owner isn't in | Nothing happens |

### Multi-User Setup (Shared Bot)

When multiple users want to run separate OpenCode instances with the same Mattermost bot account, use owner filtering to prevent conflicts:

```bash
# User A's environment
export MATTERMOST_OWNER_USER_ID="user_a_id_here"

# User B's environment  
export MATTERMOST_OWNER_USER_ID="user_b_id_here"
```

Each OpenCode instance will only respond to DMs from its configured owner. To find your user ID, check your Mattermost profile or ask an admin.

### Emoji Commands

React to any bot message with these emojis:

| Emoji | Action |
|-------|--------|
| ✅ | Approve pending permission request |
| ❌ | Deny pending permission request |
| 🛑 | Cancel current operation |
| 🔁 | Retry the last prompt |
| 🗑️ | Clear session temporary files |

### AI Question Tool Support

When OpenCode uses the question tool to ask for clarification, the question appears directly in your Mattermost thread with numbered options:

```
### ❓ Language

Which language would you like to use?

**1.** TypeScript - _Modern JavaScript with types_
**2.** Python - _Great for data science_
**3.** Other - _Type your own answer_

---
_Reply with a number or type your answer_
_Use `!reject` to skip this question_
```

**How to respond:**
- Reply with a **number** (e.g., `1`) to select an option
- Reply with **multiple numbers** separated by commas for multi-select questions (e.g., `1, 3`)
- Type a **custom answer** directly (e.g., `Rust`)
- Use `!reject` or `!cancel` to skip the question (sends empty response to AI)

**Notes:**
- Questions expire after 30 minutes if not answered
- Only one question can be pending per session at a time
- Multi-question flows are supported (answer each question in sequence)

### Session Monitoring

Monitor OpenCode sessions and receive DM alerts when they need attention. Works without requiring an active Mattermost connection.

```bash
# Start monitoring the current session
> /mattermost-monitor

# Or use the tool directly
> mattermost_monitor targetUser="your-username"

# Stop monitoring
> mattermost_unmonitor
```

**Alert types:**
- **Permission requested** - Session is waiting for permission approval
- **Session idle** - Session finished and is waiting for input
- **Question asked** - Session is asking a clarifying question

**Example alert:**
```
🔔 OpenCode Session Alert

Project: business-automation
Session: ses_4426 - Mattermost plugin codebase review
Directory: /root/gitrepos/business-automation

⏳ Alert: Session is idle (waiting for input)

Use `!use ses_4426` in DM to connect to this session.
```

**Options:**
- `sessionId` - Monitor a specific session (defaults to current)
- `targetUser` - Mattermost username to notify (required if not connected)
- `persistent` - Keep monitoring after each alert (default: true). Set to false for one-time alerts.

### Scheduled Tasks

Create cron-based scheduled tasks that run prompts at specified times and DM you the results. Useful for automated reports, periodic checks, or recurring tasks.

**Available tools:**

| Tool | Description |
|------|-------------|
| `mattermost_schedule_add` | Create a new scheduled task |
| `mattermost_schedule_list` | List all scheduled tasks |
| `mattermost_schedule_remove` | Delete a scheduled task |
| `mattermost_schedule_enable` | Enable a disabled task |
| `mattermost_schedule_disable` | Disable a task without deleting |
| `mattermost_schedule_run` | Run a task immediately for testing |

**Example - Daily status report:**
```
> mattermost_schedule_add name="morning-status" cron="0 9 * * *" prompt="Give me a summary of pending PRs and open issues" timezone="America/New_York"

✅ Schedule created: morning-status
   Cron: 0 9 * * * (America/New_York)
   Next run: 2026-01-27 09:00:00
```

**Example - Periodic health check:**
```
> mattermost_schedule_add name="health-check" cron="0 */4 * * *" prompt="Check if all services are running and report any issues"

✅ Schedule created: health-check
   Cron: 0 */4 * * * (UTC)
   Next run: 2026-01-26 20:00:00
```

**Cron expression examples:**
- `0 9 * * *` - Every day at 9am
- `0 9,17 * * 1-5` - 9am and 5pm on weekdays
- `0 */4 * * *` - Every 4 hours
- `30 8 * * 1` - Every Monday at 8:30am

**Managing schedules:**
```
> mattermost_schedule_list
📋 Scheduled Tasks (2)

   1. ✅ morning-status
      Cron: 0 9 * * * (America/New_York)
      Next: 2026-01-27 09:00:00

   2. ✅ health-check
      Cron: 0 */4 * * * (UTC)
      Next: 2026-01-26 20:00:00

> mattermost_schedule_disable name="health-check"
✅ Schedule disabled: health-check

> mattermost_schedule_run name="morning-status"
🚀 Running schedule: morning-status
[Results are sent to your DM]
```

### Multi-Session Setup (Shared Server)

When controlling multiple OpenCode sessions via Mattermost, you need to run them on a **shared server** so that events (like incoming prompts) are visible across all TUIs.

**Why?** By default, each `opencode` command starts its own isolated server. Messages sent to one session won't appear in another session's TUI because they don't share the same event bus.

**Solution:** Use OpenCode's shared server mode:

#### Option 1: Manual Setup

```bash
# Terminal 1 - Start the shared server
opencode serve --port 4096

# Terminal 2 - Attach first TUI (run mattermost_connect here)
cd /path/to/project-a
opencode attach http://localhost:4096

# Terminal 3 - Attach second TUI
cd /path/to/project-b
opencode attach http://localhost:4096
```

#### Option 2: Using the Helper Script

A convenience script `opencode-shared` is provided that automatically manages the shared server:

```bash
# First run - starts server in background, then attaches TUI
./opencode-shared

# Subsequent runs - attaches to existing server
./opencode-shared

# With optional password for security
OPENCODE_SERVER_PASSWORD="your-secret" ./opencode-shared
```

The script:
- Checks if a shared server is already running on port 4096
- If not, starts one as a background process
- Attaches a TUI to the shared server
- Logs server output to `/tmp/opencode-server.log`

#### Restarting with Plugin Updates

Use `opencode-shared-restart` to restart OpenCode with optional plugin version changes:

```bash
# Restart with current plugin version
opencode-shared-restart

# Update plugin and restart
opencode-shared-restart -v 0.2.59

# Rollback to a previous version
opencode-shared-restart --rollback 0.2.55

# Check current installed version
opencode-shared-restart --current

# List available versions
opencode-shared-restart --list

# Check status of last restart (after reconnecting)
opencode-shared-restart --status
```

**How it works:**
The restart runs in a **detached background process** so it survives the OpenCode server restart. This is especially useful when an AI agent triggers the restart - the agent will be disconnected but the restart completes successfully.

After reconnecting to OpenCode, use `--status` to verify the restart succeeded:

```bash
$ opencode-shared-restart --status
=== Last Restart Status ===
Status: SUCCESS
Time: 2026-01-18T12:14:32+00:00
Plugin Version: 0.2.59
Message: Server running with v0.2.59
```

**Automatic rollback:** If the specified version fails to start, the script automatically attempts to restore the previous working version and start the server with that instead.

#### Security Note

For production use, set `OPENCODE_SERVER_PASSWORD` environment variable on both server and client:

```bash
export OPENCODE_SERVER_PASSWORD="your-secure-password"
opencode serve --port 4096

# In another terminal (same password required)
export OPENCODE_SERVER_PASSWORD="your-secure-password"
opencode attach http://localhost:4096
```

## Architecture

![Architecture Diagram](docs/architecture.png)

**Data Flow:**
1. User sends a DM to the bot in Mattermost
2. Plugin receives the message via WebSocket
3. Plugin forwards the prompt to OpenCode CLI
4. OpenCode processes and streams responses back
5. Plugin delivers chunked responses to Mattermost DM

### Components

| Component | Description |
|-----------|-------------|
| `MattermostClient` | HTTP API client for posts, channels, files, reactions |
| `WebSocketClient` | Real-time event streaming for instant message detection |
| `SessionManager` | Per-user session tracking with timeout management |
| `OpenCodeSessionRegistry` | Discovers and tracks all available OpenCode sessions |
| `ThreadManager` | Creates and manages session threads, handles lifecycle |
| `ThreadMappingStore` | Persists thread-to-session mappings with indexes |
| `MessageRouter` | Routes messages to correct sessions based on thread context |
| `CommandHandler` | Processes `!commands` for session management |
| `ResponseStreamer` | Chunked message delivery to correct thread |
| `NotificationService` | Completion, error, and status notifications |
| `FileHandler` | Inbound/outbound file attachment processing |
| `ReactionHandler` | Emoji-based command execution |
| `MonitorService` | Session event monitoring and DM alerts |
| `QuestionHandler` | AI question tool support with user responses |
| `ContextBuilder` | Builds thread context for group DMs, with optional Haiku summarization |
| `MergeHandler` | Thread merging with AI summarization and source thread locking |
| `FileCompletionHandler` | `!!` file path completion with fuzzy matching |
| `GuestApprovalHandler` | Cross-user approval for shared channel sessions |
| `SessionOwnershipHandler` | Ownership confirmation for group DM sessions |
| `SchedulerService` | Cron-based scheduled task execution |

## Project Structure

```
opencode-mattermost-plugin/
├── package.json
├── tsconfig.json
├── opencode.json
├── .opencode/
│   └── plugin/
│       └── mattermost-control/
│           ├── index.ts              # Main plugin entry point
│           └── package.json
└── src/
    ├── clients/
    │   ├── mattermost-client.ts      # HTTP API client
    │   └── websocket-client.ts       # WebSocket client
    ├── persistence/
    │   └── thread-mapping-store.ts   # Thread mapping persistence
    ├── models/
    │   ├── index.ts                  # TypeScript types
    │   ├── thread-mapping.ts         # Thread mapping Zod schemas
    │   └── routing.ts                # Message routing types
    ├── scheduler/
    │   ├── schedule-store.ts         # Schedule persistence
    │   └── scheduler-service.ts      # Cron job execution
    ├── command-handler.ts            # !command processing
    ├── config.ts                     # Configuration loading
    ├── context-builder.ts            # Group DM context building & summarization
    ├── file-completion-handler.ts    # !! file path completion
    ├── file-handler.ts               # File uploads/downloads
    ├── guest-approval-handler.ts     # Cross-user approval for channels
    ├── logger.ts                     # File-based logging
    ├── merge-handler.ts              # Thread merging with AI summarization
    ├── message-router.ts             # Thread-aware message routing
    ├── monitor-service.ts            # Session monitoring and alerts
    ├── notification-service.ts       # Status notifications
    ├── opencode-session-registry.ts  # OpenCode session discovery
    ├── question-handler.ts           # AI question tool responses
    ├── reaction-handler.ts           # Emoji reaction handling
    ├── response-streamer.ts          # Streams responses to MM
    ├── session-manager.ts            # User session management
    ├── session-ownership-handler.ts  # Group DM ownership confirmation
    ├── status-indicator.ts           # Real-time status display
    ├── thread-manager.ts             # Thread lifecycle management
    └── todo-manager.ts               # Todo list tracking
```

## Updating the Plugin

OpenCode caches plugins in `~/.config/opencode/node_modules/`. Simply running `bun add -g` or `npm install -g` does **not** update the running plugin. Follow these steps:

### Step 1: Update the Version Pin

Edit `~/.config/opencode/package.json` and update the version:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.1.21",
    "opencode-mattermost-control": "0.2.19"  // <- Update this version
  }
}
```

### Step 2: Clear the Cache

```bash
# Remove cached package and lockfile
rm -rf ~/.config/opencode/node_modules/opencode-mattermost-control
rm -f ~/.config/opencode/bun.lock
```

### Step 3: Install the New Version

```bash
cd ~/.config/opencode
bun install

# If using a private registry (e.g., Verdaccio):
bun install --registry http://your-registry-url:4873
```

### Step 4: Restart OpenCode

**Critical**: You must completely restart OpenCode for the new plugin code to load. A `mattermost_disconnect` / `mattermost_connect` cycle only reconnects the WebSocket—it does **not** reload plugin code from disk.

```bash
# Exit OpenCode completely (Ctrl+C or close terminal)
# Then start fresh:
opencode
```

### Step 5: Verify

After reconnecting, check the logs to confirm the new version is running:

```bash
tail -f /tmp/opencode-mattermost-plugin.log
```

### Quick Update Script

```bash
#!/bin/bash
# update-mattermost-plugin.sh
VERSION="${1:-latest}"

echo "Updating opencode-mattermost-control to $VERSION..."

# Update package.json
if [ "$VERSION" = "latest" ]; then
  # Fetch latest version from registry
  VERSION=$(curl -s http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873/opencode-mattermost-control | jq -r '.["dist-tags"].latest')
fi

# Update version in package.json
cd ~/.config/opencode
cat package.json | jq ".dependencies[\"opencode-mattermost-control\"] = \"$VERSION\"" > package.json.tmp
mv package.json.tmp package.json

# Clear cache and reinstall
rm -rf node_modules/opencode-mattermost-control bun.lock
bun install --registry http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873

echo "Updated to version $VERSION"
echo "IMPORTANT: Restart OpenCode for changes to take effect!"
```

---

## Migrating to PostgreSQL

This guide walks through migrating from local JSON file storage to PostgreSQL (Supabase) for multi-instance deployments.

### Prerequisites

- A Supabase instance with the `opencode_mattermost` schema created
- Database tables created (see SQL schema below)
- Supabase URL and anon key

### Database Schema

Create the required tables in your Supabase instance:

```sql
-- Create schema
CREATE SCHEMA IF NOT EXISTS opencode_mattermost;

-- Thread mappings table
CREATE TABLE opencode_mattermost.thread_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_root_post_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  opencode_session_id TEXT NOT NULL,
  mattermost_user_id TEXT NOT NULL,
  mode TEXT DEFAULT 'normal',
  metadata JSONB DEFAULT '{}',
  claimed_by TEXT,
  claimed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled tasks table
CREATE TABLE opencode_mattermost.scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  enabled BOOLEAN DEFAULT true,
  target_user TEXT,
  last_run_at TIMESTAMPTZ,
  last_run_by TEXT,
  next_run_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Team configuration table
CREATE TABLE opencode_mattermost.team_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT UNIQUE NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pending questions table
CREATE TABLE opencode_mattermost.pending_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  thread_root_post_id TEXT NOT NULL,
  question_post_id TEXT,
  question_data JSONB NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  answer JSONB
);

-- Pending approvals table
CREATE TABLE opencode_mattermost.pending_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_root_post_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  original_message TEXT NOT NULL,
  approval_post_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

-- Indexes for common queries
CREATE INDEX idx_thread_mappings_session ON opencode_mattermost.thread_mappings(opencode_session_id);
CREATE INDEX idx_thread_mappings_user ON opencode_mattermost.thread_mappings(mattermost_user_id);
CREATE INDEX idx_thread_mappings_channel ON opencode_mattermost.thread_mappings(channel_id);
CREATE INDEX idx_scheduled_tasks_next_run ON opencode_mattermost.scheduled_tasks(next_run_at) WHERE enabled = true;
CREATE INDEX idx_pending_questions_session ON opencode_mattermost.pending_questions(session_id);
CREATE INDEX idx_pending_approvals_thread ON opencode_mattermost.pending_approvals(thread_root_post_id);

-- Enable Realtime for tables that need it
ALTER PUBLICATION supabase_realtime ADD TABLE opencode_mattermost.pending_questions;
ALTER PUBLICATION supabase_realtime ADD TABLE opencode_mattermost.pending_approvals;
```

### Step 1: Configure Environment Variables

Add these environment variables to your OpenCode environment:

```bash
# Supabase connection
export OPENCODE_MM_SUPABASE_URL="https://your-project.supabase.co"
export OPENCODE_MM_SUPABASE_ANON_KEY="your-anon-key"

# Start in Phase 1 (dual-write mode)
export OPENCODE_MM_MIGRATION_PHASE="1"
```

### Step 2: Start in Dual-Write Mode (Phase 1)

With `OPENCODE_MM_MIGRATION_PHASE="1"`, the plugin will:
- Write to both local JSON files AND PostgreSQL
- Read from local JSON files (existing behavior)
- Gracefully handle Postgres failures

This allows you to verify Postgres writes are working without affecting production reads.

**Verify Phase 1:**
```bash
# Check plugin logs for Postgres writes
tail -f /tmp/opencode-mattermost-plugin.log | grep -i postgres

# Verify data is being written to Supabase
# (check your Supabase dashboard or query the tables)
```

### Step 3: Migrate Existing Data

Once Phase 1 is running, migrate your existing JSON data to PostgreSQL:

**Via Mattermost DM:**
```
!migrate
```

This will:
1. Read all thread mappings from local JSON
2. Read all scheduled tasks from local JSON  
3. Read team configuration from local JSON
4. Write all data to PostgreSQL (skipping duplicates)
5. Report migration statistics

**Verify migration:**
```
!migrate --dry-run
```

### Step 4: Switch to Migration Mode (Phase 2)

After verifying data is in Postgres:

```bash
export OPENCODE_MM_MIGRATION_PHASE="2"
```

In Phase 2:
- Writes go to both JSON and Postgres
- Reads come from Postgres (with JSON fallback if Postgres fails)
- Any data found in JSON but not in Postgres is auto-synced

Run in Phase 2 for a few days to ensure everything works correctly.

### Step 5: Complete Migration (Phase 3)

Once confident:

```bash
export OPENCODE_MM_MIGRATION_PHASE="3"
```

In Phase 3:
- Postgres is the primary data store
- JSON files are only used for degraded mode (when Postgres is unavailable)
- Queued writes during degraded mode are flushed when connection recovers

### Rollback Procedure

If you encounter issues:

1. **Quick rollback:** Set `OPENCODE_MM_MIGRATION_PHASE="1"` to return to JSON-primary mode
2. **Export data:** Use `!export` command to dump current state to JSON files
3. **Remove Postgres config:** Unset `OPENCODE_MM_SUPABASE_URL` to disable Postgres entirely

### Export Command

Export current state to JSON files (useful for backup or debugging):

```
!export
```

This creates timestamped JSON files in the plugin temp directory with all thread mappings, schedules, and team configs.

### Graceful Degradation

When Postgres becomes unavailable:
- Plugin automatically enters "degraded mode"
- Writes are queued locally (up to 1000 items, 5-minute expiration)
- Reads fall back to local JSON cache
- When connection recovers, queued writes are flushed
- Health monitoring checks connection every 30 seconds

### Multi-Instance Coordination

With Postgres enabled, multiple OpenCode instances can share state:

- **Thread claiming:** Only one instance processes messages for a thread at a time
- **Scheduled task leader election:** Only one instance runs each scheduled task
- **Real-time sync:** Pending questions and approvals sync via Supabase Realtime

### Shakudo Platform Deployment

For deployments on the Shakudo platform (dev.hyperplane.dev), use the Metaflow Supabase instance:

#### 1. Database Setup (One-time)

The `opencode_mattermost` schema must be created in Supabase and PostgREST must be configured to expose it.

**Create schema and tables:**
```bash
# Get postgres password
PGPASSWORD=$(kubectl get secret -n hyperplane-supabase-metaflow supabase-metaflow-postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)

# Create schema
kubectl exec -n hyperplane-supabase-metaflow supabase-metaflow-postgresql-0 -- bash -c "PGPASSWORD='$PGPASSWORD' psql -U postgres -d postgres -c 'CREATE SCHEMA IF NOT EXISTS opencode_mattermost;'"

# Create tables (run each CREATE TABLE statement from the schema above)
# Grant permissions
kubectl exec -n hyperplane-supabase-metaflow supabase-metaflow-postgresql-0 -- bash -c "PGPASSWORD='$PGPASSWORD' psql -U postgres -d postgres -c '
GRANT USAGE ON SCHEMA opencode_mattermost TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA opencode_mattermost TO anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA opencode_mattermost TO anon;
GRANT USAGE ON SCHEMA opencode_mattermost TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA opencode_mattermost TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA opencode_mattermost TO authenticated;
'"
```

**Configure PostgREST to expose the schema:**
```bash
# Add opencode_mattermost to the PGRST_DB_SCHEMA list
kubectl patch configmap supabase-metaflow-rest-default \
  -n hyperplane-supabase-metaflow \
  --type merge \
  -p '{"data":{"PGRST_DB_SCHEMA":"public,storage,graphql_public,opencode_mattermost"}}'

# Restart PostgREST to pick up the change
kubectl rollout restart deployment supabase-metaflow-rest -n hyperplane-supabase-metaflow
```

#### 2. Environment Variables

Add to `~/.bashrc`:
```bash
# OpenCode Mattermost Plugin - Postgres State Management
# Using PostgREST directly (port 80)
export OPENCODE_MM_SUPABASE_URL="http://supabase-metaflow-rest.hyperplane-supabase-metaflow.svc.cluster.local:80"
export OPENCODE_MM_SUPABASE_ANON_KEY="eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE4MzQ3MDA0MDAsImlhdCI6MTY3NjkzNDAwMCwiaXNzIjoic3VwYWJhc2UiLCJyb2xlIjoiYW5vbiJ9.L5wyKsVw1lSYIlwMJYDC-7bfDmsBOf0Xwq1hU4QMbnA"
export OPENCODE_MM_MIGRATION_PHASE="1"
```

Then `source ~/.bashrc` and restart OpenCode.

#### 3. Verify Connection

Test that PostgREST can query the schema:
```bash
curl -s -X GET "http://supabase-metaflow-rest.hyperplane-supabase-metaflow.svc.cluster.local:80/thread_mappings?limit=1" \
  -H "apikey: $OPENCODE_MM_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $OPENCODE_MM_SUPABASE_ANON_KEY" \
  -H "Accept-Profile: opencode_mattermost"
```

Should return `[]` (empty array) if working correctly.

---

## Troubleshooting

### "Not connected to Mattermost"
Run `mattermost_connect` first.

### "MATTERMOST_TOKEN environment variable is required"
Set the `MATTERMOST_TOKEN` environment variable with your bot's access token.

### WebSocket disconnects frequently
Check network connectivity to the Mattermost server. The client auto-reconnects with exponential backoff.

### Messages not appearing
Ensure you're DMing the bot user directly, not posting in a channel.

### Permission errors
Verify your bot token has the required permissions:
- Post messages
- Read channels
- Upload files (if using file attachments)

### View logs
```bash
tail -f /tmp/opencode-mattermost-plugin.log
```

### Plugin not updating after install
If you installed a new version but the old code is still running:

1. OpenCode caches plugins in `~/.config/opencode/node_modules/`
2. Check the cached version: `cat ~/.config/opencode/node_modules/opencode-mattermost-control/package.json | grep version`
3. Follow the [Updating the Plugin](#updating-the-plugin) section above
4. **You must restart OpenCode completely** - disconnect/reconnect only refreshes the WebSocket, not the plugin code

### Bot not responding to DMs

If your bot is connected but not responding to messages, check these common issues:

#### 1. Wrong Owner User ID

If you're using `MATTERMOST_OWNER_USER_ID` for multi-user setups, ensure it's set to your **actual Mattermost user ID**, not someone else's or a non-existent ID.

**Symptoms:**
- Plugin log shows: `Ignoring 1:1 DM from non-owner user <your-user-id>`
- Bot appears online but never responds

**Fix:**
```bash
# Find your user ID (ask admin or check Mattermost profile API)
# Then update your environment:
export MATTERMOST_OWNER_USER_ID="your-actual-user-id"
```

#### 2. OpenCode Version Compatibility

Some OpenCode versions have plugin loading issues in server mode. If plugins aren't loading:

**Symptoms:**
- `opencode serve` starts but plugin log shows no activity
- No "Connected to Mattermost" message in logs

**Fix:**
Try downgrading to a known working version:
```bash
npm install -g opencode-ai@1.1.28
```

#### 3. Plugins Only Load When Session Created

**Critical:** Plugins don't load when `opencode serve` starts—they only initialize when a session is created.

**Symptoms:**
- Server starts successfully
- Plugin log is empty or shows no connection
- Works fine with `opencode` (non-server mode)

**Fix:**
After starting the server, create a session to bootstrap plugin loading:
```bash
# Start server
opencode serve --port 4096

# In another terminal, create a session to trigger plugin load
curl -s -X POST http://localhost:4096/session \
  -H "Content-Type: application/json" \
  -d '{"directory": "/path/to/your/project"}'
```

**Startup script example:**
```bash
#!/bin/bash
# start-opencode-with-plugin.sh

PORT="${OPENCODE_SERVER_PORT:-4096}"

# Kill existing and start fresh
pkill -f opencode 2>/dev/null || true
sleep 2

# Start server
cd /your/project/directory
nohup opencode serve --port $PORT > /tmp/opencode-server.log 2>&1 &
echo "Started OpenCode server on port $PORT"

# Wait for server
for i in {1..30}; do
  curl -s http://localhost:$PORT/ > /dev/null 2>&1 && break
  sleep 1
done

# Bootstrap plugins by creating a session
curl -s -X POST http://localhost:$PORT/session \
  -H "Content-Type: application/json" \
  -d '{"directory": "/your/project/directory"}' > /dev/null 2>&1

echo "Created session to bootstrap plugins"

# Verify
sleep 3
if grep -q "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log 2>/dev/null; then
  echo "✓ Plugin connected successfully!"
else
  echo "⚠ Check /tmp/opencode-mattermost-plugin.log for issues"
fi
```

#### 4. Missing Dependencies

If you see import errors in the plugin log:

**Fix:**
```bash
cd ~/.config/opencode
bun add axios  # or other missing packages
```

### Verifying Plugin is Working

Check these in order:

1. **Server running:**
   ```bash
   curl http://localhost:4096/
   ```

2. **Plugin log exists and shows connection:**
   ```bash
   tail /tmp/opencode-mattermost-plugin.log
   # Should show: "Connected to Mattermost as @your-bot"
   ```

3. **Sessions discovered:**
   ```bash
   grep "session discovered" /tmp/opencode-mattermost-plugin.log
   ```

4. **Test message received:**
   Send a DM to the bot and check logs for:
   - `Ignoring 1:1 DM from non-owner` = Owner ID mismatch
   - `Processing DM from` = Message being handled
   - No log entry = WebSocket not receiving events

## Development

### Setup

```bash
git clone https://github.com/Shakudo-io/opencode-mattermost-plugin.git
cd opencode-mattermost-plugin
bun install
```

### Type Check

```bash
bun run typecheck
```

### Run Tests

```bash
bun test
```

### Publish

```bash
npm publish
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Guidelines

- Follow the existing code style
- Add tests for new features
- Update documentation as needed
- Keep commits atomic and well-described

## Security

- Never commit tokens or credentials
- Use environment variables for all sensitive configuration
- Report security vulnerabilities privately

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [OpenCode Documentation](https://opencode.ai/docs/)
- [Mattermost API Reference](https://api.mattermost.com/)
- [Report Issues](https://github.com/Shakudo-io/opencode-mattermost-plugin/issues)
