#!/bin/sh
# Production startup: install Playwright Chromium in the background so the
# health check is not blocked, then keep the node server as the main process.

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
  echo "[start-prod] Playwright Chromium not found — installing in background..."
  npx playwright install chromium \
    > /tmp/playwright-install.log 2>&1 &
  echo "[start-prod] Download running in background (PID $!), server starting now"
fi

echo "[start-prod] Starting API server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
