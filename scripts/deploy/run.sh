#!/bin/bash
set -euo pipefail

cd /tmp/git/monorepo/ || cd /app

echo "=== OpenCode Teams Bot ==="
echo "Starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Port: ${TEAMS_BOT_PORT:-3978}"

if [ -f package.json ]; then
  echo "Installing dependencies..."
  bun install --frozen-lockfile --production 2>/dev/null || bun install --production
fi

echo "Starting Teams bot..."
exec bun run src/teams/index.ts
