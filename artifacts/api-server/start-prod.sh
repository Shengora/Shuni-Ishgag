#!/bin/sh
# Production startup: install Playwright Chromium, then start the node server.

# Determine the absolute path to the workspace root dynamically
WORKSPACE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$WORKSPACE_DIR" || exit 1

echo "[start-prod] Running in workspace: $WORKSPACE_DIR"

# Install Playwright browsers to a local path so we don't depend on home directory caches
export PLAYWRIGHT_BROWSERS_PATH="$WORKSPACE_DIR/.playwright-browsers"

echo "[start-prod] Checking Playwright Chromium installation..."
if [ -d "$PLAYWRIGHT_BROWSERS_PATH" ] && [ "$(ls -A "$PLAYWRIGHT_BROWSERS_PATH")" ]; then
  echo "[start-prod] Playwright Chromium likely already installed — skipping download"
else
  echo "[start-prod] Playwright Chromium not found — installing..."
  "$WORKSPACE_DIR/artifacts/api-server/node_modules/.bin/playwright" install chromium --with-deps
  echo "[start-prod] Download finished, server starting now"
fi

echo "[start-prod] Starting API server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
