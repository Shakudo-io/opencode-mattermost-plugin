# Microsoft Teams OpenCode Bot - Complete Deployment Guide

**Document Version**: 2026-02-11  
**Last Updated**: 2026-02-11  
**Status**: Production-Ready Deployment on Shakudo Platform

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Azure AD App Registration (8 Steps)](#azure-ad-app-registration-8-steps)
3. [Azure Bot Registration (4 Steps)](#azure-bot-registration-4-steps)
4. [Bot Code - Adapter Configuration](#bot-code---adapter-configuration)
5. [Deploy Shakudo Microservice (7 Steps)](#deploy-shakudo-microservice-7-steps)
6. [Create Webhook VirtualService (SECURITY CRITICAL)](#create-webhook-virtualservice-security-critical)
7. [Update Bot Registration Endpoint](#update-bot-registration-endpoint)
8. [Teams App Manifest (4 Steps)](#teams-app-manifest-4-steps)
9. [Sideload the App (3 Options)](#sideload-the-app-3-options)
10. [Test the Bot](#test-the-bot)
11. [Troubleshooting](#troubleshooting)
12. [Current Deployment Reference](#current-deployment-reference)

---

## Prerequisites

Before starting, ensure you have:

**Required Permissions:**
- Azure AD **Global Admin** or **Application Admin** role (for app registration and service principal creation)
- **Teams Admin** role or permission to upload custom apps (for sideloading)
- **Shakudo platform access** with microservice deployment permissions

**Required Tools:**
- Azure CLI installed: `az --version` (must be 2.0+)
- kubectl configured for Shakudo cluster: `kubectl config current-context`
- Git access to `kaji-opensource` repository

**Required Accounts:**
- Azure subscription (can be free tier)
- Microsoft Teams account (must be in your Azure AD tenant)
- Shakudo account at dev.hyperplane.dev

---

## Azure AD App Registration (8 Steps)

### Step 1: Create the Azure AD Application

Create an Azure AD application for the Bot Framework to authenticate with:

```bash
az ad app create \
  --display-name "OpenCode MS Teams Bot" \
  --sign-in-audience AzureADMyOrg
```

This creates a **SingleTenant** application (only users in your Azure AD can use the bot).

**Expected output:**
```json
{
  "appId": "691f2047-0585-4566-9129-d582c82b5e7d",
  "displayName": "OpenCode MS Teams Bot",
  ...
}
```

**Save the `appId` - this is your `AZURE_APP_ID`.**

> **NOTE:** `AzureADMyOrg` means only users in your Azure AD tenant can authenticate. For multi-tenant (cross-organization), use `AzureADMultipleOrgs`, but Microsoft's Bot Framework now recommends SingleTenant for new bots.

### Step 2: Create Service Principal

> **WARNING:** This step is NOT automatic when you create the app. Missing service principal causes cryptic error: `AADSTS7000229: Application was not found in the directory`.

```bash
az ad sp create --id 691f2047-0585-4566-9129-d582c82b5e7d
```

Replace `691f2047-0585-4566-9129-d582c82b5e7d` with your `appId` from Step 1.

**Expected output:**
```json
{
  "appId": "691f2047-0585-4566-9129-d582c82b5e7d",
  "displayName": "OpenCode MS Teams Bot",
  "servicePrincipalType": "Application",
  ...
}
```

> **WHY THIS MATTERS:** The service principal is the identity that Bot Framework uses to request tokens. Without it, Teams channel cannot get tokens for your bot, causing silent authentication failures.

### Step 3: Set Application ID URI

> **WARNING:** Missing Application ID URI causes silent token failures when the Teams channel tries to authenticate your bot.

```bash
az ad app update \
  --id 691f2047-0585-4566-9129-d582c82b5e7d \
  --identifier-uris "api://botid-691f2047-0585-4566-9129-d582c82b5e7d"
```

The URI **must** follow the pattern: `api://botid-{appId}`

**Verification:**
```bash
az ad app show --id 691f2047-0585-4566-9129-d582c82b5e7d --query identifierUris
```

Expected: `["api://botid-691f2047-0585-4566-9129-d582c82b5e7d"]`

> **NOTE:** The `botid-` prefix is a Bot Framework convention. Without it, token validation may fail for the Teams channel.

### Step 4: Create Client Secret

```bash
az ad app credential reset \
  --id 691f2047-0585-4566-9129-d582c82b5e7d \
  --years 2
```

**Expected output:**
```json
{
  "appId": "691f2047-0585-4566-9129-d582c82b5e7d",
  "password": "AbC123xyz~EXTREMELY_LONG_SECRET_STRING",
  "tenant": "b01c976d-0f48-4c4e-8859-1b03b022911e"
}
```

**Save the `password` - this is your `AZURE_APP_PASSWORD`. It will NOT be shown again.**

> **WARNING:** Each `az ad app credential reset` invalidates ALL previous secrets. If you run this command again, you must update all deployed services with the new secret immediately.

### Step 5: Note Your Tenant ID

```bash
az account show --query tenantId -o tsv
```

**Expected output:**
```
b01c976d-0f48-4c4e-8859-1b03b022911e
```

**Save this - this is your `AZURE_TENANT_ID`.**

### Step 6: Add Microsoft Graph API Permission (GroupMember.Read.All)

The bot needs to check Azure AD group membership for authorization. This requires the `GroupMember.Read.All` application permission.

**Find the Microsoft Graph Service Principal ID:**
```bash
GRAPH_SP=$(az ad sp list --filter "displayName eq 'Microsoft Graph'" --query "[0].id" -o tsv)
echo $GRAPH_SP
```

**Find the GroupMember.Read.All App Role ID:**
```bash
ROLE_ID=$(az ad sp show --id $GRAPH_SP \
  --query "appRoles[?value=='GroupMember.Read.All'].id" -o tsv)
echo $ROLE_ID
```

Expected: `bc024368-1153-4739-b217-4326f2e966d0`

**Grant the permission:**
```bash
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$(az ad sp show --id 691f2047-0585-4566-9129-d582c82b5e7d --query id -o tsv)/appRoleAssignments" \
  --headers "Content-Type=application/json" \
  --body "{
    \"principalId\": \"$(az ad sp show --id 691f2047-0585-4566-9129-d582c82b5e7d --query id -o tsv)\",
    \"resourceId\": \"$GRAPH_SP\",
    \"appRoleId\": \"$ROLE_ID\"
  }"
```

**Expected output:**
```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#servicePrincipals('...')/appRoleAssignments/$entity",
  "id": "...",
  "principalId": "...",
  "resourceId": "...",
  "appRoleId": "bc024368-1153-4739-b217-4326f2e966d0"
}
```

> **NOTE:** This is an **application permission**, not a delegated permission. It requires admin consent (granted automatically by the command above if you have admin role).

### Step 7: Create Azure AD Security Group for Authorization

```bash
az ad group create \
  --display-name "OpenCode Teams Bot Users" \
  --mail-nickname "opencode-bot-users" \
  --description "Users authorized to use the OpenCode Teams bot"
```

**Expected output:**
```json
{
  "id": "9e1892be-12f9-48eb-a01c-134cbd04d3dd",
  "displayName": "OpenCode Teams Bot Users",
  ...
}
```

**Save the `id` - this is your `AZURE_AD_AUTHORIZED_GROUP_ID`.**

### Step 8: Add Yourself to the Security Group

```bash
# Get your user ID
YOUR_USER_ID=$(az ad user show --id your-email@shakudo.io --query id -o tsv)

# Add to group
az ad group member add \
  --group 9e1892be-12f9-48eb-a01c-134cbd04d3dd \
  --member-id $YOUR_USER_ID
```

**Verify membership:**
```bash
az ad group member check \
  --group 9e1892be-12f9-48eb-a01c-134cbd04d3dd \
  --member-id $YOUR_USER_ID
```

Expected: `true`

---

## Azure Bot Registration (4 Steps)

### Step 9: Create Bot Registration via REST API

> **NOTE:** `az bot create` doesn't support all required options (specifically `acceptedTerms` for Teams channel), so we use REST API directly.

**Create the bot registration:**
```bash
RESOURCE_GROUP="shakudo-teams-bot"
BOT_NAME="opencode-teams-bot"
APP_ID="691f2047-0585-4566-9129-d582c82b5e7d"
TENANT_ID="b01c976d-0f48-4c4e-8859-1b03b022911e"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Create resource group if it doesn't exist
az group create --name $RESOURCE_GROUP --location eastus

# Create bot via REST API
az rest --method PUT \
  --uri "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.BotService/botServices/$BOT_NAME?api-version=2021-05-01-preview" \
  --body "{
    \"location\": \"global\",
    \"sku\": {
      \"name\": \"F0\"
    },
    \"kind\": \"azurebot\",
    \"properties\": {
      \"displayName\": \"OpenCode MS Teams Bot\",
      \"description\": \"AI coding assistant for Microsoft Teams\",
      \"endpoint\": \"https://PLACEHOLDER.dev.hyperplane.dev/api/messages\",
      \"msaAppId\": \"$APP_ID\",
      \"msaAppTenantId\": \"$TENANT_ID\",
      \"msaAppType\": \"SingleTenant\",
      \"schemaTransformationVersion\": \"1.3\",
      \"isIsolated\": false,
      \"publicNetworkAccess\": \"Enabled\"
    }
  }"
```

> **NOTE:** The endpoint is a placeholder - we'll update it after deploying the Shakudo microservice (Step 13).

**Expected output:**
```json
{
  "id": "/subscriptions/.../resourceGroups/shakudo-teams-bot/providers/Microsoft.BotService/botServices/opencode-teams-bot",
  "location": "global",
  "name": "opencode-teams-bot",
  "properties": {
    "endpoint": "https://PLACEHOLDER.dev.hyperplane.dev/api/messages",
    "msaAppId": "691f2047-0585-4566-9129-d582c82b5e7d",
    ...
  },
  "sku": {
    "name": "F0"
  }
}
```

> **WARNING:** SingleTenant is required for our configuration. Microsoft deprecated MultiTenant bot creation (it defaults to SingleTenant now).

### Step 10: Add Teams Channel with acceptedTerms=true

> **WARNING:** The `acceptedTerms` field defaults to `false` and MUST be set to `true`, or Teams will not route messages to your bot. This is a silent failure - the channel shows as enabled, but messages don't arrive.

```bash
az rest --method PUT \
  --uri "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.BotService/botServices/$BOT_NAME/channels/MsTeamsChannel?api-version=2021-05-01-preview" \
  --body "{
    \"properties\": {
      \"channelName\": \"MsTeamsChannel\",
      \"properties\": {
        \"acceptedTerms\": true,
        \"enableCalling\": false,
        \"isEnabled\": true
      }
    }
  }"
```

**Expected output:**
```json
{
  "id": "/subscriptions/.../channels/MsTeamsChannel",
  "name": "opencode-teams-bot/MsTeamsChannel",
  "properties": {
    "channelName": "MsTeamsChannel",
    "properties": {
      "acceptedTerms": true,
      "isEnabled": true
    }
  }
}
```

**Verify the channel:**
```bash
az rest --method GET \
  --uri "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.BotService/botServices/$BOT_NAME/channels/MsTeamsChannel?api-version=2021-05-01-preview"
```

Confirm `acceptedTerms: true` in the output.

### Step 11: Verify Bot Registration

```bash
az bot show --name $BOT_NAME --resource-group $RESOURCE_GROUP
```

**Check these fields:**
- `properties.endpoint` - will be placeholder for now (we'll update in Step 13)
- `properties.msaAppId` - matches your `AZURE_APP_ID`
- `properties.msaAppType` - is `SingleTenant`

### Step 12: Test Bot in Azure Portal Web Chat (Optional)

Navigate to: https://portal.azure.com → Resource Groups → `shakudo-teams-bot` → `opencode-teams-bot` → Test in Web Chat

> **NOTE:** This will fail until we deploy the microservice and update the endpoint in Step 13. The Web Chat test requires a working HTTPS endpoint.

---

## Bot Code - Adapter Configuration

The Bot Framework authentication pattern is critical. Using the WRONG pattern causes failures that only manifest in the Teams channel (not in Web Chat or other channels).

### ❌ WRONG Pattern (Single-Argument)

This pattern does NOT work correctly with SingleTenant for Teams channel:

```typescript
// DON'T USE THIS
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: appId,
  MicrosoftAppPassword: appPassword,
  MicrosoftAppTenantId: tenantId,
  MicrosoftAppType: "SingleTenant",
});

const adapter = new CloudAdapter(credentialsFactory);  // ❌ WRONG
```

**Why it fails:** The single-argument constructor doesn't properly configure token exchange for SingleTenant when used with the Teams channel. Bot responses work in Web Chat but fail silently in Teams.

### ✅ CORRECT Pattern (Two-Step)

This is the pattern used by Microsoft's official Teams samples and is implemented in `src/teams/teams-adapter.ts`:

```typescript
// Step 1: Create credentials factory
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: appId,
  MicrosoftAppPassword: appPassword,
  MicrosoftAppTenantId: tenantId,
  MicrosoftAppType: "SingleTenant",
});

// Step 2: Create BotFramework authentication with EMPTY config + factory
const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(
  {},  // ← EMPTY config object is critical
  credentialsFactory
);

// Step 3: Create adapter with authentication
const adapter = new CloudAdapter(botFrameworkAuth);  // ✅ CORRECT
```

**Why this works:** The two-step pattern with empty config tells the SDK to use the factory's credential handling instead of the default token endpoint. This properly handles SingleTenant token exchange for Teams channel.

**Reference implementations:**
- [Azure-Samples/chat-with-your-data-solution-accelerator](https://github.com/Azure-Samples/chat-with-your-data-solution-accelerator) (uses this pattern)
- [OfficeDev/microsoft-365-agents-toolkit-samples](https://github.com/OfficeDev/microsoft-365-agents-toolkit-samples) (uses this pattern)

**Our implementation:** See `src/teams/teams-adapter.ts` lines 47-64 for the complete implementation.

---

## Deploy Shakudo Microservice (7 Steps)

### Step 13: Prepare Environment Variables

```bash
export AZURE_APP_ID="691f2047-0585-4566-9129-d582c82b5e7d"
export AZURE_APP_PASSWORD="AbC123xyz~YOUR_SECRET_FROM_STEP_4"
export AZURE_TENANT_ID="b01c976d-0f48-4c4e-8859-1b03b022911e"
export AZURE_AD_AUTHORIZED_GROUP_ID="9e1892be-12f9-48eb-a01c-134cbd04d3dd"
export USER_EMAIL="your-email@shakudo.io"
```

### Step 14: Understand Shakudo Deployment Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `name` | `opencode-teams-bot` | Microservice name (must be unique) |
| `environment` | `basic-ai-tools-small` | Pod spec (CPU/RAM allocation) |
| `gitServer` | `kaji-opensource` | Git server name in Shakudo |
| `branch` | `opencode-mattermost-plugin-003-ms-teams-integration` | Git branch to deploy |
| `workingDirectory` | `/tmp/git/monorepo/` | ⚠️ CRITICAL - see warning below |
| `script` | `scripts/deploy/run.sh` | Entrypoint script (relative to repo root) |
| `port` | `8787` | **Exposed port** (external) - Shakudo standard |

> **WARNING:** The `workingDirectory` defaults to `/tmp/git/monorepo/{microservice-name}/` which does NOT exist for this non-monorepo repository. You **MUST** explicitly set it to `/tmp/git/monorepo/` (without the trailing service name) or the pod will fail with "directory not found" error.

### Step 15: Understand Port Configuration

The bot has TWO port numbers you must understand:

| Port | Purpose | Environment Variable |
|------|---------|---------------------|
| **3978** | Internal port the Express server listens on | `TEAMS_BOT_PORT=3978` |
| **8787** | External port exposed by Shakudo LoadBalancer | `port` parameter in createMicroservice |

**Port mapping:** Shakudo maps external `8787` → internal `3978`.

> **WARNING:** Both ports must match their intended purpose:
> - `TEAMS_BOT_PORT` must match what the Express server listens on (default: 3978, Bot Framework standard)
> - Shakudo `port` parameter should be `8787` (Shakudo microservice standard)
> - If they don't match, the pod will start but the webhook won't route traffic correctly

### Step 16: Deploy the Microservice

Using Shakudo platform tools:

```typescript
createMicroservice({
  name: "opencode-teams-bot",
  environment: "basic-ai-tools-small",
  gitServer: "kaji-opensource",
  branch: "opencode-mattermost-plugin-003-ms-teams-integration",
  workingDirectory: "/tmp/git/monorepo/",  // ← CRITICAL: explicit override
  script: "scripts/deploy/run.sh",
  port: 8787,  // ← External port (Shakudo standard)
  userEmail: "your-email@shakudo.io",
  parameters: [
    { key: "AZURE_APP_ID", value: "691f2047-0585-4566-9129-d582c82b5e7d" },
    { key: "AZURE_APP_PASSWORD", value: "AbC123xyz~YOUR_SECRET" },
    { key: "AZURE_TENANT_ID", value: "b01c976d-0f48-4c4e-8859-1b03b022911e" },
    { key: "AZURE_AD_AUTHORIZED_GROUP_ID", value: "9e1892be-12f9-48eb-a01c-134cbd04d3dd" },
    { key: "TEAMS_BOT_PORT", value: "3978" }  // ← Internal port (Bot Framework standard)
  ]
})
```

**Expected output:**
```json
{
  "id": "cb289fb5-04d0-488f-b5b8-3af6d2c92d1e",
  "name": "opencode-teams-bot",
  "status": "pending",
  ...
}
```

**Save the `id` - this is your microservice ID.**

### Step 17: Wait for Microservice to Start

```bash
# Poll microservice status
searchMicroservice(searchTerm: "opencode-teams-bot")
```

Wait until `status: "running"` (typically 2-3 minutes for bun install + dependencies).

### Step 18: Verify Health Endpoint (In-Cluster)

```bash
# Get in-cluster URL (first 6 chars of microservice ID)
MICROSERVICE_ID="cb289fb5-04d0-488f-b5b8-3af6d2c92d1e"
FIRST_6=$(echo $MICROSERVICE_ID | cut -c1-6)
echo "In-cluster URL: http://hyperplane-service-$FIRST_6.hyperplane-pipelines.svc.cluster.local:8787"

# Test health endpoint (from within cluster)
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
  curl http://hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local:8787/api/health
```

**Expected response:**
```json
{"status":"healthy","uptime":123,"service":"opencode-teams-bot","version":"1.0.0"}
```

> **NOTE:** This endpoint is NOT publicly accessible yet - we'll expose it as a webhook in Step 19.

### Step 19: Check Pod Logs for Errors

```bash
getPodEvents(jobId: "cb289fb5-04d0-488f-b5b8-3af6d2c92d1e", tailLines: 100)
```

Look for:
- ✅ `"MS Teams bot server started on port 3978"`
- ✅ `"CloudAdapter created successfully"`
- ✅ `"Health check endpoint: GET /api/health"`
- ❌ Any ERROR or WARN lines (indicates config problems)

---

## Create Webhook VirtualService (SECURITY CRITICAL)

### Step 20: Understand Webhook Security Model

> **⚠️ SECURITY WARNING:** This creates a PUBLIC internet-facing endpoint that bypasses Keycloak authentication. Bot Framework requires unauthenticated webhook access (it validates requests using JWT signatures in the request body).

**What we're creating:**
- **Public URL:** `https://{microservice-id}-webhook.dev.hyperplane.dev`
- **Access:** No Keycloak login required (anyone can POST to this URL)
- **Security:** Bot Framework validates incoming requests using JWT signature with your `AZURE_APP_PASSWORD`
- **Scope:** ONLY the `/api/messages` endpoint should be exposed (not all endpoints)

**Network flow:**
```
Azure Bot Framework (bot.azure.com)
  │ HTTPS POST with JWT signature
  ↓
Shakudo Ingress (dev.hyperplane.dev)
  │ VirtualService routes to in-cluster service
  ↓
Microservice Pod (port 8787)
  │ CloudAdapter validates JWT signature
  ↓
Bot code processes message
```

### Step 21: Create the VirtualService Manifest

The VirtualService must:
1. Match the webhook URL pattern: `{microservice-id}-webhook.dev.hyperplane.dev`
2. Route to the microservice in-cluster URL
3. Be excluded from Keycloak AuthorizationPolicy

**Create the manifest:**

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: hyperplane-service-cb289fb5-webhook
  namespace: hyperplane-pipelines
spec:
  hosts:
    - "bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev"
  gateways:
    - istio-system/hyperplane-gateway
  http:
    - match:
        - uri:
            prefix: /
      route:
        - destination:
            host: hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local
            port:
              number: 8787
```

**Naming conventions:**
- **VirtualService name:** `hyperplane-service-{first-6-chars-of-id}-webhook`
- **Host (webhook URL):** Use the EXACT pattern from [Current Deployment Reference](#current-deployment-reference) table (this is pre-assigned by platform team)

> **NOTE:** The webhook URL (`bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev`) is assigned by the Shakudo platform team. The first 6 characters of this UUID match the microservice ID. If you're deploying a NEW bot, coordinate with platform team to get your webhook URL.

### Step 22: Apply the VirtualService

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: hyperplane-service-cb289fb5-webhook
  namespace: hyperplane-pipelines
spec:
  hosts:
    - "bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev"
  gateways:
    - istio-system/hyperplane-gateway
  http:
    - match:
        - uri:
            prefix: /
      route:
        - destination:
            host: hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local
            port:
              number: 8787
EOF
```

**Expected output:**
```
virtualservice.networking.istio.io/hyperplane-service-cb289fb5-webhook created
```

### Step 23: Update Keycloak AuthorizationPolicy Exclusion

The webhook URL must be excluded from Keycloak authentication. This is typically done by the platform team.

> **WARNING:** Do NOT modify the main AuthorizationPolicy or Keycloak configurations yourself. Coordinate with platform admin to add your webhook URL to the exclusion list.

**What the platform admin needs to add:**

```yaml
# This is added to the existing AuthorizationPolicy by platform team
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: hyperplane-authz
  namespace: hyperplane-pipelines
spec:
  # ... existing rules ...
  rules:
    - to:
        - operation:
            hosts:
              - "bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev"
      when:
        - key: request.headers[x-forwarded-for]
          notValues:
            - "*"  # Allow from any IP (Bot Framework uses dynamic IPs)
```

### Step 24: Test Public Webhook Endpoint

```bash
curl https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/health
```

**Expected response:**
```json
{"status":"healthy","uptime":456,"service":"opencode-teams-bot","version":"1.0.0"}
```

**If you get:**
- **302 redirect to Keycloak login** → VirtualService not applied or not excluded from AuthorizationPolicy
- **404 Not Found** → VirtualService host doesn't match the URL, or gateway not configured
- **Connection timeout** → Microservice not running or wrong destination port in VirtualService
- **SSL certificate error** → DNS not propagated yet (wait 5 minutes)

### Step 25: Test Bot Framework Webhook (Expected to Fail)

```bash
curl -X POST https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages \
  -H "Content-Type: application/json" \
  -d '{"type":"message","text":"test"}'
```

**Expected response:**
```json
{"error":{"message":"Unauthorized. Invalid AppId passed on token: null"}}
```

or HTTP 401/500.

> **NOTE:** This is CORRECT behavior. The Bot Framework SDK validates the JWT signature, which our test request doesn't have. Only Azure Bot Framework can send valid requests. We'll test properly via Teams in Step 30.

> **WARNING:** If Step 25 returns 200 OK or the bot processes your message, your authentication is NOT working correctly. The bot should REJECT unauthenticated requests.

### Step 26: Cleanup Procedure (When Decommissioning)

> **WARNING:** When you delete the microservice, you MUST also delete the VirtualService. Orphaned VirtualServices can cause routing conflicts.

```bash
# When decommissioning the bot:
kubectl delete virtualservice hyperplane-service-cb289fb5-webhook -n hyperplane-pipelines
```

---

## Update Bot Registration Endpoint

### Step 27: Update Azure Bot Endpoint with Webhook URL

Now that the webhook is publicly accessible, update the Azure Bot Registration:

```bash
RESOURCE_GROUP="shakudo-teams-bot"
BOT_NAME="opencode-teams-bot"
WEBHOOK_URL="https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev"

az rest --method PATCH \
  --uri "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.BotService/botServices/$BOT_NAME?api-version=2021-05-01-preview" \
  --body "{
    \"properties\": {
      \"endpoint\": \"$WEBHOOK_URL/api/messages\"
    }
  }"
```

**Expected output:**
```json
{
  "properties": {
    "endpoint": "https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages",
    ...
  }
}
```

### Step 28: Verify Endpoint Update

```bash
az bot show --name $BOT_NAME --resource-group $RESOURCE_GROUP \
  --query "properties.endpoint" -o tsv
```

**Expected output:**
```
https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages
```

---

## Teams App Manifest (4 Steps)

### Step 29: Understand Manifest Structure

The Teams app manifest (`manifest.json`) defines:
- **App identity:** `id` field MUST match your `AZURE_APP_ID`
- **Bot configuration:** `bots[0].botId` MUST match your `AZURE_APP_ID`
- **Valid domains:** Must include your webhook domain + Bot Framework domains

**Required files:**
```
teams-manifest/
├── manifest.json       # App definition (191 lines)
├── icons/
│   ├── color.png       # 192x192 PNG, any background
│   └── outline.png     # 32x32 PNG, MUST have transparent background
```

### Step 30: Create manifest.json

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "691f2047-0585-4566-9129-d582c82b5e7d",
  "packageName": "io.shakudo.opencode",
  "developer": {
    "name": "Shakudo",
    "websiteUrl": "https://shakudo.io",
    "privacyUrl": "https://shakudo.io/privacy",
    "termsOfUseUrl": "https://shakudo.io/terms"
  },
  "icons": {
    "color": "icons/color.png",
    "outline": "icons/outline.png"
  },
  "name": {
    "short": "OpenCode Bot",
    "full": "OpenCode AI Coding Assistant"
  },
  "description": {
    "short": "AI coding assistant for Microsoft Teams",
    "full": "OpenCode brings AI-powered coding assistance directly into Microsoft Teams. Get code reviews, debugging help, and architecture guidance through natural conversation."
  },
  "accentColor": "#4A90E2",
  "bots": [
    {
      "botId": "691f2047-0585-4566-9129-d582c82b5e7d",
      "scopes": [
        "personal",
        "team",
        "groupchat"
      ],
      "supportsFiles": false,
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false
    }
  ],
  "permissions": [
    "identity",
    "messageTeamMembers"
  ],
  "validDomains": [
    "bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev",
    "token.botframework.com"
  ]
}
```

**Key fields to verify:**
- `id` = `bots[0].botId` = `AZURE_APP_ID` (all three must match)
- `validDomains` includes your webhook domain (without `https://`)
- `validDomains` includes `token.botframework.com` (required for Bot Framework auth)

> **WARNING:** Do NOT include `webApplicationInfo` section unless you're implementing Teams SSO. If `identifierUris` in your Azure AD app doesn't match `webApplicationInfo.id` in the manifest, Teams will reject the upload with a cryptic error.

### Step 31: Create Icons

**Color icon (`icons/color.png`):**
- Dimensions: 192x192 pixels
- Format: PNG
- Background: Any color (will be displayed in Teams app gallery)

**Outline icon (`icons/outline.png`):**
- Dimensions: 32x32 pixels
- Format: PNG
- Background: **MUST be transparent** (required by Developer Portal, optional for Teams client upload)

> **WARNING:** The Developer Portal is stricter than the Teams client about icon transparency. If you get "invalid icon" error in Developer Portal, ensure `outline.png` has a fully transparent background.

### Step 32: Package as ZIP

```bash
cd teams-manifest
zip -r ../opencode-teams-bot.zip manifest.json icons/
cd ..
```

**Verify the ZIP structure:**
```bash
unzip -l opencode-teams-bot.zip
```

**Expected output:**
```
Archive:  opencode-teams-bot.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
     1234  01-01-2026 10:00   manifest.json
    12345  01-01-2026 10:00   icons/color.png
     6789  01-01-2026 10:00   icons/outline.png
---------                     -------
    20368                     3 files
```

> **NOTE:** The ZIP must contain `manifest.json` at the root (not inside a subfolder). `icons/` must be a subfolder.

---

## Sideload the App (3 Options)

### Step 33: Choose Your Sideload Method

| Method | Scope | Requires | Best For |
|--------|-------|----------|----------|
| **Teams Client** | Personal or team | Upload permission | Quick testing |
| **Teams Admin Center** | Org-wide | Teams Admin role | Production deployment |
| **Developer Portal** | Org-wide | Developer Portal access | Iterative development |

### Option A: Teams Client (Personal Upload)

1. Open **Microsoft Teams** (desktop or web)
2. Click **Apps** in the left sidebar
3. Click **Manage your apps** (bottom left)
4. Click **Upload a custom app** → **Upload for me**
5. Select `opencode-teams-bot.zip`
6. Click **Add**

**If you see: "This app is not available for your organization":**
- Your Teams admin disabled custom app uploads
- Contact admin to enable: Teams Admin Center → Setup policies → "Upload custom apps" = On
- Or use Option B (Teams Admin Center) instead

**If upload succeeds:**
- The bot appears in your **Apps** list
- Click **Add** to start a 1:1 conversation

### Option B: Teams Admin Center (Org-Wide)

1. Navigate to: https://admin.teams.microsoft.com
2. Click **Teams apps** → **Manage apps**
3. Click **Upload new app** → **Upload**
4. Select `opencode-teams-bot.zip`
5. Click **Upload**

**Expected result:**
- App appears in org's app catalog with status: "Allowed"
- All users can discover the bot in Teams app store

**If you see: "App validation failed":**
- Check the error message for specific field issues
- Common errors:
  - `id` doesn't match `bots[0].botId` → fix manifest.json
  - Invalid icon dimensions → regenerate icons/color.png or icons/outline.png
  - `webApplicationInfo.id` mismatch → remove `webApplicationInfo` section or fix `identifierUris`

> **NOTE:** After uploading via Admin Center, there may be a 5-10 minute delay before users can discover the bot in their Teams client.

### Option C: Developer Portal (For Iterative Development)

1. Navigate to: https://dev.teams.microsoft.com
2. Click **Apps** → **Import app**
3. Select `opencode-teams-bot.zip`
4. Review the imported app details
5. Click **Publish** → **Publish to your org**

**Benefits:**
- Inline manifest validation with helpful error messages
- Can edit manifest in web UI without re-packaging ZIP
- Can test in Teams Web directly from Developer Portal

**If you see: "Invalid icon" error:**
- The outline.png doesn't have transparent background
- Regenerate `icons/outline.png` with transparency
- The Developer Portal is stricter about this than Teams client

> **WARNING:** Do NOT click "Publish to Teams store" unless you intend to submit the app for public distribution (requires Microsoft certification).

### Step 34: Verify App Installation

After sideloading (any method):

1. Open **Teams** → **Apps**
2. Search for "OpenCode Bot"
3. Verify the app appears with your color icon
4. Click **Add** to start a conversation

---

## Test the Bot

### Step 35: Test in Azure Portal Web Chat (Optional)

Before testing in Teams, verify the webhook works via Azure Portal:

1. Navigate to: https://portal.azure.com
2. Go to Resource Groups → `shakudo-teams-bot` → `opencode-teams-bot`
3. Click **Test in Web Chat** (left sidebar)
4. Type: `hello`

**Expected result:**
- Bot responds with welcome message: "I'm OpenCode, your AI coding assistant..."

**If you see:**
- **"There was an error sending this message to your bot: HTTP status code Unauthorized"**
  - The webhook endpoint is not accessible or authentication failed
  - Check Step 24 (webhook health endpoint should return 200)
  - Check `AZURE_APP_PASSWORD` matches the secret from Step 4

- **"There was an error sending this message to your bot: HTTP status code InternalServerError"**
  - Bot code crashed while processing the message
  - Check pod logs: `getPodEvents(jobId: "cb289fb5-04d0-488f-b5b8-3af6d2c92d1e")`

- **No response (spinning indicator)**
  - Webhook not reachable (timeout)
  - Verify Step 24 (public webhook URL should be accessible)

### Step 36: Test Authorization in Teams

1. Open the bot conversation in Teams
2. Send a message: `hello`

**Expected result (if you're in the authorized group):**
- Bot responds with welcome message

**Expected result (if you're NOT in the authorized group):**
```
❌ Access Denied

You are not authorized to use this bot.
Please contact your administrator to be added to the authorized users group.
```

**To authorize yourself:**
```bash
az ad group member add \
  --group 9e1892be-12f9-48eb-a01c-134cbd04d3dd \
  --member-id $(az ad user show --id your-email@shakudo.io --query id -o tsv)
```

> **NOTE:** Azure AD group membership changes can take 1-5 minutes to propagate. The bot caches authorization checks for 1 hour. If you just added yourself and still see "Access Denied", wait 5 minutes then send another message.

### Step 37: Test OpenCode Integration

Send a coding request:

```
Create a Python function that calculates the factorial of a number
```

**Expected behavior:**
1. Bot shows "🤖 Processing..." status card
2. Status card updates every 5 seconds with partial response
3. After response completes (~10-30 seconds), final response card appears with formatted code

**Expected final response:**
```python
def factorial(n: int) -> int:
    """Calculate the factorial of a number."""
    if n < 0:
        raise ValueError("Factorial is not defined for negative numbers")
    if n == 0 or n == 1:
        return 1
    return n * factorial(n - 1)
```

**If bot doesn't respond:**
- Check pod logs: `getPodEvents(jobId: "cb289fb5-04d0-488f-b5b8-3af6d2c92d1e")`
- Check OpenCode server is running: `curl http://localhost:4096/health` (from within pod)
- Check environment variable: `OPENCODE_SERVER_URL=http://localhost:4096` (default)

### Step 38: Test Question Flow (Optional)

Send a request that triggers an AI question:

```
Create a web server in either Python or Node.js
```

**Expected behavior:**
1. Bot shows question card with options:
   - **1.** Python - Flask or FastAPI
   - **2.** Node.js - Express
   - **3.** Other - Type your own answer

2. Click option **1**

3. Bot continues execution with Python as the selected answer

### Step 39: Test Permission Flow (Optional)

Send a request that requires tool permission:

```
Delete all .log files in /tmp
```

**Expected behavior:**
1. Bot shows permission request card:
   - **Tool:** bash
   - **Command:** `rm /tmp/*.log`
   - **Risk:** high
   - Options: [Approve Once] [Deny] [Approve All for Session]

2. Click **Approve Once**

3. Bot executes the command and shows the output

> **WARNING:** Be careful with permission approval for destructive commands. The bot WILL execute the command if you approve it.

---

## Troubleshooting

### Bot Works in Web Chat but Not Teams

**Symptoms:**
- Azure Portal Web Chat responds correctly
- Teams shows "Something went wrong" or no response

**Root cause:**
- Incorrect adapter configuration (single-arg pattern instead of two-step)
- Missing Application ID URI (`api://botid-{appId}`)
- Missing service principal (causes AADSTS7000229 error)

**Fix:**

1. **Verify Application ID URI:**
   ```bash
   az ad app show --id 691f2047-0585-4566-9129-d582c82b5e7d --query identifierUris
   ```
   Should return: `["api://botid-691f2047-0585-4566-9129-d582c82b5e7d"]`

   If empty, run Step 3 again.

2. **Verify service principal exists:**
   ```bash
   az ad sp show --id 691f2047-0585-4566-9129-d582c82b5e7d
   ```
   Should return app details.

   If error "not found", run Step 2 again.

3. **Check adapter configuration:**
   Review `src/teams/teams-adapter.ts` lines 47-64. Ensure it uses the two-step pattern (ConfigurationBotFrameworkAuthentication with empty config + factory).

4. **Check Teams channel acceptedTerms:**
   ```bash
   az rest --method GET \
     --uri "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.BotService/botServices/$BOT_NAME/channels/MsTeamsChannel?api-version=2021-05-01-preview"
   ```
   Verify: `properties.acceptedTerms: true`

   If false, run Step 10 again.

### "Something went wrong" on App Upload

**Symptoms:**
- Teams client shows generic error when uploading ZIP
- No specific error message

**Common causes & fixes:**

1. **webApplicationInfo section present but identifierUris not configured:**
   - Remove the `webApplicationInfo` section from manifest.json entirely
   - Or configure SSO properly (see Microsoft Teams SSO documentation)

2. **Icon transparency issue (Developer Portal only):**
   - Regenerate `icons/outline.png` with fully transparent background
   - Use PNG optimization tool to ensure proper alpha channel

3. **Manifest JSON syntax error:**
   ```bash
   cat manifest.json | jq .
   ```
   Should parse without errors.

4. **Invalid ZIP structure:**
   ```bash
   unzip -l opencode-teams-bot.zip
   ```
   Ensure `manifest.json` is at root (not inside a subfolder).

### Bot Not Responding to Messages

**Symptoms:**
- Message sent in Teams
- No response or error from bot

**Diagnostic steps:**

1. **Check webhook accessibility:**
   ```bash
   curl https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/health
   ```
   Should return `200 OK` with JSON health response.

   If 302 redirect → VirtualService not excluded from Keycloak (contact platform admin)
   If timeout → Microservice not running or wrong destination in VirtualService

2. **Check bot registration endpoint:**
   ```bash
   az bot show --name opencode-teams-bot --resource-group shakudo-teams-bot \
     --query "properties.endpoint" -o tsv
   ```
   Should return: `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages`

   If different, run Step 27 again.

3. **Check pod logs:**
   ```bash
   getPodEvents(jobId: "cb289fb5-04d0-488f-b5b8-3af6d2c92d1e", tailLines: 100)
   ```
   Look for incoming POST requests to `/api/messages` and any ERROR lines.

4. **Check Azure Bot channels:**
   ```bash
   az rest --method GET \
     --uri "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.BotService/botServices/$BOT_NAME/channels?api-version=2021-05-01-preview"
   ```
   Verify `MsTeamsChannel` is present and `isEnabled: true`.

### "Access Denied" in Teams

**Symptoms:**
- Bot responds but says "You are not authorized to use this bot"

**Fix:**

1. **Verify you're in the authorized group:**
   ```bash
   az ad group member check \
     --group 9e1892be-12f9-48eb-a01c-134cbd04d3dd \
     --member-id $(az ad user show --id your-email@shakudo.io --query id -o tsv)
   ```

   If `false`, add yourself: run Step 8 again.

2. **Wait for propagation:**
   - Azure AD group changes take 1-5 minutes to propagate
   - Bot caches authorization checks for 1 hour
   - Wait 5 minutes, then try again

3. **Verify Graph API permission:**
   ```bash
   az rest --method GET \
     --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$(az ad sp show --id 691f2047-0585-4566-9129-d582c82b5e7d --query id -o tsv)/appRoleAssignments"
   ```
   Look for `appRoleId: "bc024368-1153-4739-b217-4326f2e966d0"` (GroupMember.Read.All).

   If missing, run Step 6 again.

4. **Check bot logs for Graph API errors:**
   ```bash
   getPodEvents(jobId: "cb289fb5-04d0-488f-b5b8-3af6d2c92d1e", tailLines: 100)
   ```
   Look for `Graph API call failed` or `401 Unauthorized` from Microsoft Graph.

### No Messages Arriving at Webhook

**Symptoms:**
- Send message in Teams
- No entries in pod logs (no POST /api/messages)
- Bot Framework Web Chat works fine

**Fix:**

1. **Check Teams channel acceptedTerms:**
   ```bash
   az rest --method GET \
     --uri "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.BotService/botServices/$BOT_NAME/channels/MsTeamsChannel?api-version=2021-05-01-preview" \
     --query "properties.acceptedTerms"
   ```
   Must be `true`.

   If `false` or `null`, run Step 10 again (ensure `acceptedTerms: true` in the request body).

2. **Check bot registration endpoint matches webhook:**
   ```bash
   az bot show --name opencode-teams-bot --resource-group shakudo-teams-bot \
     --query "properties.endpoint" -o tsv
   ```
   Must match: `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages`

3. **Old App ID with broken routing:**
   > **WARNING:** If you previously had a bot registration that you deleted and recreated with the same App ID, Teams routing may be permanently broken for that App ID. Microsoft's Bot Framework caches routing information that doesn't get cleared on delete.

   **Symptoms:**
   - Web Chat works
   - Teams messages never arrive at webhook
   - No errors in any logs

   **Fix:** Create a NEW Azure AD app (Step 1) with a fresh App ID, then redo all steps.

### Messages Arrive but No Response Visible

**Symptoms:**
- Pod logs show incoming POST /api/messages
- Pod logs show response generated successfully
- No response appears in Teams

**Root cause:**
- Using wrong adapter pattern (single-arg instead of two-step)
- Bot attempting to reply to old/broken App ID routing

**Fix:**

1. **Check adapter configuration:**
   Verify `src/teams/teams-adapter.ts` uses two-step pattern (Step 4).

2. **If you recently changed App ID:**
   - Delete the old app from Teams (Apps → Manage your apps → OpenCode Bot → Uninstall)
   - Re-package manifest with new App ID (Step 30)
   - Re-sideload (Step 33)

3. **Check TurnContext conversation reference:**
   Add debug logging to bot code:
   ```typescript
   console.log("Conversation reference:", JSON.stringify(context.activity.conversation, null, 2));
   ```
   Verify `conversation.id` matches the thread you're sending messages to.

---

## Current Deployment Reference

This table contains ALL current production values for the deployed OpenCode Teams bot on Shakudo platform (dev.hyperplane.dev):

| Component | Value | Notes |
|-----------|-------|-------|
| **Azure AD App Registration** | | |
| App ID (Client ID) | `691f2047-0585-4566-9129-d582c82b5e7d` | Current production App ID |
| ~~Old App ID~~ | ~~`691f2047-0585-4566-9129-d582c82b5e7d`~~ | ⚠️ DEPRECATED - broken by delete/recreate, do not use |
| Application ID URI | `api://botid-691f2047-0585-4566-9129-d582c82b5e7d` | Required for Teams channel auth |
| Tenant ID | `b01c976d-0f48-4c4e-8859-1b03b022911e` | Shakudo Azure AD tenant |
| Client Secret | `(stored in Shakudo secrets)` | 2-year expiration from creation date |
| **Azure Bot Registration** | | |
| Bot Name | `opencode-teams-bot` | Azure resource name |
| Resource Group | `shakudo-teams-bot` | Azure resource group |
| Subscription | `(Shakudo subscription)` | Azure subscription ID |
| Messaging Endpoint | `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev/api/messages` | Must match webhook URL |
| Channels Enabled | `MsTeamsChannel (acceptedTerms: true)` | |
| **Authorization** | | |
| Security Group Name | `OpenCode Teams Bot Users` | Azure AD security group |
| Security Group ID | `9e1892be-12f9-48eb-a01c-134cbd04d3dd` | `AZURE_AD_AUTHORIZED_GROUP_ID` |
| Graph API Permission | `GroupMember.Read.All` (Application) | Admin consent granted |
| **Shakudo Microservice** | | |
| Microservice Name | `opencode-teams-bot` | |
| Microservice ID | `cb289fb5-04d0-488f-b5b8-3af6d2c92d1e` | Used in webhook URL derivation |
| Environment | `basic-ai-tools-small` | Pod spec (1 CPU, 2GB RAM) |
| Namespace | `hyperplane-pipelines` | Kubernetes namespace |
| Git Server | `kaji-opensource` | |
| Git Branch | `opencode-mattermost-plugin-003-ms-teams-integration` | |
| Working Directory | `/tmp/git/monorepo/` | Explicit override (not default) |
| Entrypoint Script | `scripts/deploy/run.sh` | Relative to repo root |
| **Ports & URLs** | | |
| Internal Bot Port | `3978` | Express server listen port (Bot Framework standard) |
| External Exposed Port | `8787` | Shakudo LoadBalancer port (Shakudo standard) |
| Webhook URL (Public) | `https://bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev` | Public internet-facing, bypasses Keycloak |
| In-Cluster Service URL | `http://hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local:8787` | Internal cluster DNS |
| Health Endpoint | `/api/health` | GET returns JSON health status |
| Messages Endpoint | `/api/messages` | POST from Bot Framework (requires JWT) |
| **VirtualService** | | |
| VirtualService Name | `hyperplane-service-cb289fb5-webhook` | Kubernetes resource name |
| VirtualService Host | `bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev` | Must match webhook URL |
| Gateway | `istio-system/hyperplane-gateway` | Istio ingress gateway |
| Destination Host | `hyperplane-service-cb289f.hyperplane-pipelines.svc.cluster.local` | In-cluster service DNS |
| Destination Port | `8787` | Matches external exposed port |
| **Environment Variables** | | |
| `AZURE_APP_ID` | `691f2047-0585-4566-9129-d582c82b5e7d` | |
| `AZURE_APP_PASSWORD` | `(Shakudo secret)` | Redacted |
| `AZURE_TENANT_ID` | `b01c976d-0f48-4c4e-8859-1b03b022911e` | |
| `AZURE_AD_AUTHORIZED_GROUP_ID` | `9e1892be-12f9-48eb-a01c-134cbd04d3dd` | |
| `TEAMS_BOT_PORT` | `3978` | Must match internal listen port |
| `OPENCODE_SERVER_URL` | `http://localhost:4096` | Default (sidecar) |
| `TEAMS_CARD_UPDATE_INTERVAL` | `5000` | 5 seconds polling interval |
| `TEAMS_AUTH_CACHE_DURATION_MS` | `3600000` | 1 hour auth cache |
| **Teams App Manifest** | | |
| Manifest ID | `691f2047-0585-4566-9129-d582c82b5e7d` | Must match App ID |
| App Package Name | `io.shakudo.opencode` | Reverse DNS notation |
| App Short Name | `OpenCode Bot` | Display name in Teams |
| Bot ID | `691f2047-0585-4566-9129-d582c82b5e7d` | Must match App ID |
| Valid Domains | `bc2cc691-56d8-425d-88b2-70d024e56c12-webhook.dev.hyperplane.dev`, `token.botframework.com` | Required for auth redirect |

---

**End of Deployment Guide**

**Last Verified:** 2026-02-11  
**Platform:** Shakudo dev.hyperplane.dev  
**Bot Status:** Production, operational  
**Maintainer:** OpenCode Platform Team
