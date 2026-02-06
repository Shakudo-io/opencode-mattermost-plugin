# Microsoft Teams OpenCode Bot Setup Guide

Complete step-by-step guide for deploying the OpenCode bot to Microsoft Teams using Azure Bot Framework and Shakudo platform.

## Prerequisites

Before starting, ensure you have:

- Azure subscription with permissions to create:
  - Azure AD App Registrations
  - Bot Channels Registrations
  - Azure AD Security Groups
- Microsoft Teams admin access (or org policy allowing custom app uploads)
- Shakudo platform access (dev.hyperplane.dev)
- Azure CLI installed and configured
- Git access to the kaji-opensource repository

## Architecture Overview

```
Microsoft Teams
    |
    v (HTTPS)
Azure Bot Framework
    |
    v (HTTPS POST /api/messages)
Shakudo Webhook (public URL)
    |
    v (HTTP, in-cluster)
opencode-teams-bot microservice (port 8787)
    |
    v (HTTP)
OpenCode server (port 4096)
```

The bot runs as a Shakudo microservice with a public webhook endpoint that receives messages from Azure Bot Framework. User authorization is enforced via Azure AD security group membership.

## Step 1: Azure AD App Registration

Create an Azure AD application to authenticate the bot with Microsoft services.

### Option A: Automated Setup (Recommended)

Use the provided setup script:

```bash
# Navigate to scripts directory
cd scripts/azure

# Login to Azure
az login

# Validate prerequisites
./validate-prereqs.sh

# Set your bot endpoint (use actual webhook URL from Step 5)
export TEAMS_BOT_ENDPOINT=https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages

# Run setup script (idempotent - safe to run multiple times)
./setup-azure-bot.sh
```

The script creates:
- Azure AD App Registration with redirect URI
- Service Principal
- Client secret (2-year validity)
- Bot Channels Registration
- Teams channel configuration
- `.env.azure` file with credentials

### Option B: Manual Setup (Azure Portal)

If automated scripts cannot run due to permission restrictions:

1. Navigate to Azure Portal → Azure Active Directory → App registrations
2. Click New registration
3. Configure:
   - Name: `opencode-teams-bot`
   - Supported account types: "Accounts in this organizational directory only (Single tenant)"
   - Redirect URI: Web, `https://token.botframework.com/.auth/web/redirect`
4. Click Register
5. Note the Application (client) ID: `691f2047-0585-4566-9129-d582c82b5e7d`
6. Note the Directory (tenant) ID: `b01c976d-0f48-4c4e-8859-1b03b022911e`

### Create Client Secret

1. In the app registration, go to Certificates & secrets
2. Click New client secret
3. Configure:
   - Description: `opencode-bot-secret`
   - Expires: 24 months
4. Click Add
5. Copy the secret value immediately (shown only once)

### Configure API Permissions

1. Go to API permissions
2. Click Add a permission → Microsoft Graph
3. Add permissions:
   - Delegated: `User.Read` (Sign in and read user profile)
   - Application: `GroupMember.Read.All` (Read all groups)
4. Click Grant admin consent (requires Global Admin or Privileged Role Admin)

## Step 2: Azure Bot Registration

Create a Bot Channels Registration to connect your bot to Microsoft Teams.

### Option A: Using Azure CLI

```bash
# Install botservice extension if needed
az extension add --name botservice --yes

# Create Bot Channels Registration
az bot create \
  --resource-group shakudo-teams-bot \
  --name opencode-teams-bot \
  --app-type "SingleTenant" \
  --appid 691f2047-0585-4566-9129-d582c82b5e7d \
  --tenant-id b01c976d-0f48-4c4e-8859-1b03b022911e \
  --endpoint https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages \
  --sku "F0"

# Add Teams channel
az bot msteams create \
  --name opencode-teams-bot \
  --resource-group shakudo-teams-bot
```

### Option B: Using Azure Portal

