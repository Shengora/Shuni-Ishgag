#!/bin/sh
# Production startup: ensure Playwright Chromium is installed, then run the bot.
# `playwright install` is idempotent — it skips browsers that are already present,
# so re-runs add only a few hundred ms overhead.

set -e

cd "$(dirname "$0")/../.."  # repo root

echo "[start-prod] Checking Playwright Chromium..."
npx --yes playwright install chromium 2>&1 | tail -5 || true

echo "[start-prod] Starting API server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
