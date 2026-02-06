#!/bin/bash
set -euo pipefail

# Package Teams app manifest for sideloading
# Usage: ./scripts/package-manifest.sh [output-path]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_DIR="$ROOT_DIR/teams-manifest"
OUTPUT_PATH="${1:-/tmp/opencode-teams-bot.zip}"

# Azure App ID (from environment or default)
AZURE_APP_ID="${AZURE_APP_ID:-691f2047-0585-4566-9129-d582c82b5e7d}"

echo "=== Package Teams App Manifest ==="
echo "Manifest dir: $MANIFEST_DIR"
echo "Output: $OUTPUT_PATH"
echo "Azure App ID: $AZURE_APP_ID"
echo ""

# Validate required files
for file in manifest.json icons/color.png icons/outline.png; do
  if [ ! -f "$MANIFEST_DIR/$file" ]; then
    echo "ERROR: Missing required file: $MANIFEST_DIR/$file"
    exit 1
  fi
done

# Validate icon dimensions
if command -v identify &>/dev/null; then
  COLOR_SIZE=$(identify -format "%wx%h" "$MANIFEST_DIR/icons/color.png" 2>/dev/null || echo "unknown")
  OUTLINE_SIZE=$(identify -format "%wx%h" "$MANIFEST_DIR/icons/outline.png" 2>/dev/null || echo "unknown")
  echo "Color icon: $COLOR_SIZE (expected 192x192)"
  echo "Outline icon: $OUTLINE_SIZE (expected 32x32)"
fi

# Create temp directory for processed manifest
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Process manifest.json - replace template variables
sed "s/{{AZURE_APP_ID}}/$AZURE_APP_ID/g" "$MANIFEST_DIR/manifest.json" > "$TEMP_DIR/manifest.json"

# Copy icons
mkdir -p "$TEMP_DIR/icons"
cp "$MANIFEST_DIR/icons/color.png" "$TEMP_DIR/icons/color.png"
cp "$MANIFEST_DIR/icons/outline.png" "$TEMP_DIR/icons/outline.png"

# Validate JSON
if command -v jq &>/dev/null; then
  if ! jq empty "$TEMP_DIR/manifest.json" 2>/dev/null; then
    echo "ERROR: Invalid JSON in processed manifest"
    exit 1
  fi
  echo "Manifest JSON: valid"
fi

# Package as zip
rm -f "$OUTPUT_PATH"
(cd "$TEMP_DIR" && zip -r "$OUTPUT_PATH" manifest.json icons/)

echo ""
echo "✅ Teams app manifest packaged: $OUTPUT_PATH"
echo ""
echo "To sideload in Teams:"
echo "  1. Teams Admin Center → Manage Apps → Upload custom app"
echo "  2. Or Teams client → Apps → Manage your apps → Upload a custom app"
echo "  3. Select: $OUTPUT_PATH"
