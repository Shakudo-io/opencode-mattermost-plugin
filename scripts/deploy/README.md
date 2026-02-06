# Deployment Guide - OpenCode Teams Bot

Deploy the Teams bot as a Shakudo microservice with external webhook access.

## Architecture

```
Microsoft Teams
    │
    ▼ (HTTPS)
Azure Bot Framework
    │
    ▼ (HTTPS POST /api/messages)
Shakudo Webhook (public URL)
    │
    ▼ (HTTP, in-cluster)
opencode-teams-bot microservice (port 8787)
    │
    ▼ (HTTP)
OpenCode server (port 4096)
```

## Current Deployment

| Component | Value |
|-----------|-------|
| **Microservice** | `opencode-teams-bot` |
| **Microservice ID** | `cb289fb5-04d0-488f-b5b8-3af6d2c92d1e` |
| **Webhook URL** | `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev` |
| **Health Check** | `GET /api/health` → 200 OK |
| **Messages Endpoint** | `POST /api/messages` (Bot Framework) |
| **In-Cluster URL** | `http://hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local:8787` |
| **Environment** | `basic-ai-tools-small` |
| **Git Server** | `kaji-opensource` |
| **Branch** | `opencode-mattermost-plugin-003-ms-teams-integration` |
| **Entrypoint** | `scripts/deploy/run.sh` |

## Files

```
scripts/deploy/
├── run.sh                      # Shakudo entrypoint (installs bun, deps, starts bot)
├── deploy-to-shakudo.sh        # Deployment helper script (prints required config)
├── k8s-secrets-template.yaml   # Kubernetes secret manifest template
└── README.md                   # This file
```

## Deploying

### Option 1: Shakudo Platform API

```bash
# Using shakudo-platform MCP tools
createMicroservice(
  name="opencode-teams-bot",
  environment="basic-ai-tools-small",
  gitServer="kaji-opensource",
  branch="opencode-mattermost-plugin-003-ms-teams-integration",
  port=8787,
  script="scripts/deploy/run.sh",
  userEmail="your-email@shakudo.io",
  parameters=[
    { key: "AZURE_APP_ID", value: "691f2047-0585-4566-9129-d582c82b5e7d" },
    { key: "AZURE_APP_PASSWORD", value: "<from-azure>" },
    { key: "AZURE_TENANT_ID", value: "b01c976d-0f48-4c4e-8859-1b03b022911e" },
    { key: "AZURE_AD_AUTHORIZED_GROUP_ID", value: "9e1892be-12f9-48eb-a01c-134cbd04d3dd" },
    { key: "TEAMS_BOT_PORT", value: "3978" }
  ]
)
```

### Option 2: Deploy Script

```bash
export AZURE_APP_ID="691f2047-0585-4566-9129-d582c82b5e7d"
export AZURE_APP_PASSWORD="<from-azure>"
export AZURE_TENANT_ID="b01c976d-0f48-4c4e-8859-1b03b022911e"
export AZURE_AD_AUTHORIZED_GROUP_ID="9e1892be-12f9-48eb-a01c-134cbd04d3dd"
export USER_EMAIL="your-email@shakudo.io"

./scripts/deploy/deploy-to-shakudo.sh
```

## Webhook Configuration

The bot needs a public HTTPS endpoint for Microsoft Bot Framework to send messages to. On Shakudo, this is done by converting the microservice to a public webhook.

### How Webhooks Work on Shakudo

1. Deploy the microservice normally (it gets an in-cluster URL only)
2. Request webhook exposure through Shakudo platform (manual step by admin)
3. Shakudo creates a public URL: `https://{id}-webhook.dev.hyperplane.dev`
4. This URL bypasses Keycloak authentication (required for Bot Framework)

### Webhook URL Pattern

```
https://{microservice-id-prefix}-webhook.dev.hyperplane.dev
```

Example: `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev`

### Azure Bot Registration

The Azure Bot Registration endpoint must match the webhook URL:

```
Endpoint: https://{webhook-url}/api/messages
```

To verify:
```bash
az bot show --name opencode-teams-bot --resource-group shakudo-teams-bot \
  --query "{endpoint:properties.endpoint}" -o json
```

To update (if webhook URL changes):
```bash
az bot update --name opencode-teams-bot --resource-group shakudo-teams-bot \
  --endpoint "https://NEW-WEBHOOK-URL/api/messages"
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `AZURE_APP_ID` | Azure AD Application (client) ID |
| `AZURE_APP_PASSWORD` | Azure AD Application client secret |
| `AZURE_TENANT_ID` | Azure AD Tenant ID |
| `AZURE_AD_AUTHORIZED_GROUP_ID` | Azure AD Security Group for authorization |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAMS_BOT_PORT` | `3978` | Port the bot listens on internally |
| `OPENCODE_SERVER_URL` | `http://localhost:4096` | OpenCode server URL |
| `TEAMS_DEBUG` | `false` | Enable debug logging |
| `TEAMS_LOG_FILE` | `/tmp/opencode-teams-plugin.log` | Log file path |

## Health Check

```bash
# Public
curl https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/health

# In-cluster
curl http://hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local:8787/api/health
```

Expected response:
```json
{"status":"healthy","uptime":1234,"service":"opencode-teams-bot","version":"1.0.0"}
```

## Restarting

After code changes:
1. Commit and push to the branch
2. Wait for git sync (check with `checkGitServerSync`)
3. Restart: `restartService(id="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e")`
4. Monitor logs: `getPodEvents(jobId="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e")`

## Troubleshooting

### Bot returns 302 (redirect) on public URL
The microservice hasn't been converted to a webhook yet. Contact admin to expose it as a public webhook.

### Bot returns 500 on /api/messages
Expected if sending a test POST without Bot Framework authentication headers. The Bot Framework SDK validates the authorization token.

### Pod keeps crashing
Check logs:
```bash
getPodEvents(jobId="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e", tailLines=100)
```

Common issues:
- Missing `AZURE_APP_PASSWORD` environment variable
- Bun installation failure (network issues)
- Port conflict (ensure `TEAMS_BOT_PORT` matches what the code listens on)
