# Teams App Manifest - Kaji

This directory contains the Microsoft Teams app manifest for the Kaji Teams Integration bot.

## Contents

```
teams-manifest/
├── manifest.json          # App manifest template (uses {{AZURE_APP_ID}} placeholder)
├── icons/
│   ├── color.png          # Full color icon (192x192 PNG)
│   └── outline.png        # Outline icon (32x32 PNG, transparent background)
└── README.md              # This file
```

## Packaging

Use the packaging script to create a sideloadable zip:

```bash
# Default output: /tmp/opencode-teams-bot.zip
./scripts/package-manifest.sh

# Custom output path
./scripts/package-manifest.sh /path/to/output.zip

# Override Azure App ID
AZURE_APP_ID="your-app-id" ./scripts/package-manifest.sh
```

The script:
1. Validates all required files exist (manifest.json, both icons)
2. Replaces `{{AZURE_APP_ID}}` placeholders with the actual Azure App ID
3. Validates the resulting JSON
4. Packages everything into a zip file

## Sideloading

### Prerequisites

- Microsoft Teams admin access (or org policy allowing custom app uploads)
- Azure Bot Channels Registration configured with Teams channel enabled
- Webhook endpoint accessible from the internet

### Option 1: Teams Admin Center (Recommended for Org-Wide)

1. Go to [Teams Admin Center](https://admin.teams.microsoft.com)
2. Navigate to **Teams apps** → **Manage apps**
3. Click **Upload new app** → **Upload**
4. Select the packaged zip file
5. The app will appear in the org's app catalog
6. Users can then find and install it from the Teams app store

### Option 2: Teams Client (For Personal Testing)

1. Open Microsoft Teams
2. Click **Apps** in the left sidebar
3. Click **Manage your apps** at the bottom
4. Click **Upload a custom app** → **Upload for me or my teams**
5. Select the packaged zip file
6. Click **Add** to install

### Option 3: Teams Developer Portal

1. Go to [Teams Developer Portal](https://dev.teams.microsoft.com)
2. Navigate to **Apps** → **Import app**
3. Upload the zip file
4. Review and publish

## After Sideloading

1. Find "Kaji" in Teams apps
2. Click **Add** to start a conversation
3. Send a message to test the connection
4. The bot should respond if the webhook and Azure credentials are configured correctly

## Configuration

### manifest.json Template Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `{{AZURE_APP_ID}}` | Azure AD Application (client) ID | `691f2047-0585-4566-9129-d582c82b5e7d` |

### Key Manifest Fields

| Field | Value | Notes |
|-------|-------|-------|
| `manifestVersion` | `1.17` | Teams manifest schema version |
| `version` | `1.0.0` | App version (update on changes) |
| `bots[0].scopes` | `personal, team, groupChat` | Where the bot can be used |
| `validDomains` | Webhook domain | Must match the deployed webhook URL |
| `webApplicationInfo.resource` | API URI | Must match Azure App Registration |

### Icon Requirements

| Icon | Size | Format | Notes |
|------|------|--------|-------|
| `color.png` | 192x192 | PNG | Full color, used in app store and conversations |
| `outline.png` | 32x32 | PNG | Transparent background, used in activity feed |

## Updating the Manifest

1. Edit `manifest.json` template
2. Run `./scripts/package-manifest.sh` to create new zip
3. Re-upload to Teams (Admin Center → Manage apps → find app → Update)

## Troubleshooting

### Bot not responding after sideload
- Verify webhook URL is accessible: `curl https://your-webhook-url/api/health`
- Check Azure Bot Registration endpoint matches the webhook URL
- Ensure `AZURE_APP_PASSWORD` is set correctly in the microservice environment

### "App package is invalid" error
- Ensure icons are correct dimensions (192x192 and 32x32)
- Validate manifest.json is valid JSON (no template variables left)
- Check `$schema` matches the `manifestVersion`

### "This app is not available for your organization"
- Contact your Teams admin to allow custom app uploads
- Or use the Teams Developer Portal method
