#!/bin/bash
# validate-prereqs.sh - Validate prerequisites for Azure Bot setup
#
# This script checks that all required tools and permissions are in place
# before attempting to create Azure resources.
#
# Usage: ./validate-prereqs.sh
#
# Exit codes:
#   0 - All prerequisites met
#   1 - Missing prerequisites

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
ERRORS=0
WARNINGS=0

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    ((WARNINGS++))
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
    ((ERRORS++))
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

# -----------------------------------------------------------------------------
# Check: Azure CLI installed
# -----------------------------------------------------------------------------
check_az_cli() {
    echo ""
    echo "Checking Azure CLI..."
    
    if ! command -v az &> /dev/null; then
        log_error "Azure CLI (az) is not installed"
        echo "  Install: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
        return 1
    fi
    
    local az_version
    az_version=$(az version --query '"azure-cli"' -o tsv 2>/dev/null || echo "unknown")
    log_success "Azure CLI installed (version: $az_version)"
}

# -----------------------------------------------------------------------------
# Check: Logged into Azure
# -----------------------------------------------------------------------------
check_az_login() {
    echo ""
    echo "Checking Azure login status..."
    
    if ! az account show &> /dev/null; then
        log_error "Not logged into Azure"
        echo "  Run: az login"
        return 1
    fi
    
    local account_name
    local account_id
    account_name=$(az account show --query 'user.name' -o tsv 2>/dev/null || echo "unknown")
    account_id=$(az account show --query 'id' -o tsv 2>/dev/null || echo "unknown")
    
    log_success "Logged in as: $account_name"
    log_info "Subscription ID: $account_id"
}

# -----------------------------------------------------------------------------
# Check: Correct subscription selected
# -----------------------------------------------------------------------------
check_subscription() {
    echo ""
    echo "Checking Azure subscription..."
    
    local subscription_name
    local subscription_id
    subscription_name=$(az account show --query 'name' -o tsv 2>/dev/null || echo "unknown")
    subscription_id=$(az account show --query 'id' -o tsv 2>/dev/null || echo "unknown")
    
    log_info "Current subscription: $subscription_name ($subscription_id)"
    
    # Check if AZURE_SUBSCRIPTION_ID is set and matches
    if [[ -n "${AZURE_SUBSCRIPTION_ID:-}" ]]; then
        if [[ "$subscription_id" != "$AZURE_SUBSCRIPTION_ID" ]]; then
            log_warn "AZURE_SUBSCRIPTION_ID is set but doesn't match current subscription"
            echo "  Expected: $AZURE_SUBSCRIPTION_ID"
            echo "  Current:  $subscription_id"
            echo "  Run: az account set --subscription $AZURE_SUBSCRIPTION_ID"
        else
            log_success "Subscription matches AZURE_SUBSCRIPTION_ID"
        fi
    fi
}

# -----------------------------------------------------------------------------
# Check: Tenant ID available
# -----------------------------------------------------------------------------
check_tenant() {
    echo ""
    echo "Checking Azure AD tenant..."
    
    local tenant_id
    tenant_id=$(az account show --query 'tenantId' -o tsv 2>/dev/null || echo "")
    
    if [[ -z "$tenant_id" ]]; then
        log_error "Could not determine tenant ID"
        return 1
    fi
    
    log_success "Tenant ID: $tenant_id"
    
    # If AZURE_TENANT_ID is set, verify it matches
    if [[ -n "${AZURE_TENANT_ID:-}" ]]; then
        if [[ "$tenant_id" != "$AZURE_TENANT_ID" ]]; then
            log_warn "AZURE_TENANT_ID environment variable doesn't match current tenant"
            echo "  Expected: $AZURE_TENANT_ID"
            echo "  Current:  $tenant_id"
        else
            log_success "Tenant matches AZURE_TENANT_ID"
        fi
    fi
}

