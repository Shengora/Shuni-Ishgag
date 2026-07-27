/**
 * Error notification — sends every bot error to the primary super admin.
 * Call initNotify() once after the bot is created, then call notifyError()
 * anywhere an error should be forwarded.
 */
import { logger } from "../lib/logger.js";

let _send: ((msg: string) => Promise<void>) | null = null;

export function initNotify(sendFn: (msg: string) => Promise<void>): void {
  _send = sendFn;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function notifyError(
  err: unknown,
  label: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!_send) return;
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const extraLines = extra
      ? Object.entries(extra)
          .map(([k, v]) => `  <b>${esc(k)}:</b> <code>${esc(String(v)).slice(0, 120)}</code>`)
          .join("\n")
      : "";
    const stackRaw = (e.stack ?? "").slice(0, 800);
    const msg =
      `🚨 <b>Bot xatosi</b>\n\n` +
      `📌 <b>${esc(label)}</b>\n` +
      `❌ <code>${esc(e.message.slice(0, 300))}</code>` +
      (extraLines ? `\n${extraLines}` : "") +
      (stackRaw ? `\n\n<pre>${esc(stackRaw)}</pre>` : "");
    await _send(msg);
  } catch (notifyErr) {
    logger.warn({ notifyErr }, "notifyError: send failed");
  }
}
