#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

SERVICE_NAME="${TEAMS_BOT_SERVICE_NAME:-opencode-teams-bot}"
ENVIRONMENT="${TEAMS_BOT_ENVIRONMENT:-basic-ai-tools-small}"
GIT_SERVER="${TEAMS_BOT_GIT_SERVER:-demos}"
GIT_BRANCH="${TEAMS_BOT_GIT_BRANCH:-main}"
USER_EMAIL="${USER_EMAIL:?USER_EMAIL environment variable required}"
PORT="${TEAMS_BOT_PORT:-3978}"

echo "=== Deploy OpenCode Teams Bot to Shakudo ==="
echo "Service: $SERVICE_NAME"
echo "Environment: $ENVIRONMENT"
echo "Git: $GIT_SERVER/$GIT_BRANCH"
echo "Port: $PORT"
echo "User: $USER_EMAIL"
echo ""

REQUIRED_VARS=(
  "AZURE_APP_ID"
  "AZURE_APP_PASSWORD"
  "AZURE_TENANT_ID"
  "AZURE_AD_AUTHORIZED_GROUP_ID"
)

for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: Required environment variable $var is not set"
    exit 1
  fi
done

echo "All required Azure credentials present."
echo ""
echo "NOTE: Deploy via Shakudo platform API or UI."
echo "Required microservice parameters:"
echo "  name: $SERVICE_NAME"
echo "  environment: $ENVIRONMENT"
echo "  gitServer: $GIT_SERVER"
echo "  branch: $GIT_BRANCH"
echo "  port: $PORT"
echo "  script: scripts/deploy/run.sh"
echo "  workingDirectory: /tmp/git/monorepo/opencode-mattermost-plugin/"
echo ""
echo "Required environment variables for the microservice:"
echo "  AZURE_APP_ID=$AZURE_APP_ID"
echo "  AZURE_APP_PASSWORD=***"
echo "  AZURE_TENANT_ID=$AZURE_TENANT_ID"
echo "  AZURE_AD_AUTHORIZED_GROUP_ID=$AZURE_AD_AUTHORIZED_GROUP_ID"
echo "  TEAMS_BOT_PORT=$PORT"
echo "  OPENCODE_SERVER_URL=\${OPENCODE_SERVER_URL:-http://localhost:4096}"
echo ""
echo "Bot endpoint URL: https://$SERVICE_NAME.dev.hyperplane.dev/api/messages"
echo ""
echo "After deployment, update Azure Bot registration endpoint to:"
echo "  https://$SERVICE_NAME.dev.hyperplane.dev/api/messages"
