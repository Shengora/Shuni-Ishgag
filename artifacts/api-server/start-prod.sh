#!/bin/sh
# Production startup: ensure Playwright Chromium is installed, then run the bot.
# Uses the api-server's own node_modules playwright binary (not npx/global).
# `playwright install` is idempotent — fast if browsers already downloaded.

set -e
cd /home/runner/workspace

echo "[start-prod] Checking Playwright Chromium..."
artifacts/api-server/node_modules/.bin/playwright install chromium 2>&1 | tail -3 || \
  echo "[start-prod] WARNING: playwright install failed, will try bundled browser"

echo "[start-prod] Starting API server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
