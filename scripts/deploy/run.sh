#!/bin/bash
set -euo pipefail

cd /tmp/git/monorepo/ || cd /app

echo "=== OpenCode Teams Bot ==="
echo "Starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Port: ${TEAMS_BOT_PORT:-3978}"

if ! command -v bun &>/dev/null; then
  echo "Installing bun binary..."
  BUN_DIR="$HOME/.bun"
  mkdir -p "$BUN_DIR/bin"
  curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip" -o /tmp/bun.zip
  apt-get update -qq && apt-get install -y -qq unzip >/dev/null 2>&1 || true
  if command -v unzip &>/dev/null; then
    unzip -o /tmp/bun.zip -d /tmp/bun-extract
  else
    python3 -c "import zipfile; zipfile.ZipFile('/tmp/bun.zip').extractall('/tmp/bun-extract')"
  fi
  cp /tmp/bun-extract/bun-linux-x64/bun "$BUN_DIR/bin/bun"
  chmod +x "$BUN_DIR/bin/bun"
  export PATH="$BUN_DIR/bin:$PATH"
  rm -rf /tmp/bun.zip /tmp/bun-extract
fi

echo "Bun version: $(bun --version)"

if [ -f package.json ]; then
  echo "Installing dependencies..."
  bun install --frozen-lockfile 2>/dev/null || bun install
fi

echo "Starting Teams bot..."
exec bun run src/teams/index.ts
