# OpenCode Mattermost Control Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/opencode-mattermost-control.svg)](https://www.npmjs.com/package/opencode-mattermost-control)

Control [OpenCode](https://opencode.ai) remotely via Mattermost direct messages. Send prompts to your OpenCode session by messaging a bot user, and receive real-time streaming responses.

## Features

### Core Features
- **Thread-Per-Session**: Each OpenCode session automatically gets its own dedicated Mattermost thread for clean conversation isolation
- **Remote Control**: Send prompts to OpenCode via Mattermost DMs
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
```

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

### Session Management Commands

When connected, you can manage multiple OpenCode sessions via DM commands:

| Command | Description |
|---------|-------------|
| `!sessions` | List all available OpenCode sessions with thread links |
| `!models` | List available models grouped by provider, select by number |
| `!model` | Show the currently selected model for this session |
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
    ├── command-handler.ts            # !command processing
    ├── config.ts                     # Configuration loading
    ├── file-handler.ts               # File uploads/downloads
    ├── logger.ts                     # File-based logging
    ├── message-router.ts             # Thread-aware message routing
    ├── monitor-service.ts            # Session monitoring and alerts
    ├── notification-service.ts       # Status notifications
    ├── opencode-session-registry.ts  # OpenCode session discovery
    ├── reaction-handler.ts           # Emoji reaction handling
    ├── response-streamer.ts          # Streams responses to MM
    ├── session-manager.ts            # User session management
    └── thread-manager.ts             # Thread lifecycle management
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