# -----------------------------------------------------------------------------
# Check: User has permissions to create app registrations
# -----------------------------------------------------------------------------
check_app_registration_permissions() {
    echo ""
    echo "Checking app registration permissions..."
    
    # Try to list app registrations (this will fail if no permissions)
    if ! az ad app list --filter "displayName eq '__test_perm_check_nonexistent__'" &> /dev/null; then
        log_error "Cannot query Azure AD app registrations"
        echo "  You may need Application Developer or Global Admin role"
        return 1
    fi
    
    log_success "Can query Azure AD app registrations"
}

# -----------------------------------------------------------------------------
# Check: Required extensions installed
# -----------------------------------------------------------------------------
check_extensions() {
    echo ""
    echo "Checking Azure CLI extensions..."
    
    # Check if bot extension is available (may need to be installed)
    if ! az extension show --name botservice &> /dev/null; then
        log_warn "Azure Bot Service extension not installed"
        echo "  Install: az extension add --name botservice"
        echo "  This is required for 'az bot' commands"
    else
        local bot_version
        bot_version=$(az extension show --name botservice --query 'version' -o tsv 2>/dev/null || echo "unknown")
        log_success "Bot Service extension installed (version: $bot_version)"
    fi
}

# -----------------------------------------------------------------------------
# Check: Resource group exists or can be created
# -----------------------------------------------------------------------------
check_resource_group() {
    echo ""
    echo "Checking resource group permissions..."
    
    local rg_name="${AZURE_RESOURCE_GROUP:-shakudo-teams-bot}"
    
    # Check if resource group exists
    if az group show --name "$rg_name" &> /dev/null; then
        log_success "Resource group '$rg_name' exists"
    else
        log_info "Resource group '$rg_name' does not exist (will be created)"
        
        # Check if we can create resource groups
        if ! az group list --query "[0].name" &> /dev/null; then
            log_warn "Cannot list resource groups - may not have permission to create new ones"
        fi
    fi
}

# -----------------------------------------------------------------------------
# Check: Bot endpoint URL provided
# -----------------------------------------------------------------------------
check_endpoint_url() {
    echo ""
    echo "Checking configuration..."
    
    if [[ -z "${TEAMS_BOT_ENDPOINT:-}" ]]; then
        log_warn "TEAMS_BOT_ENDPOINT not set"
        echo "  This will be required for Bot Channels Registration"
        echo "  Example: export TEAMS_BOT_ENDPOINT=https://opencode-teams-bot.dev.hyperplane.dev/api/messages"
    else
        log_success "TEAMS_BOT_ENDPOINT: $TEAMS_BOT_ENDPOINT"
        
        # Validate URL format
        if [[ ! "$TEAMS_BOT_ENDPOINT" =~ ^https:// ]]; then
            log_warn "TEAMS_BOT_ENDPOINT should use HTTPS"
        fi
        if [[ ! "$TEAMS_BOT_ENDPOINT" =~ /api/messages$ ]]; then
            log_warn "TEAMS_BOT_ENDPOINT should end with /api/messages"
        fi
    fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    echo "=============================================="
    echo " Azure Bot Setup - Prerequisites Check"
    echo "=============================================="
    
    check_az_cli || true
    check_az_login || true
    check_subscription || true
    check_tenant || true
    check_app_registration_permissions || true
    check_extensions || true
    check_resource_group || true
    check_endpoint_url || true
    
    echo ""
    echo "=============================================="
    echo " Summary"
    echo "=============================================="
    
    if [[ $ERRORS -gt 0 ]]; then
        echo -e "${RED}Errors: $ERRORS${NC}"
        echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
        echo ""
        echo "Please fix the errors above before running setup-azure-bot.sh"
        exit 1
    elif [[ $WARNINGS -gt 0 ]]; then
        echo -e "${GREEN}Errors: 0${NC}"
        echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
        echo ""
        echo "Prerequisites met with warnings. Review warnings before proceeding."
        exit 0
    else
        echo -e "${GREEN}All prerequisites met!${NC}"
        echo ""
        echo "You can now run: ./setup-azure-bot.sh"
        exit 0
    fi
}

main "$@"
