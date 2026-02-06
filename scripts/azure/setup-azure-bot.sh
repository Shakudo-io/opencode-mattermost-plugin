#!/bin/bash
# setup-azure-bot.sh - Create Azure AD app registration and Bot Channels Registration
#
# This script is IDEMPOTENT - safe to run multiple times. It will:
# - Create resources if they don't exist
# - Update existing resources if they do
#
# Prerequisites:
#   - Azure CLI installed and logged in (run ./validate-prereqs.sh first)
#   - Azure Bot Service extension (az extension add --name botservice)
#
# Required environment variables:
#   TEAMS_BOT_ENDPOINT    - HTTPS endpoint for bot (e.g., https://bot.example.com/api/messages)
#
# Optional environment variables:
#   AZURE_RESOURCE_GROUP  - Resource group name (default: shakudo-teams-bot)
#   AZURE_LOCATION        - Azure region (default: eastus)
#   BOT_DISPLAY_NAME      - Bot display name (default: OpenCode Teams Bot)
#   BOT_APP_NAME          - Azure AD app name (default: opencode-teams-bot)
#
# Usage:
#   export TEAMS_BOT_ENDPOINT=https://opencode-teams-bot.dev.hyperplane.dev/api/messages
#   ./setup-azure-bot.sh
#
# Output:
#   Creates .env.azure file with credentials

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCRIPT_DIR}/.env.azure"

AZURE_RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-shakudo-teams-bot}"
AZURE_LOCATION="${AZURE_LOCATION:-eastus}"
BOT_DISPLAY_NAME="${BOT_DISPLAY_NAME:-OpenCode Teams Bot}"
BOT_APP_NAME="${BOT_APP_NAME:-opencode-teams-bot}"

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "\n${GREEN}==>${NC} $1"; }

check_prereqs() {
    if [[ -z "${TEAMS_BOT_ENDPOINT:-}" ]]; then
        log_error "TEAMS_BOT_ENDPOINT environment variable is required"
        echo "  Example: export TEAMS_BOT_ENDPOINT=https://opencode-teams-bot.dev.hyperplane.dev/api/messages"
        exit 1
    fi

    if ! command -v az &> /dev/null; then
        log_error "Azure CLI not found. Install from: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
        exit 1
    fi

    if ! az account show &> /dev/null; then
        log_error "Not logged into Azure. Run: az login"
        exit 1
    fi
}

get_or_create_resource_group() {
    log_step "Resource Group: $AZURE_RESOURCE_GROUP"
    
    if az group show --name "$AZURE_RESOURCE_GROUP" &> /dev/null; then
        log_info "Resource group already exists"
    else
        log_info "Creating resource group..."
        az group create \
            --name "$AZURE_RESOURCE_GROUP" \
            --location "$AZURE_LOCATION" \
            --output none
        log_success "Resource group created"
    fi
}

get_or_create_app_registration() {
    log_step "Azure AD App Registration: $BOT_APP_NAME"
    
    local existing_app_id
    existing_app_id=$(az ad app list --display-name "$BOT_APP_NAME" --query "[0].appId" -o tsv 2>/dev/null || echo "")
    
    if [[ -n "$existing_app_id" && "$existing_app_id" != "None" ]]; then
        log_info "App registration already exists (ID: $existing_app_id)"
        APP_ID="$existing_app_id"
        
        log_info "Updating app registration..."
        az ad app update \
            --id "$APP_ID" \
            --sign-in-audience "AzureADMyOrg" \
            --web-redirect-uris "https://token.botframework.com/.auth/web/redirect" \
            --output none
        log_success "App registration updated"
    else
        log_info "Creating app registration..."
        APP_ID=$(az ad app create \
            --display-name "$BOT_APP_NAME" \
            --sign-in-audience "AzureADMyOrg" \
            --web-redirect-uris "https://token.botframework.com/.auth/web/redirect" \
            --query "appId" -o tsv)
        log_success "App registration created (ID: $APP_ID)"
    fi
}

get_or_create_service_principal() {
    log_step "Service Principal for App: $APP_ID"
    
    local existing_sp
    existing_sp=$(az ad sp show --id "$APP_ID" --query "id" -o tsv 2>/dev/null || echo "")
    
    if [[ -n "$existing_sp" && "$existing_sp" != "None" ]]; then
        log_info "Service principal already exists"
    else
        log_info "Creating service principal..."
        az ad sp create --id "$APP_ID" --output none
        log_success "Service principal created"
    fi
}

add_api_permissions() {
    log_step "API Permissions"
    
    local ms_graph_api="00000003-0000-0000-c000-000000000000"
    local user_read="e1fe6dd8-ba31-4d61-89e7-88639da4683d"
    local group_member_read_all="98830695-27a2-44f7-8c18-0c3ebc9698f6"
    
    log_info "Adding Microsoft Graph permissions..."
    
    az ad app permission add \
        --id "$APP_ID" \
        --api "$ms_graph_api" \
        --api-permissions "${user_read}=Scope" \
        --output none 2>/dev/null || true
    
    az ad app permission add \
        --id "$APP_ID" \
        --api "$ms_graph_api" \
        --api-permissions "${group_member_read_all}=Role" \
        --output none 2>/dev/null || true
    
    log_success "API permissions added"
    log_warn "Admin consent required for GroupMember.Read.All"
    echo "  Run: az ad app permission admin-consent --id $APP_ID"
    echo "  (Requires Global Admin or Privileged Role Admin)"
}

