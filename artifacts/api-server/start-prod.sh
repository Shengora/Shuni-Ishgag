#!/bin/sh
# Production startup: install Playwright Chromium in the background so the
# health check is not blocked, then keep the node server as the main process.

cd /home/runner/workspace

CHROMIUM_BIN=".cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"

if [ -f "$CHROMIUM_BIN" ]; then
  echo "[start-prod] Playwright Chromium already installed — skipping download"
else
  echo "[start-prod] Playwright Chromium not found — installing in background..."
  artifacts/api-server/node_modules/.bin/playwright install chromium \
    > /tmp/playwright-install.log 2>&1 &
  echo "[start-prod] Download running in background (PID $!), server starting now"
fi

echo "[start-prod] Starting API server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
