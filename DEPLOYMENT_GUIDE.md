# Kaji Deployment & Operations Guide

**Version**: 0.3.45  
**Last Updated**: 2026-02-02  
**Audience**: DevOps, Platform Engineers, System Administrators

This guide covers deploying and operating the OpenCode Mattermost Control Plugin (Kaji) in production environments.

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Mattermost Bot Setup](#mattermost-bot-setup)
3. [Installation Methods](#installation-methods)
4. [Configuration & Environment](#configuration--environment)
5. [Deployment Scenarios](#deployment-scenarios)
6. [Multi-User Setup](#multi-user-setup)
7. [Monitoring & Observability](#monitoring--observability)
8. [Backup & Recovery](#backup--recovery)
9. [Troubleshooting](#troubleshooting)
10. [Upgrade Procedures](#upgrade-procedures)

---

## Pre-Deployment Checklist

### Infrastructure Requirements

- [ ] **Mattermost Instance**: v5.0+ with API access
- [ ] **OpenCode Installation**: v1.1.28+ on target server
- [ ] **Runtime**: Node.js 18+ or Bun 1.0+
- [ ] **Network**: Outbound HTTPS to Mattermost instance
- [ ] **Storage**: 100MB for plugin + logs
- [ ] **Memory**: 256MB minimum (512MB recommended)

### Access & Permissions

- [ ] **Mattermost Admin Access**: To create bot accounts
- [ ] **System Console Access**: For bot token generation
- [ ] **Server SSH Access**: For deployment and monitoring
- [ ] **Firewall Rules**: Allow outbound to Mattermost API/WebSocket

### Planning

- [ ] **Mattermost URL**: Document the instance URL
- [ ] **Bot Account Name**: Decide naming convention (e.g., `opencode-bot`)
- [ ] **User Isolation**: Determine if single-user or multi-user setup
- [ ] **Notification Strategy**: Plan alert recipients and channels
- [ ] **Backup Location**: Identify where to store thread mappings

---

## Mattermost Bot Setup

### Step 1: Create Bot Account

1. **Navigate to System Console**:
   - URL: `https://your-mattermost.com/admin_console`
   - Login with admin credentials

2. **Go to Integrations → Bot Accounts**:
   - Click **Create New Bot Account**

3. **Configure Bot**:
   - **Username**: `opencode-bot` (or your naming convention)
   - **Display Name**: `OpenCode AI Agent`
   - **Description**: `Remote control for OpenCode via Mattermost`
   - **Role**: Select appropriate role (see permissions below)

4. **Copy Access Token**:
   - Save the generated token securely
   - This is your `MATTERMOST_TOKEN`

### Step 2: Configure Bot Permissions

The bot needs these permissions:

| Permission | Purpose |
|-----------|---------|
| `create_post` | Send messages to threads |
| `edit_post` | Update streaming responses |
| `delete_post` | Clean up old messages (optional) |
| `get_channel` | Read channel info |
| `get_team` | Read team info |
| `upload_file` | Send file attachments |
| `get_file_info` | Read file metadata |
| `get_user` | Resolve user IDs |
| `get_posts` | Read thread context |
| `add_reaction` | Handle emoji commands |

**Recommended Role**: Create a custom role with above permissions, or use the built-in "Bot" role if available.

### Step 3: Add Bot to Teams/Channels

1. **Add to Team**:
   - Go to Team Settings → Members
   - Search for your bot user
   - Click **Add**

2. **Add to Channels** (optional):
   - For group DM support, add bot to relevant channels
   - Bot will only respond when @mentioned in channels

### Step 4: Verify Bot Setup

```bash
# Test bot connectivity
curl -X GET "https://your-mattermost.com/api/v4/users/me" \
  -H "Authorization: Bearer YOUR_BOT_TOKEN"

# Expected response: Bot user object with username "opencode-bot"
```

---

## Installation Methods

### Method 1: Global Install (Recommended for Single User)

```bash
# Using Bun (faster)
bun add -g opencode-mattermost-control

# Or using npm
npm install -g opencode-mattermost-control

# Verify installation
which opencode-mattermost-control
```

**Pros**: Simple, automatic updates, global availability  
**Cons**: Single version across all users

### Method 2: Per-Project Install

Add to your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-mattermost-control@0.3.45"]
}
```

Then install:

```bash
cd /path/to/project
bun install
# or
npm install
```

**Pros**: Version control, per-project configuration  
**Cons**: Requires installation in each project

### Method 3: Docker Container

Create a `Dockerfile`:

```dockerfile
FROM node:18-alpine

# Install Bun
RUN npm install -g bun

# Install OpenCode
RUN bun add -g opencode-ai opencode-mattermost-control

# Create app directory
WORKDIR /app

# Copy project files
COPY . .

# Install dependencies
RUN bun install

# Set environment variables
ENV MATTERMOST_TOKEN=""
ENV MATTERMOST_URL=""
ENV OPENCODE_MM_AUTO_CONNECT="true"

# Start OpenCode
CMD ["opencode", "serve", "--port", "4096"]
```

Build and run:

```bash
docker build -t opencode-kaji:0.3.45 .

docker run -d \
  --name opencode-kaji \
  -e MATTERMOST_TOKEN="your-token" \
  -e MATTERMOST_URL="https://your-mattermost.com/api/v4" \
  -v /home/user/.config/opencode:/root/.config/opencode \
  -p 4096:4096 \
  opencode-kaji:0.3.45
```

**Pros**: Isolated environment, reproducible deployments  
**Cons**: Container overhead, requires Docker

### Method 4: Kubernetes Deployment

Create `kaji-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode-kaji
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opencode-kaji
  template:
    metadata:
      labels:
        app: opencode-kaji
    spec:
      containers:
      - name: opencode
        image: opencode-kaji:0.3.45
        ports:
        - containerPort: 4096
        env:
        - name: MATTERMOST_TOKEN
          valueFrom:
            secretKeyRef:
              name: kaji-secrets
              key: mattermost-token
        - name: MATTERMOST_URL
          value: "https://your-mattermost.com/api/v4"
        - name: OPENCODE_MM_AUTO_CONNECT
          value: "true"
        volumeMounts:
        - name: config
          mountPath: /root/.config/opencode
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
      volumes:
      - name: config
        persistentVolumeClaim:
          claimName: opencode-config-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: opencode-kaji-svc
spec:
  selector:
    app: opencode-kaji
  ports:
  - protocol: TCP
    port: 4096
    targetPort: 4096
  type: ClusterIP
---
apiVersion: v1
kind: Secret
metadata:
  name: kaji-secrets
type: Opaque
stringData:
  mattermost-token: "your-bot-token-here"
```

Deploy:

```bash
kubectl apply -f kaji-deployment.yaml
kubectl get pods -l app=opencode-kaji
```

---

## Configuration & Environment

### Required Environment Variables

```bash
# Mattermost connection
export MATTERMOST_TOKEN="xxxxxxxxxxxxxxxxxxx"           # Bot access token
export MATTERMOST_URL="https://mattermost.example.com/api/v4"

# Optional: WebSocket URL (auto-detected if not set)
export MATTERMOST_WS_URL="wss://mattermost.example.com/api/v4/websocket"
```

### Optional Configuration

```bash
# Connection settings
export MATTERMOST_TEAM="engineering"                    # Default team
export MATTERMOST_DEBUG="false"                         # Enable debug logging
export MATTERMOST_AUTO_CONNECT="true"                   # Auto-connect on startup
export MATTERMOST_RECONNECT_INTERVAL="5000"             # ms between reconnect attempts
export MATTERMOST_MAX_RECONNECT_ATTEMPTS="10"           # max reconnection tries

# Streaming configuration
export OPENCODE_MM_BUFFER_SIZE="50"                     # chars before flush
export OPENCODE_MM_MAX_DELAY="500"                      # max ms before flush
export OPENCODE_MM_EDIT_RATE_LIMIT="10"                 # max edits/sec
export OPENCODE_MM_MAX_POST_LENGTH="15000"              # max chars per post

# Session configuration
export OPENCODE_MM_SESSION_TIMEOUT="3600000"            # 1 hour in ms
export OPENCODE_MM_MAX_SESSIONS="50"                    # max concurrent
export OPENCODE_MM_AUTO_CREATE_SESSION="true"           # auto-create from main DM
export OPENCODE_MM_ALLOWED_CHANNEL_TYPES="D,G,O,P"     # D=DM, G=Group, O=Public, P=Private

# Multi-user setup
export MATTERMOST_OWNER_USER_ID=""                      # Restrict to single user

# File handling
export OPENCODE_MM_TEMP_DIR="/tmp/opencode-mm-plugin"
export OPENCODE_MM_MAX_FILE_SIZE="10485760"             # 10MB
export OPENCODE_MM_ALLOWED_EXTENSIONS="*"               # comma-separated or *

# Notifications
export OPENCODE_MM_NOTIFY_COMPLETION="true"
export OPENCODE_MM_NOTIFY_PERMISSION="true"
export OPENCODE_MM_NOTIFY_ERROR="true"
export OPENCODE_MM_NOTIFY_STATUS="true"

# Logging
export MM_PLUGIN_LOG_FILE="/tmp/opencode-mattermost-plugin.log"
export MM_PLUGIN_LOG_LEVEL="info"                       # debug, info, warn, error
```

### Configuration File

Create `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-mattermost-control"],
  "mattermost": {
    "token": "${MATTERMOST_TOKEN}",
    "url": "${MATTERMOST_URL}",
    "wsUrl": "${MATTERMOST_WS_URL}",
    "team": "engineering",
    "debug": false,
    "autoConnect": true
  },
  "streaming": {
    "bufferSize": 50,
    "maxDelay": 500,
    "editRateLimit": 10,
    "maxPostLength": 15000
  },
  "sessions": {
    "timeout": 3600000,
    "maxConcurrent": 50,
    "autoCreate": true
  },
  "notifications": {
    "completion": true,
    "permission": true,
    "error": true,
    "status": true
  }
}
```

### Environment Variable Priority

1. **Command-line flags** (highest)
2. **Environment variables**
3. **Config file** (`opencode.json`)
4. **Defaults** (lowest)

---

## Deployment Scenarios

### Scenario 1: Single Developer (Local Machine)

**Setup**: One developer, one OpenCode instance, one Mattermost bot

```bash
# 1. Install globally
bun add -g opencode-mattermost-control

# 2. Set environment
export MATTERMOST_TOKEN="your-bot-token"
export MATTERMOST_URL="https://your-mattermost.com/api/v4"

# 3. Start OpenCode
cd /path/to/project
opencode

# 4. Connect from OpenCode
> mattermost_connect
✓ Connected to Mattermost as @opencode-bot
```

**Persistence**: Thread mappings stored in `~/.config/opencode/thread-mappings.json`

---

### Scenario 2: Team Shared Server

**Setup**: Multiple developers, shared OpenCode server, single bot account

```bash
# 1. Start shared server on port 4096
opencode serve --port 4096 &

# 2. Each developer attaches their TUI
cd /path/to/project-a
opencode attach http://localhost:4096

# In another terminal:
cd /path/to/project-b
opencode attach http://localhost:4096
```

**Key Points**:
- All sessions share the same bot account
- Thread mappings are shared across all developers
- Use `!sessions` to see all active sessions
- Use `!use <session-id>` to switch between sessions

**Persistence**: Shared thread mappings in `~/.config/opencode/thread-mappings.json`

---

### Scenario 3: Multi-User with Owner Filtering

**Setup**: Multiple developers, each with their own OpenCode instance, shared bot account

```bash
# Developer A
export MATTERMOST_OWNER_USER_ID="user_a_id"
export MATTERMOST_TOKEN="shared-bot-token"
export MATTERMOST_URL="https://your-mattermost.com/api/v4"
opencode

# Developer B (different terminal/machine)
export MATTERMOST_OWNER_USER_ID="user_b_id"
export MATTERMOST_TOKEN="shared-bot-token"
export MATTERMOST_URL="https://your-mattermost.com/api/v4"
opencode
```

**Key Points**:
- Each developer only sees their own DMs
- Bot responds only to configured owner
- Separate thread mappings per user
- Useful for shared infrastructure

**Finding User IDs**:
```bash
# Via Mattermost API
curl -X GET "https://your-mattermost.com/api/v4/users/username/alice" \
  -H "Authorization: Bearer $MATTERMOST_TOKEN" | jq '.id'
```

---

### Scenario 4: Docker Container Deployment

**Setup**: Containerized OpenCode with Kaji plugin

```bash
# 1. Create Dockerfile (see Installation Methods section)

# 2. Build image
docker build -t opencode-kaji:0.3.45 .

# 3. Run container
docker run -d \
  --name opencode-kaji \
  -e MATTERMOST_TOKEN="your-token" \
  -e MATTERMOST_URL="https://your-mattermost.com/api/v4" \
  -v opencode-config:/root/.config/opencode \
  -p 4096:4096 \
  opencode-kaji:0.3.45

# 4. Verify
docker logs opencode-kaji
curl http://localhost:4096/
```

**Persistence**: Use Docker volumes for thread mappings

---

### Scenario 5: Kubernetes Deployment

**Setup**: Production-grade Kubernetes deployment with persistence

```bash
# 1. Create secrets
kubectl create secret generic kaji-secrets \
  --from-literal=mattermost-token="your-token"

# 2. Create PVC for config
kubectl apply -f - << EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: opencode-config-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