1. Navigate to Azure Portal → Create a resource
2. Search for Azure Bot
3. Click Create
4. Configure:
   - Bot handle: `opencode-teams-bot`
   - Subscription: Your subscription
   - Resource group: `shakudo-teams-bot` (create new if needed)
   - Pricing tier: F0 (Free)
   - Type of App: Single Tenant
   - Microsoft App ID: `691f2047-0585-4566-9129-d582c82b5e7d`
   - Microsoft App Tenant ID: `b01c976d-0f48-4c4e-8859-1b03b022911e`
5. Click Review + create → Create

### Configure Messaging Endpoint

1. Go to the created Bot resource
2. Navigate to Configuration
3. Set Messaging endpoint: `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages`
4. Click Apply

### Add Teams Channel

1. In the Bot resource, go to Channels
2. Click Microsoft Teams icon
3. Accept the Terms of Service
4. Click Apply

### Verify Bot Registration

```bash
# Check bot configuration
az bot show --name opencode-teams-bot --resource-group shakudo-teams-bot \
  --query "{endpoint:properties.endpoint}" -o json

# Verify Teams channel
az bot msteams show --name opencode-teams-bot --resource-group shakudo-teams-bot
```

## Step 3: Azure AD Security Group

Create a security group to control who can use the bot.

### Create Security Group

```bash
# Create group
az ad group create \
  --display-name "OpenCode Teams Bot Users" \
  --mail-nickname "opencode-bot-users" \
  --description "Users authorized to use the OpenCode Teams bot"

# Get group ID
az ad group show --group "OpenCode Teams Bot Users" --query "id" -o tsv
```

Example group ID: `9e1892be-12f9-48eb-a01c-134cbd04d3dd`

### Add Users to Group

```bash
# Add user by email
az ad group member add \
  --group "OpenCode Teams Bot Users" \
  --member-id $(az ad user show --id user@shakudo.io --query "id" -o tsv)

# List group members
az ad group member list --group "OpenCode Teams Bot Users" --query "[].userPrincipalName"
```

### Alternative: Use Azure Portal

1. Navigate to Azure Active Directory → Groups
2. Click New group
3. Configure:
   - Group type: Security
   - Group name: `OpenCode Teams Bot Users`
   - Group description: Users authorized to use the OpenCode Teams bot
4. Click Create
5. Add members via Members → Add members
6. Note the Object ID (group ID)

## Step 4: Deploy to Shakudo

Deploy the bot as a microservice on the Shakudo platform.

### Environment Variables

Prepare these environment variables from previous steps:

```bash
export AZURE_APP_ID="691f2047-0585-4566-9129-d582c82b5e7d"
export AZURE_APP_PASSWORD="your-client-secret-from-step-1"
export AZURE_TENANT_ID="b01c976d-0f48-4c4e-8859-1b03b022911e"
export AZURE_AD_AUTHORIZED_GROUP_ID="9e1892be-12f9-48eb-a01c-134cbd04d3dd"
export USER_EMAIL="your-email@shakudo.io"
```

### Option A: Using Shakudo Platform API

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
    { key: "AZURE_APP_PASSWORD", value: "your-client-secret" },
    { key: "AZURE_TENANT_ID", value: "b01c976d-0f48-4c4e-8859-1b03b022911e" },
    { key: "AZURE_AD_AUTHORIZED_GROUP_ID", value: "9e1892be-12f9-48eb-a01c-134cbd04d3dd" },
    { key: "TEAMS_BOT_PORT", value: "3978" }
  ]
)
```

### Option B: Using Deploy Script

```bash
cd scripts/deploy
./deploy-to-shakudo.sh
```

The script will output the required configuration. Use the Shakudo UI or API to create the microservice with these parameters.

### Verify Deployment

After deployment, the microservice will have:
- Microservice name: `opencode-teams-bot`
- Microservice ID: `cb289fb5-04d0-488f-b5b8-3af6d2c92d1e`
- In-cluster URL: `http://hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local:8787`
- Internal port: 3978 (Bot Framework standard)
- Exposed port: 8787 (Shakudo standard)

