#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_cluster_context() {
    local current_context
    current_context=$(kubectl config current-context 2>/dev/null || echo "")
    
    if [[ "$current_context" != *"test3"* ]]; then
        log_warn "Current kubectl context is not test3: $current_context"
        log_info "Switching to test3 cluster..."
        
        if command -v gcloud &> /dev/null; then
            export PATH=/opt/google-cloud-sdk/bin:$PATH
            gcloud container clusters get-credentials test3 --region=us-central1 --project=gcp-cluster-automation
        else
            log_error "gcloud not found. Please switch to test3 cluster manually:"
            log_error "  gcloud container clusters get-credentials test3 --region=us-central1 --project=gcp-cluster-automation"
            exit 1
        fi
    fi
    
    log_info "Using kubectl context: $(kubectl config current-context)"
}

load_credentials() {
    log_info "Loading credentials from Kubernetes secrets..."
    
    export MATTERMOST_TOKEN=$(kubectl get secret mattermost-e2e-test-creds -n mm-test \
        -o jsonpath='{.data.bot-token}' 2>/dev/null | base64 -d)
    
    if [ -z "$MATTERMOST_TOKEN" ]; then
        log_error "Failed to load bot token from mattermost-e2e-test-creds secret"
        exit 1
    fi
    
    export MATTERMOST_TEST_USER_PASSWORD=$(kubectl get secret mattermost-e2e-test-creds -n mm-test \
        -o jsonpath='{.data.test-user-password}' 2>/dev/null | base64 -d)
    
    export OPENCODE_MM_SUPABASE_ANON_KEY=$(kubectl get secret supabase-metaflow-keys -n mm-test \
        -o jsonpath='{.data.anon-key}' 2>/dev/null | base64 -d)
    
    if [ -z "$OPENCODE_MM_SUPABASE_ANON_KEY" ]; then
        log_warn "Supabase anon key not found in mm-test namespace, trying to create it..."
        
        local anon_key
        anon_key=$(kubectl get secret -n hyperplane-supabase-metaflow supabase-metaflow-jwt \
            -o jsonpath='{.data.anon-key}' 2>/dev/null | base64 -d)
        
        if [ -n "$anon_key" ]; then
            kubectl create secret generic supabase-metaflow-keys -n mm-test \
                --from-literal=anon-key="$anon_key" 2>/dev/null || true
            export OPENCODE_MM_SUPABASE_ANON_KEY="$anon_key"
            log_info "Created supabase-metaflow-keys secret in mm-test namespace"
        else
            log_warn "Could not retrieve Supabase anon key - database tests will be skipped"
        fi
    fi
    
    log_info "Credentials loaded successfully"
}

verify_connectivity() {
    log_info "Verifying Mattermost connectivity..."
    
    local mm_url="https://mattermost.test3.canopyhub.io/api/v4"
    local response
    response=$(curl -s -w "%{http_code}" -o /dev/null \
        -H "Authorization: Bearer $MATTERMOST_TOKEN" \
        "$mm_url/system/ping")
    
    if [ "$response" != "200" ]; then
        log_error "Failed to connect to Mattermost (HTTP $response)"
        log_error "URL: $mm_url"
        exit 1
    fi
    
    log_info "Mattermost connectivity verified"
}

run_tests() {
    log_info "Running E2E tests..."
    
    cd "$PROJECT_DIR"
    
    export MATTERMOST_URL="https://mattermost.test3.canopyhub.io/api/v4"
    export MATTERMOST_WS_URL="wss://mattermost.test3.canopyhub.io/api/v4/websocket"
    export OPENCODE_MM_SUPABASE_URL="http://supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local"
    
    bun test tests/e2e/e2e.test.ts "$@"
}

show_help() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --skip-verify    Skip connectivity verification"
    echo "  --help           Show this help message"
    echo ""
    echo "Environment variables (auto-loaded from K8s secrets):"
    echo "  MATTERMOST_TOKEN              Bot access token"
    echo "  MATTERMOST_TEST_USER_PASSWORD Test user password"
    echo "  OPENCODE_MM_SUPABASE_ANON_KEY Supabase anon key"
}

main() {
    local skip_verify=false
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-verify)
                skip_verify=true
                shift
                ;;
            --help)
                show_help
                exit 0
                ;;
            *)
                break
                ;;
        esac
    done
    
    log_info "OpenCode Mattermost Plugin E2E Test Runner"
    echo ""
    
    check_cluster_context
    load_credentials
    
    if [ "$skip_verify" = false ]; then
        verify_connectivity
    fi
    
    echo ""
    run_tests "$@"
}

main "$@"
