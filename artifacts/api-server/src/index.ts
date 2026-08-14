import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
import { run, type RunnerHandle } from "@grammyjs/runner";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { createBot } from "./bot/bot.js";
import { startUserbotSessionCleanup } from "./bot/client.js";

// Prevent gramJS internal errors (e.g. "Cannot send requests while disconnected"
// after AUTH_KEY_UNREGISTERED) from crashing the entire process.
process.on("unhandledRejection", (reason: any) => {
  const msg: string = reason?.message ?? String(reason);
  // Suppress known gramJS transient errors
  if (
    msg.includes("Cannot send requests while disconnected") ||
    msg.includes("AUTH_KEY_UNREGISTERED") ||
    msg.includes("SESSION_REVOKED") ||
    msg.includes("USER_DEACTIVATED")
  ) {
    logger.warn({ msg }, "Suppressed gramJS transient unhandled rejection");
    return;
  }
  logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err: any) => {
  const msg: string = err?.message ?? String(err);
  if (
    msg.includes("Cannot send requests while disconnected") ||
    msg.includes("AUTH_KEY_UNREGISTERED")
  ) {
    logger.warn({ msg }, "Suppressed gramJS transient uncaught exception");
    return;
  }
  logger.fatal({ err }, "Uncaught exception — process will exit");
  process.exit(1);
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Start Telegram bot
//
// IMPORTANT: we use @grammyjs/runner's `run()` instead of the built-in
// `bot.start()`. grammY's default long polling processes updates
// *sequentially* — it will not fetch/handle the next update until the
// current one's middleware chain fully resolves. Several commands here
// (e.g. /getpremium, batch runs) intentionally await long-running promises
// (bank 3DS confirmation can take minutes, or wait indefinitely for an
// operator button). With plain `bot.start()` that meant ANY command from
// ANY operator would freeze the entire bot until that one 3DS wait
// resolved. `run()` processes updates concurrently, so one operator's
// pending 3DS step never blocks other commands/operators.
// In development, DEV_BOT_TOKEN (a separate @BotFather bot) is preferred over
// BOT_TOKEN so the dev process never polls the same token as production — see
// resolveBotToken() in bot.ts for why that split matters.
const isDevEnv = process.env.NODE_ENV !== "production";
const hasUsableBotToken = isDevEnv
  ? Boolean(process.env.DEV_BOT_TOKEN || process.env.BOT_TOKEN)
  : Boolean(process.env.BOT_TOKEN);

let bot: ReturnType<typeof createBot> | undefined;
let runner: RunnerHandle | undefined;
if (hasUsableBotToken) {
  try {
    bot = createBot();
    void bot.init().then(() => {
      logger.info({ username: bot!.botInfo.username }, "Telegram bot started");
    });
    runner = run(bot);
    logger.info("Telegram bot initializing (concurrent runner)...");
  } catch (err) {
    logger.error({ err }, "Failed to create bot");
  }
} else {
  logger.warn("BOT_TOKEN not set — Telegram bot not started");
}

// Periodically purge userbot sessions Telegram has invalidated (revoked,
// logged out, deactivated) after a 24h grace window so operators aren't left
// with dead sessions cluttering the active list.
startUserbotSessionCleanup();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// On restart the platform sends SIGTERM then SIGKILL. Stop long-polling and
// release the port promptly so the next process can bind it; force-exit after a
// short grace period so a slow stop can never leave a zombie holding the port
// (which previously made restarts fail with EADDRINUSE).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  const force = setTimeout(() => process.exit(0), 4000);
  force.unref();
  try { await runner?.stop(); } catch (_) {}
  try { server.close(); } catch (_) {}
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