Check health endpoint:

```bash
# In-cluster (from within Shakudo)
curl http://hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local:8787/api/health
```

Expected response:
```json
{"status":"healthy","uptime":1234,"service":"opencode-teams-bot","version":"1.0.0"}
```

## Step 5: Configure Webhook Endpoint

The bot needs a public HTTPS endpoint for Azure Bot Framework to send messages.

### Request Webhook Exposure

On Shakudo, microservices are initially only accessible in-cluster. To expose the bot publicly:

1. Contact Shakudo platform admin
2. Request webhook exposure for microservice ID: `cb289fb5-04d0-488f-b5b8-3af6d2c92d1e`
3. Admin creates public webhook URL bypassing Keycloak authentication

### Webhook URL Pattern

```
https://{microservice-id-prefix}-webhook.dev.hyperplane.dev
```

Current deployment:
- Microservice ID: `cb289fb5-04d0-488f-b5b8-3af6d2c92d1e`
- Webhook URL: `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev`

### Verify Public Access

```bash
# Test health endpoint (public)
curl https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/health

# Expected: {"status":"healthy",...}
```

### Update Azure Bot Endpoint

If the webhook URL changes, update the Azure Bot Registration:

```bash
az bot update --name opencode-teams-bot --resource-group shakudo-teams-bot \
  --endpoint "https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages"
```

## Step 6: Package and Sideload Teams App

Create a Teams app manifest and sideload it to Microsoft Teams.

### Package the Manifest

```bash
cd teams-manifest

# Package with default Azure App ID
../scripts/package-manifest.sh

# Or specify custom output path
../scripts/package-manifest.sh /tmp/opencode-teams-bot.zip

# Or override Azure App ID
AZURE_APP_ID="your-app-id" ../scripts/package-manifest.sh
```

The script creates a zip file containing:
- `manifest.json` (with Azure App ID substituted)
- `icons/color.png` (192x192 PNG)
- `icons/outline.png` (32x32 PNG)

Default output: `/tmp/opencode-teams-bot.zip`

### Sideload to Teams

#### Option A: Teams Admin Center (Org-Wide)

1. Go to Teams Admin Center: https://admin.teams.microsoft.com
2. Navigate to Teams apps → Manage apps
3. Click Upload new app → Upload
4. Select `/tmp/opencode-teams-bot.zip`
5. The app appears in the org's app catalog
6. Users can install from the Teams app store

#### Option B: Teams Client (Personal Testing)

1. Open Microsoft Teams
2. Click Apps in the left sidebar
3. Click Manage your apps at the bottom
4. Click Upload a custom app → Upload for me or my teams
5. Select `/tmp/opencode-teams-bot.zip`
6. Click Add to install

#### Option C: Teams Developer Portal

1. Go to Teams Developer Portal: https://dev.teams.microsoft.com
2. Navigate to Apps → Import app
3. Upload `/tmp/opencode-teams-bot.zip`
4. Review and publish

### Install the Bot

After sideloading:

1. Find "OpenCode Bot" in Teams apps
2. Click Add to start a conversation
3. The bot should appear in your chat list

## Step 7: Test the Bot

Verify the bot is working correctly.

### Send Test Message

1. Open the bot conversation in Teams
2. Send a message: `Hello`
3. The bot should respond with a welcome message

### Test Authorization

The bot only responds to users in the authorized Azure AD security group.

If you're not in the group, you'll see:
```
You are not authorized to use this bot.
Please contact your administrator.
```

To authorize yourself:
```bash
az ad group member add \
  --group "OpenCode Teams Bot Users" \
  --member-id $(az ad user show --id your-email@shakudo.io --query "id" -o tsv)
```

### Test OpenCode Integration

Send a coding request:
```
Create a Python function that calculates fibonacci numbers
```

The bot should:
1. Show a processing indicator
2. Stream the response in an Adaptive Card
3. Update the card as the response generates
4. Show final response with code blocks

### Verify Logs

Check bot logs for errors:

