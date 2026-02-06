#!/bin/bash
# teardown-azure-bot.sh - Remove Azure Bot resources
#
# Usage:
#   ./teardown-azure-bot.sh                    # Interactive mode (prompts for confirmation)
#   ./teardown-azure-bot.sh --force            # Skip confirmation
#   AZURE_RESOURCE_GROUP=my-rg ./teardown-sh   # Use custom resource group
#
# Optional environment variables:
#   AZURE_RESOURCE_GROUP  - Resource group name (default: shakudo-teams-bot)
#   BOT_APP_NAME          - Azure AD app name (default: opencode-teams-bot)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

AZURE_RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-shakudo-teams-bot}"
BOT_APP_NAME="${BOT_APP_NAME:-opencode-teams-bot}"
FORCE_MODE="${1:-}"

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "\n${GREEN}==>${NC} $1"; }

confirm_deletion() {
    if [[ "$FORCE_MODE" == "--force" ]]; then
        return 0
    fi
    
    echo ""
    echo -e "${RED}WARNING: This will permanently delete the following resources:${NC}"
    echo "  - Bot Channels Registration: $BOT_APP_NAME"
    echo "  - Azure AD App Registration: $BOT_APP_NAME"
    echo "  - Resource Group: $AZURE_RESOURCE_GROUP (if empty)"
    echo ""
    read -p "Are you sure you want to continue? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled."
        exit 0
    fi
}

delete_bot_registration() {
    log_step "Deleting Bot Channels Registration: $BOT_APP_NAME"
    
    if az bot show --name "$BOT_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" &> /dev/null; then
        az bot delete \
            --name "$BOT_APP_NAME" \
            --resource-group "$AZURE_RESOURCE_GROUP" \
            --output none
        log_success "Bot Channels Registration deleted"
    else
        log_info "Bot Channels Registration not found (already deleted?)"
    fi
}

delete_app_registration() {
    log_step "Deleting Azure AD App Registration: $BOT_APP_NAME"
    
    local app_id
    app_id=$(az ad app list --display-name "$BOT_APP_NAME" --query "[0].appId" -o tsv 2>/dev/null || echo "")
    
    if [[ -n "$app_id" && "$app_id" != "None" ]]; then
        log_info "Found app ID: $app_id"
        
        local sp_id
        sp_id=$(az ad sp show --id "$app_id" --query "id" -o tsv 2>/dev/null || echo "")
        if [[ -n "$sp_id" && "$sp_id" != "None" ]]; then
            log_info "Deleting service principal..."
            az ad sp delete --id "$app_id" --output none 2>/dev/null || true
        fi
        
        log_info "Deleting app registration..."
        az ad app delete --id "$app_id" --output none
        log_success "Azure AD App Registration deleted"
    else
        log_info "Azure AD App Registration not found (already deleted?)"
    fi
}

delete_resource_group() {
    log_step "Checking Resource Group: $AZURE_RESOURCE_GROUP"
    
    if ! az group show --name "$AZURE_RESOURCE_GROUP" &> /dev/null; then
        log_info "Resource group not found (already deleted?)"
        return 0
    fi
    
    local resource_count
    resource_count=$(az resource list --resource-group "$AZURE_RESOURCE_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo "0")
    
    if [[ "$resource_count" == "0" ]]; then
        log_info "Resource group is empty, deleting..."
        az group delete \
            --name "$AZURE_RESOURCE_GROUP" \
            --yes \
            --no-wait \
            --output none
        log_success "Resource group deletion initiated"
    else
        log_warn "Resource group contains $resource_count resource(s), not deleting"
        log_info "Delete manually: az group delete --name $AZURE_RESOURCE_GROUP"
    fi
}

cleanup_env_file() {
    log_step "Cleaning up local files"
    
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local env_file="${script_dir}/.env.azure"
    
    if [[ -f "$env_file" ]]; then
        rm "$env_file"
        log_success "Removed: $env_file"
    else
        log_info "No .env.azure file found"
    fi
}

main() {
    echo "=============================================="
    echo " Azure Bot Teardown"
    echo "=============================================="
    
    if ! command -v az &> /dev/null; then
        log_error "Azure CLI not found"
        exit 1
    fi
    
    if ! az account show &> /dev/null; then
        log_error "Not logged into Azure. Run: az login"
        exit 1
    fi
    
    confirm_deletion
    delete_bot_registration
    delete_app_registration
    delete_resource_group
    cleanup_env_file
    
    echo ""
    echo "=============================================="
    echo " Teardown Complete"
    echo "=============================================="
    echo ""
    log_success "All Azure Bot resources have been removed."
    echo ""
}

main "$@"
