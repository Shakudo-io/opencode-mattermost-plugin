# OpenCode Mattermost Control Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/opencode-mattermost-control.svg)](https://www.npmjs.com/package/opencode-mattermost-control)

Control [OpenCode](https://opencode.ai) remotely via Mattermost direct messages. Send prompts to your OpenCode session by messaging a bot user, and receive real-time streaming responses.

## Features

- **Remote Control**: Send prompts to OpenCode via Mattermost DMs
- **Real-time Streaming**: Responses stream back in chunks with intelligent buffering
- **File Attachments**: Send and receive files through Mattermost
- **Emoji Commands**: React with emojis to control sessions
  - ✅ Approve pending permission
  - ❌ Deny pending permission  
  - 🛑 Cancel current operation
  - 🔁 Retry last prompt
  - 🗑️ Clear session files
- **Notifications**: Get notified on completion, errors, and status changes
- **Multi-user Support**: Handle multiple users with separate sessions
- **Automatic Reconnection**: WebSocket auto-reconnects with exponential backoff

## Prerequisites

- [OpenCode](https://opencode.ai) installed and configured
- A Mattermost instance with API access
- A Mattermost bot account with appropriate permissions
- [Bun](https://bun.sh) runtime (recommended) or Node.js 18+

## Installation

### Using npm/bun (Recommended)

```bash
# Install globally
bun add -g opencode-mattermost-control

# Or with npm
npm install -g opencode-mattermost-control
```

### From Source

```bash
git clone https://github.com/Shakudo-io/opencode-mattermost-plugin.git
cd opencode-mattermost-plugin
bun install
```

## Configuration

### 1. Create a Mattermost Bot

1. Go to your Mattermost System Console → Integrations → Bot Accounts
2. Create a new bot account
3. Copy the generated access token

### 2. Set Environment Variables

```bash
# Required
export MATTERMOST_TOKEN="your-bot-access-token"
export MATTERMOST_URL="https://your-mattermost-instance.com/api/v4"

# Optional (with defaults)
export MATTERMOST_WS_URL="wss://your-mattermost-instance.com/api/v4/websocket"
export MATTERMOST_TEAM="your-team-name"
export MATTERMOST_DEBUG="false"

# Advanced options
export MATTERMOST_RECONNECT_INTERVAL="5000"      # ms between reconnect attempts
export MATTERMOST_MAX_RECONNECT_ATTEMPTS="10"   # max reconnection tries

# Streaming configuration
export OPENCODE_MM_BUFFER_SIZE="50"              # characters before flushing
export OPENCODE_MM_MAX_DELAY="500"               # max ms before forced flush
export OPENCODE_MM_EDIT_RATE_LIMIT="10"          # max edits per second

# Session configuration
export OPENCODE_MM_SESSION_TIMEOUT="3600000"     # 1 hour in ms
export OPENCODE_MM_MAX_SESSIONS="50"             # max concurrent sessions
export OPENCODE_MM_ALLOWED_USERS=""              # comma-separated user IDs (empty = all)

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

### 3. Add to OpenCode Configuration

Add the plugin to your OpenCode configuration (`~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["opencode-mattermost-control"]
}
```

Or for per-project usage, create an `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": {
    "mattermost-control": {
      "enabled": true
    }
  }
}
```

## Usage

### 1. Start OpenCode

```bash
opencode
```

### 2. Connect to Mattermost

Use the built-in tool or slash command:

```
mattermost_connect
```

You should see:
```
✓ Connected to Mattermost as @your-bot
✓ Listening for DMs
✓ Project: your-project-name
```

### 3. Send Prompts via DM

Open Mattermost and send a direct message to your bot user:

```
Create a hello world function in Python
```

The prompt will be processed by your OpenCode session and the response will stream back to the DM.

### 4. Check Status

```
mattermost_status
```

### 5. Disconnect

```
mattermost_disconnect
```

## Available Tools

| Tool | Description |
|------|-------------|
| `mattermost_connect` | Connect to Mattermost and start listening for DMs |
| `mattermost_disconnect` | Disconnect from Mattermost |
| `mattermost_status` | Show connection status and active sessions |

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
| `ResponseStreamer` | Chunked message delivery to Mattermost |
| `NotificationService` | Completion, error, and status notifications |
| `FileHandler` | Inbound/outbound file attachment processing |
| `ReactionHandler` | Emoji-based command execution |

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
    ├── config.ts                     # Configuration loading
    ├── file-handler.ts               # File uploads/downloads
    ├── logger.ts                     # File-based logging
    ├── models/index.ts               # TypeScript types
    ├── notification-service.ts       # Status notifications
    ├── reaction-handler.ts           # Emoji reaction handling
    ├── response-streamer.ts          # Streams responses to MM
    └── session-manager.ts            # User session management
```

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