```bash
# Using Shakudo platform tools
getPodEvents(jobId="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e", tailLines=100)
```

Or check the log file directly (if you have pod access):
```bash
tail -f /tmp/opencode-teams-plugin.log
```

## Step 8: Troubleshooting

### Bot Not Responding

#### Check Webhook Accessibility

```bash
# Test public endpoint
curl https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/health

# Should return: {"status":"healthy",...}
```

If you get a 302 redirect or 404:
- The microservice hasn't been converted to a webhook yet
- Contact Shakudo admin to expose it as a public webhook

#### Check Azure Bot Endpoint

```bash
az bot show --name opencode-teams-bot --resource-group shakudo-teams-bot \
  --query "{endpoint:properties.endpoint}" -o json
```

Verify the endpoint matches your webhook URL.

#### Check Environment Variables

Verify the microservice has all required environment variables:

```bash
# Using Shakudo platform tools
searchMicroservice(searchTerm="opencode-teams-bot")
```

Required variables:
- `AZURE_APP_ID`
- `AZURE_APP_PASSWORD`
- `AZURE_TENANT_ID`
- `AZURE_AD_AUTHORIZED_GROUP_ID`

### 401 Unauthorized Errors

This indicates authentication issues with Azure Bot Framework.

Check:
1. `AZURE_APP_ID` matches the Azure AD app registration
2. `AZURE_APP_PASSWORD` is correct and not expired
3. Client secret hasn't expired (check Azure Portal)

Regenerate secret if needed:
```bash
az ad app credential reset --id 691f2047-0585-4566-9129-d582c82b5e7d --years 2
```

### 403 Forbidden Errors

This indicates authorization issues (user not in security group).

Check:
1. User is a member of the authorized group
2. `AZURE_AD_AUTHORIZED_GROUP_ID` is correct
3. Admin consent was granted for `GroupMember.Read.All` permission

Verify group membership:
```bash
az ad group member check \
  --group 9e1892be-12f9-48eb-a01c-134cbd04d3dd \
  --member-id $(az ad user show --id user@shakudo.io --query "id" -o tsv)
```

### Webhook Failures

If Azure Bot Framework cannot reach the webhook:

1. Verify webhook URL is publicly accessible (not behind VPN)
2. Check SSL certificate is valid
3. Ensure endpoint path is `/api/messages`
4. Verify port 443 is open

Test from external network:
```bash
curl -v https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages
```

Expected: 500 error (Bot Framework SDK validates auth headers)
Not expected: Connection refused, timeout, or SSL errors

### Pod Keeps Crashing

Check pod logs:
```bash
getPodEvents(jobId="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e", tailLines=100)
```

Common issues:
- Missing `AZURE_APP_PASSWORD` environment variable
- Bun installation failure (network issues)
- Port conflict (ensure `TEAMS_BOT_PORT` matches code)
- Invalid Azure credentials

### Bot Returns 500 on /api/messages

This is expected if sending a test POST without Bot Framework authentication headers. The Bot Framework SDK validates the authorization token.

To test properly, send a message through Teams (not curl).

### App Package Invalid Error

When sideloading the manifest:

Check:
1. Icons are correct dimensions (192x192 and 32x32)
2. `manifest.json` is valid JSON (no template variables left)
3. `$schema` matches the `manifestVersion`

Validate manifest:
```bash
cat teams-manifest/manifest.json | jq .
```

### Bot Not Available for Organization

If you see "This app is not available for your organization":

1. Contact Teams admin to allow custom app uploads
2. Or use the Teams Developer Portal method
3. Check org policy: Teams Admin Center → Teams apps → Setup policies

## Environment Variables Reference