create_or_reset_client_secret() {
    log_step "Client Secret"
    
    log_info "Creating new client secret (2 year validity)..."
    local secret_result
    secret_result=$(az ad app credential reset \
        --id "$APP_ID" \
        --years 2 \
        --display-name "opencode-bot-secret" \
        --query "password" -o tsv)
    
    APP_PASSWORD="$secret_result"
    log_success "Client secret created"
    log_warn "This secret will only be shown once - save it securely!"
}

get_or_create_bot_channels_registration() {
    log_step "Bot Channels Registration: $BOT_APP_NAME"
    
    local tenant_id
    tenant_id=$(az account show --query "tenantId" -o tsv)
    
    if ! az extension show --name botservice &> /dev/null; then
        log_info "Installing botservice extension..."
        az extension add --name botservice --yes
    fi
    
    local existing_bot
    existing_bot=$(az bot show \
        --name "$BOT_APP_NAME" \
        --resource-group "$AZURE_RESOURCE_GROUP" \
        --query "name" -o tsv 2>/dev/null || echo "")
    
    if [[ -n "$existing_bot" && "$existing_bot" != "None" ]]; then
        log_info "Bot registration already exists"
        
        log_info "Updating bot endpoint..."
        az bot update \
            --name "$BOT_APP_NAME" \
            --resource-group "$AZURE_RESOURCE_GROUP" \
            --endpoint "$TEAMS_BOT_ENDPOINT" \
            --output none
        log_success "Bot endpoint updated"
    else
        log_info "Creating Bot Channels Registration..."
        
        az bot create \
            --resource-group "$AZURE_RESOURCE_GROUP" \
            --name "$BOT_APP_NAME" \
            --app-type "SingleTenant" \
            --appid "$APP_ID" \
            --tenant-id "$tenant_id" \
            --endpoint "$TEAMS_BOT_ENDPOINT" \
            --sku "F0" \
            --output none
        
        log_success "Bot Channels Registration created"
    fi
}

add_teams_channel() {
    log_step "Teams Channel"
    
    local existing_channel
    existing_channel=$(az bot msteams show \
        --name "$BOT_APP_NAME" \
        --resource-group "$AZURE_RESOURCE_GROUP" \
        --query "properties.channelName" -o tsv 2>/dev/null || echo "")
    
    if [[ -n "$existing_channel" && "$existing_channel" != "None" ]]; then
        log_info "Teams channel already configured"
    else
        log_info "Adding Teams channel to bot..."
        az bot msteams create \
            --name "$BOT_APP_NAME" \
            --resource-group "$AZURE_RESOURCE_GROUP" \
            --output none
        log_success "Teams channel added"
    fi
}

write_env_file() {
    log_step "Writing Configuration"
    
    local tenant_id
    tenant_id=$(az account show --query "tenantId" -o tsv)
    
    cat > "$OUTPUT_FILE" << EOF
# Azure AD App Registration - Generated by setup-azure-bot.sh
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# IMPORTANT: Keep this file secure and do not commit to version control

# Azure AD Configuration (REQUIRED)
AZURE_APP_ID=$APP_ID
AZURE_APP_PASSWORD=$APP_PASSWORD
AZURE_TENANT_ID=$tenant_id

# Bot Configuration
TEAMS_BOT_ENDPOINT=$TEAMS_BOT_ENDPOINT

# Resource Information (for reference)
# Resource Group: $AZURE_RESOURCE_GROUP
# Bot Name: $BOT_APP_NAME
# Location: $AZURE_LOCATION

# Authorization (set this to your Azure AD group ID)
# AZURE_AD_AUTHORIZED_GROUP_ID=<your-group-id>
EOF
    
    chmod 600 "$OUTPUT_FILE"
    log_success "Configuration written to: $OUTPUT_FILE"
}

print_summary() {
    echo ""
    echo "=============================================="
    echo " Setup Complete"
    echo "=============================================="
    echo ""
    echo -e "${GREEN}Azure AD App ID:${NC}      $APP_ID"
    echo -e "${GREEN}Tenant ID:${NC}            $(az account show --query 'tenantId' -o tsv)"
    echo -e "${GREEN}Bot Endpoint:${NC}         $TEAMS_BOT_ENDPOINT"
    echo -e "${GREEN}Resource Group:${NC}       $AZURE_RESOURCE_GROUP"
    echo ""
    echo -e "${YELLOW}Next Steps:${NC}"
    echo "1. Grant admin consent for API permissions:"
    echo "   az ad app permission admin-consent --id $APP_ID"
    echo ""
    echo "2. Copy credentials to your deployment environment:"
    echo "   cat $OUTPUT_FILE"
    echo ""
    echo "3. Set AZURE_AD_AUTHORIZED_GROUP_ID for access control"
    echo ""
    echo "4. Create Teams app manifest and sideload to Teams"
    echo "   See: scripts/azure/README.md"
    echo ""
}

main() {
    echo "=============================================="
    echo " Azure Bot Setup"
    echo "=============================================="
    
    check_prereqs
    get_or_create_resource_group
    get_or_create_app_registration
    get_or_create_service_principal
    add_api_permissions
    create_or_reset_client_secret
    get_or_create_bot_channels_registration
    add_teams_channel
    write_env_file
    print_summary
}

main "$@"
