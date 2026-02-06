# Azure Bot Setup Scripts

Scripts for provisioning Azure AD app registration and Bot Channels Registration for the OpenCode Teams Bot.

## Quick Start

```bash
# 1. Login to Azure
az login

# 2. Check prerequisites
./validate-prereqs.sh

# 3. Set your bot endpoint
export TEAMS_BOT_ENDPOINT=https://opencode-teams-bot.dev.hyperplane.dev/api/messages

# 4. Run setup
./setup-azure-bot.sh

# 5. Grant admin consent (requires admin privileges)
az ad app permission admin-consent --id <APP_ID>
```

## Scripts

| Script | Purpose |
|--------|---------|
| `validate-prereqs.sh` | Checks Azure CLI, login status, and permissions |
| `setup-azure-bot.sh` | Creates Azure AD app and Bot Channels Registration (idempotent) |
| `teardown-azure-bot.sh` | Removes all Azure resources |

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `TEAMS_BOT_ENDPOINT` | Public HTTPS endpoint for bot webhooks | `https://bot.example.com/api/messages` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AZURE_RESOURCE_GROUP` | `shakudo-teams-bot` | Azure resource group name |
| `AZURE_LOCATION` | `eastus` | Azure region |
| `BOT_APP_NAME` | `opencode-teams-bot` | Azure AD app display name |
| `BOT_DISPLAY_NAME` | `OpenCode Teams Bot` | Bot display name in Teams |

## Output

The setup script creates `.env.azure` containing:
- `AZURE_APP_ID` - Application (client) ID
- `AZURE_APP_PASSWORD` - Client secret
- `AZURE_TENANT_ID` - Directory (tenant) ID
- `TEAMS_BOT_ENDPOINT` - Configured endpoint

## Manual Setup (Restricted Environments)

If automated scripts cannot run due to permission restrictions, follow these manual steps in the Azure Portal.

### Step 1: Create App Registration

1. Navigate to **Azure Portal** → **Azure Active Directory** → **App registrations**
2. Click **New registration**
3. Configure:
   - **Name**: `opencode-teams-bot`
   - **Supported account types**: "Accounts in this organizational directory only (Single tenant)"
   - **Redirect URI**: Web, `https://token.botframework.com/.auth/web/redirect`
4. Click **Register**
5. Note the **Application (client) ID** and **Directory (tenant) ID**

### Step 2: Create Client Secret

1. In the app registration, go to **Certificates & secrets**
2. Click **New client secret**
3. Configure:
   - **Description**: `opencode-bot-secret`
   - **Expires**: 24 months
4. Click **Add**
5. **Copy the secret value immediately** (shown only once)

### Step 3: Configure API Permissions

1. Go to **API permissions**
2. Click **Add a permission**
3. Add Microsoft Graph permissions:
   - **Delegated**: `User.Read` (Sign in and read user profile)
   - **Application**: `GroupMember.Read.All` (Read all groups)
4. Click **Grant admin consent** (requires admin)

### Step 4: Create Bot Channels Registration

1. Navigate to **Azure Portal** → **Create a resource**
2. Search for **Azure Bot**
3. Click **Create**
4. Configure:
   - **Bot handle**: `opencode-teams-bot`
   - **Subscription**: Your subscription
   - **Resource group**: `shakudo-teams-bot` (create new if needed)
   - **Pricing tier**: F0 (Free)
   - **Type of App**: Single Tenant
   - **Microsoft App ID**: Paste the Application ID from Step 1
   - **Microsoft App Tenant ID**: Paste the Tenant ID from Step 1
5. Click **Review + create** → **Create**

### Step 5: Configure Messaging Endpoint

1. Go to the created Bot resource
2. Navigate to **Configuration**
3. Set **Messaging endpoint**: `https://opencode-teams-bot.dev.hyperplane.dev/api/messages`
4. Click **Apply**

### Step 6: Add Teams Channel

1. In the Bot resource, go to **Channels**
2. Click **Microsoft Teams** icon
3. Accept the Terms of Service
4. Click **Apply**

### Step 7: Verify Setup

1. Go to **Channels** → **Microsoft Teams** → **Open in Teams**
2. Send a test message to the bot
3. If no response, check:
   - Messaging endpoint is correct
   - Bot service is running at the endpoint
   - Client secret matches between Azure and your deployment

## Troubleshooting

### "AADSTS700016: Application not found"

The App ID doesn't exist or is in a different tenant. Verify:
```bash
az ad app show --id <YOUR_APP_ID>
```

### "MsalServiceException: AADSTS7000215"

Invalid client secret. Regenerate in Azure Portal or:
```bash
az ad app credential reset --id <APP_ID>
```

### "Unauthorized" responses from bot endpoint

1. Check `AZURE_APP_ID` and `AZURE_APP_PASSWORD` match Azure
2. Ensure endpoint uses HTTPS
3. Verify endpoint path is `/api/messages`

### Bot doesn't respond in Teams

1. Verify the messaging endpoint is publicly accessible
2. Check bot health endpoint: `curl https://your-bot/health`
3. Review bot logs for errors
4. Confirm Teams channel is enabled in Azure Bot

### "User not authorized" in bot

1. Verify `AZURE_AD_AUTHORIZED_GROUP_ID` is set correctly
2. Confirm user is a member of the authorized group
3. Check admin consent was granted for `GroupMember.Read.All`

## Security Notes

- The `.env.azure` file contains sensitive credentials - **never commit to git**
- Client secrets expire - set calendar reminders to rotate before expiry
- `GroupMember.Read.All` requires admin consent - coordinate with IT
- Use Azure Key Vault for production secret management