Complete list of environment variables with defaults from `src/teams/teams-config.ts`:

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AZURE_APP_ID` | Azure AD Application (client) ID | `691f2047-0585-4566-9129-d582c82b5e7d` |
| `AZURE_APP_PASSWORD` | Azure AD Application client secret | `your-secret-value` |
| `AZURE_TENANT_ID` | Azure AD Tenant ID | `b01c976d-0f48-4c4e-8859-1b03b022911e` |
| `AZURE_AD_AUTHORIZED_GROUP_ID` | Azure AD Security Group for authorization | `9e1892be-12f9-48eb-a01c-134cbd04d3dd` |

### Optional Variables (Server Configuration)

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAMS_BOT_PORT` | `3978` | Port the bot listens on internally (Bot Framework standard) |
| `TEAMS_BASE_PATH` | `/api` | Base path for bot endpoints |
| `TEAMS_HEALTH_PATH` | `/health` | Health check endpoint path |
| `TEAMS_MESSAGES_PATH` | `/messages` | Bot Framework messages endpoint path |

### Optional Variables (Bot Behavior)

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAMS_CARD_UPDATE_INTERVAL` | `5000` | Card update interval during streaming (ms) |
| `TEAMS_MAX_CARD_SIZE` | `25000` | Maximum card size before pagination (bytes, Teams limit ~28KB) |
| `TEAMS_RATE_LIMIT` | `30` | Teams API rate limit (requests per second, max 50) |
| `TEAMS_QUESTION_EXPIRATION_MS` | `1800000` | Question expiration time (30 minutes) |
| `TEAMS_PERMISSION_EXPIRATION_MS` | `300000` | Permission request expiration time (5 minutes) |
| `TEAMS_GUEST_APPROVAL_EXPIRATION_MS` | `1800000` | Guest approval expiration time (30 minutes) |
| `TEAMS_AUTH_CACHE_DURATION_MS` | `3600000` | Authorization check cache duration (1 hour) |

### Optional Variables (Logging)

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAMS_LOG_FILE` | `/tmp/opencode-teams-plugin.log` | Log file path |
| `TEAMS_DEBUG` | `false` | Enable debug logging |

### Optional Variables (OpenCode Connection)

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_SERVER_URL` | `http://localhost:4096` | OpenCode server URL |
| `OPENCODE_CONNECTION_TIMEOUT` | `5000` | Connection timeout (ms) |
| `OPENCODE_RECONNECT_INTERVAL` | `5000` | Reconnection interval on failure (ms) |
| `OPENCODE_MAX_RECONNECT_ATTEMPTS` | `10` | Maximum reconnection attempts |

### Optional Variables (Advanced)

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAMS_BOT_ENDPOINT` | (none) | Custom Bot Framework messaging endpoint URL (for multi-tenant scenarios) |

## Updating the Bot

After making code changes:

1. Commit and push to the branch:
   ```bash
   git add .
   git commit -m "[teams] your changes"
   git push origin opencode-mattermost-plugin-003-ms-teams-integration
   ```

2. Wait for git sync:
   ```bash
   checkGitServerSync()
   ```

3. Restart the microservice:
   ```bash
   restartService(id="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e")
   ```

4. Monitor logs:
   ```bash
   getPodEvents(jobId="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e", tailLines=100)
   ```

## Security Considerations

- Never commit `.env.azure` or client secrets to version control
- Client secrets expire after 2 years - set calendar reminders to rotate
- `GroupMember.Read.All` requires admin consent - coordinate with IT
- Use Azure Key Vault for production secret management
- Regularly review security group membership
- Monitor bot logs for unauthorized access attempts

## Additional Resources

- Azure Bot Service Documentation: https://docs.microsoft.com/en-us/azure/bot-service/
- Bot Framework SDK: https://github.com/microsoft/botbuilder-js
- Teams App Manifest Schema: https://docs.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema
- Adaptive Cards Designer: https://adaptivecards.io/designer/
- Teams Developer Portal: https://dev.teams.microsoft.com

## Support

For issues or questions:

1. Check bot logs: `/tmp/opencode-teams-plugin.log`
2. Review Azure Bot Service logs in Azure Portal
3. Verify webhook accessibility from external network
4. Check Shakudo microservice status
5. Contact Shakudo platform admin for webhook configuration issues
