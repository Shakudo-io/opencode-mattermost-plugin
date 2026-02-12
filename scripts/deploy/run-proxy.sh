#!/bin/bash
set -euo pipefail

echo "=== Teams Bot Webhook Proxy ==="
echo "Starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Proxy port: ${PROXY_PORT:-8787}"
echo "Target: ${TARGET_URL:-http://hyperhub-svc-456b71.hyperplane-jhub.svc.cluster.local:3000}"

cd /tmp/git/monorepo/ || cd /app

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
echo "Starting proxy..."
exec bun run scripts/deploy/webhook-proxy.ts
