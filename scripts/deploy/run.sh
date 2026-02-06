#!/bin/bash
set -euo pipefail

cd /tmp/git/monorepo/ || cd /app

echo "=== OpenCode Teams Bot ==="
echo "Starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Port: ${TEAMS_BOT_PORT:-3978}"

# Install bun if not available
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

echo "Bun version: $(bun --version)"

if [ -f package.json ]; then
  echo "Installing dependencies..."
  bun install --frozen-lockfile 2>/dev/null || bun install
fi

echo "Starting Teams bot..."
exec bun run src/teams/index.ts
