/**
 * Auto Telegram Premium Subscription Flow
 *
 * 1. Send /start to @PremiumBot → wait for invoice message
 * 2. Accept terms (click inline button if present)
 * 3. Get payment form (URL + form_id) via MTProto payments.GetPaymentForm
 * 4. Playwright headless browser → open tokenization URL → fill card →
 *    intercept Smart Glocal credential token
 * 5. payments.SendPaymentForm via MTProto with token credentials
 * 6. Wait for premiumbot receipt/confirmation message
 * 7. Cancel auto-renewal: /stop → click "Ha, obunani to'xtatish" button →
 *    click "Narx juda baland" button
 * 8. Poll verifier bot to confirm premium activation
 */

import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { EditedMessage } from "telegram/events/EditedMessage.js";
import type { EditedMessageEvent } from "telegram/events/EditedMessage.js";
import { Api } from "telegram";
import { logger } from "../lib/logger.js";
import { withTimeout } from "../lib/timeout.js";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenizeCardWithStripe } from "./client.js";
import { db, proxyIps, proxySettings } from "@workspace/db";
import { eq, asc, sql, lt, and } from "drizzle-orm";

// Playwright's page.evaluate / page.addInitScript callbacks run in the browser,
// where `window` exists. This module compiles with the Node lib only (no DOM,
// to avoid duplicate-identifier clashes with Node's fetch/Response), so declare
// `window` here purely to type those browser-context blocks.
declare const window: any;

// ── System Chromium (via Nix, added to replit.nix `deps`) ──────────────────
// Downloading Playwright's own browser build during the production deploy
// build step turned out to be unreliable — that build step hung with zero
// output (the deploy build sandbox has restricted/no egress for large binary
// downloads), silently dragging the whole build out for ~10 minutes and then
// deploying an incomplete image that crashed on startup. `pkgs.chromium` is
// declared in replit.nix instead, so it's baked into both the dev and
// production Nix layers identically — no runtime network fetch needed.
// Resolved once via `which` (added to PATH by the Nix profile) and cached.
// Serializes every real pw.chromium.launch() call process-wide. A launch that
// timed out (see launchRacingTimeout below) is *abandoned by the caller*, not
// killed — the real spawn keeps running for however long Chromium actually
// takes to start. If a retry (proxy → direct fallback, or channel fallback)
// immediately calls chromium.launch() again while that first spawn is still
// mid-startup, the two heavy Chromium processes fight over the same CPU and
// *both* end up slower — which was observed in production turning a single
// slow launch into two more 30s timeouts back to back. Routing every launch
// through this chain means a retry's real launch() call doesn't start until
// the previous one has actually settled, so this process never has two
// Chromium processes spawning at once.
let _launchChain: Promise<any> = Promise.resolve();
function serializeLaunch<T>(fn: () => Promise<T>): Promise<T> {
  const run = _launchChain.then(fn, fn);
  _launchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let _systemChromiumPath: string | null | undefined;
function getSystemChromiumPath(): string | undefined {
  if (_systemChromiumPath !== undefined) return _systemChromiumPath ?? undefined;
  try {
    const out = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
    _systemChromiumPath = out && existsSync(out) ? out : null;
  } catch {
    _systemChromiumPath = null;
  }
  return _systemChromiumPath ?? undefined;
}

// ── Proxy exhaustion callback — bot.ts registers this to notify super admin ───
let _onProxyExhausted: (() => Promise<void>) | undefined;
let _lastProxyExhaustedNotifyMs = 0;
export function setOnProxyExhausted(cb: () => Promise<void>): void {
  _onProxyExhausted = cb;
}

/** Read the current maxUses from DB (default 8 if table/row missing) */
async function getProxyMaxUses(): Promise<number> {
  try {
    const [row] = await db.select().from(proxySettings).where(eq(proxySettings.id, 1)).limit(1);
    return row?.maxUses ?? 8;
  } catch {
    return 8;
  }
}

// ── Proxy config (DB pool → env fallback → Webshare API) ─────────────────────
interface ProxyConfig {
  server: string;       // "http://host:port"
  username?: string;    // undefined = no-auth proxy
  password?: string;
  ipId?: number;        // proxyIps.id — set when picked from DB pool
}

let _webshareCache: Omit<ProxyConfig, "ipId"> | null = null;
let _webshareCacheExpiry = 0;
const WEBSHARE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Strips accidental leading scheme so we can prepend http:// cleanly */
function normaliseProxyServer(raw: string): string {
  return `http://${raw.replace(/^https?:\/\//i, "")}`;
}

// Playwright page-load timeout — tunable for slow proxies (env: PLAYWRIGHT_GOTO_TIMEOUT, ms)
const _rawGotoTimeout = parseInt(process.env.PLAYWRIGHT_GOTO_TIMEOUT ?? "40000");
const PLAYWRIGHT_GOTO_TIMEOUT = Number.isFinite(_rawGotoTimeout) && _rawGotoTimeout > 0
  ? _rawGotoTimeout
  : 40_000;

// Absolute time budget for one Playwright card-entry automation (env:
// PLAYWRIGHT_TOTAL_TIMEOUT, ms). A watchdog force-kills the browser past this so
// a wedged chromium can never hang a flow forever. Generous — only a genuine
// hang reaches it; normal card entry finishes in a few seconds.
const _rawTotalTimeout = parseInt(process.env.PLAYWRIGHT_TOTAL_TIMEOUT ?? "120000");
const PLAYWRIGHT_TOTAL_TIMEOUT = Number.isFinite(_rawTotalTimeout) && _rawTotalTimeout > 0
  ? _rawTotalTimeout
  : 120_000;

// Max time to wait for a graceful browser.close() before hard-killing chromium.
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

// Max time to wait for browser.launch() itself to settle. A hung launch (dead
// proxy, exhausted resources) must fail fast with a clear logged reason instead
// of silently stalling until the much coarser PLAYWRIGHT_TOTAL_TIMEOUT watchdog.
const PLAYWRIGHT_LAUNCH_TIMEOUT_MS = 30_000;

// Never run more than this many headless browsers at once (env:
// PLAYWRIGHT_MAX_CONCURRENCY). Lowered from 2→1 on request: this is the only
// gate around the actual card tokenization (open page → fill → submit), so
// pinning it to 1 guarantees the bank never sees two card submissions at the
// same instant even while BATCH_CONCURRENCY lets other sessions run their
// non-sensitive Telegram-only steps (get invoice, accept terms, wait for
// 3DS/receipt) in parallel. Also still caps container memory use.
const _rawMaxConc = parseInt(process.env.PLAYWRIGHT_MAX_CONCURRENCY ?? "1");
const PLAYWRIGHT_MAX_CONCURRENCY = Number.isFinite(_rawMaxConc) && _rawMaxConc > 0
  ? _rawMaxConc
  : 1;

// Lightweight async semaphore for the browser cap. releaseBrowserSlot hands the
// freed slot directly to the next waiter so the active count stays exact even
// when a flow is force-cancelled.
let _activeBrowsers = 0;
const _browserWaitQueue: Array<() => void> = [];
/**
 * `onQueued` fires only when the slot is NOT immediately available, so
 * callers can tell the operator "waiting in line" instead of the misleading
 * "entering card data" while nothing is actually happening for that session
 * yet (see PLAYWRIGHT_MAX_CONCURRENCY=1 mutex above).
 */
async function acquireBrowserSlot(onQueued?: () => void): Promise<void> {
  if (_activeBrowsers < PLAYWRIGHT_MAX_CONCURRENCY) {
    _activeBrowsers++;
    return;
  }
  onQueued?.();
  await new Promise<void>((resolve) => _browserWaitQueue.push(resolve));
}
function releaseBrowserSlot(): void {
  const next = _browserWaitQueue.shift();
  if (next) {
    next();
  } else {
    _activeBrowsers = Math.max(0, _activeBrowsers - 1);
  }
}

/**
 * Pick the best proxy to use:
 *  1. Active rows in `proxy_ips` table (ordered by usedCount ASC — least-used first)
 *  2. WEBSHARE_PROXY_USERNAME/PASSWORD env vars (direct)
 *  3. WEBSHARE_API_KEY → fetch credentials from Webshare API (cached 1h)
 */
async function getProxyConfig(): Promise<ProxyConfig | undefined> {
  // ── Priority 1: DB proxy pool (respect maxUses limit) ─────────────────────
  try {
    const maxUses = await getProxyMaxUses();
    const rows = await db
      .select()
      .from(proxyIps)
      .where(and(eq(proxyIps.isActive, true), lt(proxyIps.usedCount, maxUses)))
      .orderBy(asc(proxyIps.usedCount), asc(proxyIps.lastUsedAt), asc(proxyIps.id))
      .limit(5);

    // Skip any IP currently on a post-payment-decline cooldown (see
    // cooldownProxyIp) *and* any IP another concurrent/just-started session
    // already grabbed (see _proxyInFlight below). Without the in-flight check,
    // several sessions launched close together (a 5-target batch run) would
    // all read the same "least used" row before any of them finishes long
    // enough to bump usedCount/lastUsedAt — i.e. every session in the batch
    // tokenizing through the exact same IP, which is the opposite of what
    // proxy rotation is for.
    const row = rows.find((r) => !isProxyIpOnCooldown(r.id) && !_proxyInFlight.has(r.id));

    if (row) {
      const cfg: ProxyConfig = {
        server: normaliseProxyServer(row.server),
        ...(row.username ? { username: row.username, password: row.password ?? "" } : {}),
        ipId: row.id,
      };
      // Reserve immediately (released once this session's tokenization attempt
      // is done, see releaseProxyIpReservation) and touch lastUsedAt right now
      // — not just on eventual full-payment success — so the *next* selection
      // (even milliseconds later, before this one has succeeded or failed)
      // sorts this row to the back of its usedCount tier instead of picking it
      // again. This is what actually rotates IPs across a batch of sessions
      // started back-to-back, since a full flow (3DS, bank checks, etc.) can
      // take minutes before incrementProxyIpUsage ever runs.
      _proxyInFlight.add(row.id);
      db.update(proxyIps)
        .set({ lastUsedAt: new Date() })
        .where(eq(proxyIps.id, row.id))
        .catch((err) => logger.warn({ err, ipId: row.id }, "Failed to touch proxy lastUsedAt on selection"));
      logger.info({ server: cfg.server, usedCount: row.usedCount, maxUses }, "Using DB proxy IP");
      return cfg;
    }

    // Check if there are active IPs at all — if yes, they're all exhausted
    const anyActive = await db
      .select({ id: proxyIps.id })
      .from(proxyIps)
      .where(eq(proxyIps.isActive, true))
      .limit(1);
    if (anyActive.length > 0) {
      logger.warn({ maxUses }, "All DB proxy IPs exhausted — falling back to Webshare");
      // Debounce: notify at most once per 60 s to prevent spam when many flows run concurrently
      const now = Date.now();
      if (_onProxyExhausted && now - _lastProxyExhaustedNotifyMs > 60_000) {
        _lastProxyExhaustedNotifyMs = now;
        _onProxyExhausted().catch(() => {});
      }
    }
  } catch (err) {
    logger.warn({ err }, "DB proxy pool query failed — falling back");
  }

  // ── Priority 2: direct env vars ────────────────────────────────────────────
  const directUser = process.env.WEBSHARE_PROXY_USERNAME;
  const directPass = process.env.WEBSHARE_PROXY_PASSWORD;
  const rawServer = process.env.WEBSHARE_PROXY_SERVER ?? "p.webshare.io:80";
  if (directUser && directPass) {
    return { server: normaliseProxyServer(rawServer), username: directUser, password: directPass };
  }

  // ── Priority 3: Webshare API (cached) ─────────────────────────────────────
  const apiKey = process.env.WEBSHARE_API_KEY;
  if (!apiKey) return undefined;

  if (_webshareCache && Date.now() < _webshareCacheExpiry) return _webshareCache;

  try {
    const controller = new AbortController();
    const tmout = setTimeout(() => controller.abort(), 8_000);
    let res: Response;
    try {
      res = await fetch("https://proxy.webshare.io/api/v2/proxy/config/", {
        headers: { Authorization: `Token ${apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(tmout);
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, "Webshare API returned non-200");
      return _webshareCache ?? undefined;
    }
    const data = await res.json() as { username?: string; password?: string; proxy_address?: string; port?: number };
    if (!data.username || !data.password) {
      logger.warn("Webshare API response missing username/password");
      return _webshareCache ?? undefined;
    }
    const rawProxy = data.proxy_address
      ? `${data.proxy_address}:${data.port ?? 80}`
      : "p.webshare.io:80";
    _webshareCache = { server: normaliseProxyServer(rawProxy), username: data.username, password: data.password };
    _webshareCacheExpiry = Date.now() + WEBSHARE_CACHE_TTL_MS;
    logger.info({ server: _webshareCache.server }, "Webshare proxy config loaded from API");
    return _webshareCache;
  } catch (err) {
    logger.warn({ err }, "Failed to fetch Webshare proxy config");
    return _webshareCache ?? undefined;
  }
}

/** Increment usedCount for a DB proxy IP after a successful premium purchase.
 *  Also clears the failure counter — a proxy that just worked is healthy. */
export async function incrementProxyIpUsage(ipId: number): Promise<void> {
  try {
    await db
      .update(proxyIps)
      .set({
        usedCount: sql`${proxyIps.usedCount} + 1`,
        lastUsedAt: new Date(),
        failCount: 0,
        lastFailedAt: null,
      })
      .where(eq(proxyIps.id, ipId));
  } catch (err) {
    logger.warn({ err, ipId }, "incrementProxyIpUsage failed");
  }
}

// After this many consecutive connect failures a proxy is auto-deactivated so it
// drops out of rotation without human intervention (env: PROXY_MAX_FAILURES).
const _rawMaxFailures = parseInt(process.env.PROXY_MAX_FAILURES ?? "3");
const PROXY_MAX_FAILURES = Number.isFinite(_rawMaxFailures) && _rawMaxFailures > 0
  ? _rawMaxFailures
  : 3;

// ── Short-term proxy cooldown ────────────────────────────────────────────────
// A PAYMENT_FAILED decline from Telegram/the bank can be an anti-fraud
// signal tied to the tokenizing browser's IP. Rather than waiting for
// PROXY_MAX_FAILURES connect failures to auto-retire the proxy (that counter
// is for dead/unreachable proxies), put it on an immediate in-memory cooldown
// so the very next selection picks a different IP — i.e. "avto ip almashtir".
const PAYMENT_FAILURE_COOLDOWN_MS = 30 * 60_000; // 30 minutes
const _proxyCooldownUntil = new Map<number, number>();

// ── In-flight reservation ────────────────────────────────────────────────────
// Belt-and-suspenders against two sessions started close together (e.g. a
// batch of 5) both reading the same "least used" row before either one's
// lastUsedAt write has landed. Reserved the instant a proxy is selected,
// released once that session's tokenization attempt is over (success,
// failure, or fallback to direct connection) via releaseProxyIpReservation.
const _proxyInFlight = new Set<number>();

/** Free up an in-flight reservation so the IP can be picked again later. Safe
 *  to call multiple times or with undefined (no-op). */
function releaseProxyIpReservation(ipId: number | undefined): void {
  if (ipId !== undefined) _proxyInFlight.delete(ipId);
}

function cooldownProxyIp(ipId: number, ms = PAYMENT_FAILURE_COOLDOWN_MS): void {
  _proxyCooldownUntil.set(ipId, Date.now() + ms);
  logger.warn({ ipId, ms }, "Proxy IP put on cooldown after payment decline");
}

function isProxyIpOnCooldown(ipId: number): boolean {
  const until = _proxyCooldownUntil.get(ipId);
  if (!until) return false;
  if (Date.now() >= until) {
    _proxyCooldownUntil.delete(ipId);
    return false;
  }
  return true;
}

/**
 * Record a connect failure for a DB proxy IP. Increments failCount atomically;
 * once it reaches PROXY_MAX_FAILURES the proxy is set is_active = false so it
 * stops being picked. A later successful use resets the counter (see
 * incrementProxyIpUsage). Manually-disabled proxies are unaffected.
 */
export async function recordProxyIpFailure(ipId: number): Promise<void> {
  try {
    const [row] = await db
      .update(proxyIps)
      .set({
        failCount: sql`${proxyIps.failCount} + 1`,
        lastFailedAt: new Date(),
        // Deactivate in the same statement once the threshold is reached.
        isActive: sql`CASE WHEN ${proxyIps.failCount} + 1 >= ${PROXY_MAX_FAILURES} THEN false ELSE ${proxyIps.isActive} END`,
      })
      .where(eq(proxyIps.id, ipId))
      .returning({ failCount: proxyIps.failCount, isActive: proxyIps.isActive });

    if (row && !row.isActive) {
      logger.warn(
        { ipId, failCount: row.failCount, maxFailures: PROXY_MAX_FAILURES },
        "Proxy IP auto-retired after consecutive connect failures",
      );
    } else if (row) {
      logger.info(
        { ipId, failCount: row.failCount, maxFailures: PROXY_MAX_FAILURES },
        "Recorded proxy IP connect failure",
      );
    }
  } catch (err) {
    logger.warn({ err, ipId }, "recordProxyIpFailure failed");
  }
}

export interface PremiumCardData {
  cardNumber: string;
  expiry: string; // MM/YY
  cvv: string;
  cardHolder: string;
}

export interface PremiumFlowResult {
  success: boolean;
  hasPremium: boolean;
  premiumExpiresAt?: Date;
  message: string;
  /**
   * Whether step 6 (cancel auto-renewal) confirmed success via button clicks.
   * `undefined` means that step was never attempted for this run (e.g. the
   * "already has Premium" early-exit path skips straight to logout+verify).
   */
  autoRenewalCancelled?: boolean;
  /**
   * True when the failure is specifically a PAYMENT_FAILED decline from
   * Telegram/the bank (card tokenized fine, but the charge itself was
   * rejected). Callers can use this to offer the operator a retry with a
   * different saved card instead of just marking the target failed.
   */
  paymentDeclined?: boolean;
}

// ── Centralized selector config ───────────────────────────────────────────────

const SELECTORS = {
  /** Card number inputs */
  cardNumber: [
    // Smart Glocal (Telegram Premium payment provider)
    'input[name="paymentDetails.card.number"]',
    'input[placeholder="1234 5678 1234 5678"]',
    // Standard autocomplete / generic
    'input[autocomplete="cc-number"]',
    'input[name="cardnumber"]',
    'input[name="card_number"]',
    'input[placeholder*="1234"]',
    'input[placeholder*="card"]',
    'input[placeholder*="karta"]',
    'input[data-field="number"]',
    'input[id*="card"]',
  ],
  /** Expiry inputs */
  expiry: [
    // Smart Glocal
    'input[name="paymentDetails.card.expirationDate"]',
    'input[placeholder="MM/YY"]',
    // Standard
    'input[autocomplete="cc-exp"]',
    'input[name="exp-date"]',
    'input[name="expiry"]',
    'input[name="card_expiry"]',
    'input[placeholder*="MM"]',
    'input[placeholder*="muddat"]',
    'input[data-field="expiry"]',
  ],
  /** CVC inputs */
  cvc: [
    // Smart Glocal
    'input[name="paymentDetails.card.securityCode"]',
    'input[placeholder="CVC"]',
    // Standard
    'input[autocomplete="cc-csc"]',
    'input[name="cvc"]',
    'input[name="cvv"]',
    'input[name="card_cvv"]',
    'input[placeholder*="CVC"]',
    'input[placeholder*="CVV"]',
    'input[placeholder*="security"]',
    'input[data-field="cvv"]',
  ],
  /** Card holder name inputs */
  holder: [
    'input[autocomplete="cc-name"]',
    'input[name="cardholder"]',
    'input[name="holder"]',
    'input[name="card_holder"]',
    'input[placeholder*="holder"]',
    'input[placeholder*="name"]',
    'input[placeholder*="ism"]',
    'input[data-field="holder"]',
  ],
  /** Stripe iframe selectors */
  stripeIframes: [
    'iframe[name*="privateStripe"]',
    'iframe[name*="stripe"]',
    'iframe[src*="js.stripe.com"]',
    'iframe[src*="stripe"]',
  ],
  /** Stripe iframe card field selectors */
  stripeCard: 'input[autocomplete="cc-number"], input[name="cardnumber"], input[placeholder*="1234"], input[placeholder*="card number"]',
  stripeExpiry: 'input[autocomplete="cc-exp"], input[name="exp-date"], input[placeholder*="MM / YY"], input[placeholder*="MM/YY"]',
  stripeCvc: 'input[autocomplete="cc-csc"], input[name="cvc"], input[placeholder*="CVC"], input[placeholder*="CVV"]',
  /** Pay/submit buttons */
  payButton: [
    'button[type="submit"]',
    "button:has-text(\"To'lash\")",
    'button:has-text("Pay")',
    'button:has-text("Оплатить")',
    'button:has-text("Confirm")',
    'button:has-text("Continue")',
    'button:has-text("Subscribe")',
    "button:has-text(\"To'lov\")",
    'button:has-text("Send")',
    'button:has-text("Done")',
    'a:has-text("Done")',
  ],
};

// ── Generic helpers ───────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Wait for the next message from a specific bot, with optional filter.
 * Returns null on timeout.
 */
function waitForBotMsg(
  client: TelegramClient,
  botUsername: string,
  filter: (msg: any) => boolean = () => true,
  timeoutMs = 30000,
): Promise<any | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const evFilter = new NewMessage({ fromUsers: [botUsername] });
    let handler: (e: NewMessageEvent) => Promise<void>;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { client.removeEventHandler(handler, evFilter); } catch (_) {}
      resolve(null);
    }, timeoutMs);
    handler = async (e: NewMessageEvent) => {
      const msg = e.message;
      if (!filter(msg)) return;
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { client.removeEventHandler(handler, evFilter); } catch (_) {}
      resolve(msg);
    };
    client.addEventHandler(handler, evFilter);
  });
}

/** Save a Playwright screenshot to /tmp for diagnosis */
async function saveFailureScreenshot(page: any, label: string): Promise<void> {
  try {
    const ts = Date.now();
    const filePath = join(tmpdir(), `premium-fail-${label}-${ts}.png`);
    const screenshotBuf: Buffer = await page.screenshot({ fullPage: true });
    await writeFile(filePath, screenshotBuf);
    logger.warn({ screenshotPath: filePath }, "Saved failure screenshot");
  } catch (err) {
    logger.warn({ err }, "Could not save failure screenshot");
  }
}

/** Log page HTML for selector diagnosis */
async function logVisibleHtml(page: any): Promise<void> {
  try {
    const html: string = await page.evaluate(() =>
      (globalThis as any).document.body.innerHTML.slice(0, 4000),
    );
    logger.warn({ visibleHtml: html }, "Visible page HTML (selector diagnosis)");
  } catch (_) {}
}

/**
 * Auto-detect confirmed Premium activation by polling @premiumbot with /start.
 *
 * After a bank 3DS challenge, we used to depend entirely on the operator
 * pressing "✅ 3DS Tugadi — Davom et" (or a 5-minute auto-continue timer).
 * That button/webview path has repeatedly proven unreliable (Mini App
 * WebView quirks, operator missing the message, etc.) and leaves the flow
 * "stuck" from the operator's point of view.
 *
 * This polls independently: sends /start up to `attempts` times (every
 * `intervalMs`), and returns true the moment @premiumbot's reply text starts
 * with "Your Telegram Premium Plan:" — the same text @premiumbot shows for
 * any account that already has an active Premium subscription. Any single
 * failed attempt (timeout, network hiccup) is swallowed and retried; this
 * function never throws.
 */
export async function pollPremiumActiveViaStart(
  client: TelegramClient,
  premiumBotUsername: string,
  attempts: number = 3,
  intervalMs: number = 20000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await delay(intervalMs);
    try {
      const msgPromise = waitForBotMsg(client, premiumBotUsername, () => true, 15000);
      await client.sendMessage(premiumBotUsername, { message: "/start" });
      const msg = await msgPromise;
      const text: string = (msg?.text ?? msg?.message ?? "").trim();
      const lower = text.toLowerCase();
      logger.info(
        { premiumBotUsername, attempt: i + 1, attempts, textStart: text.slice(0, 40) },
        "pollPremiumActiveViaStart: /start check",
      );
      // @premiumbot phrases the "already active" reply differently depending
      // on account/version — seen so far: "Your Telegram Premium Plan: ..."
      // AND "You have an active Telegram Premium subscription." Matching only
      // the first phrase meant the second wording was silently never
      // detected as active. Match the same broad signal set used by
      // checkPremiumWithPremiumBot instead of one exact phrase.
      const isActive =
        lower.includes("your telegram premium plan") ||
        lower.includes("you have an active") ||
        lower.includes("premium plan") ||
        (lower.includes("premium") && lower.includes("next payment"));
      if (isActive) {
        logger.info({ premiumBotUsername, attempt: i + 1 }, "pollPremiumActiveViaStart: Premium confirmed active");
        return true;
      }
    } catch (err) {
      logger.warn({ err, attempt: i + 1 }, "pollPremiumActiveViaStart: attempt failed — retrying");
    }
  }
  return false;
}

// ── Step 1: Send /start → get invoice message ─────────────────────────────────

/**
 * Sends /start to @PremiumBot, waits for an invoice message.
 * Returns the invoice message or null on timeout.
 */
async function _getInvoiceFromPremiumBotOnce(
  client: TelegramClient,
  botUsername: string,
): Promise<{ invoice: any | null; firstMsgText: string | null }> {
  // Listen for any message from the bot BEFORE sending /start so we never
  // miss a fast reply. The listener has a 30 s hard cap.
  const msgPromise = waitForBotMsg(client, botUsername, () => true, 30000);

  // sendMessage itself can hang indefinitely if the MTProto layer stalls —
  // race it against a 15 s timeout so the outer retry can kick in.
  await Promise.race([
    client.sendMessage(botUsername, { message: "/start" }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("sendMessage /start timeout (15s)")), 15_000),
    ),
  ]);

  const msg = await msgPromise;
  if (!msg) {
    logger.warn({ botUsername }, "No response from PremiumBot after /start");
    return { invoice: null, firstMsgText: null };
  }

  // Check if the message itself is an invoice
  const mediaType = msg.media?.className ?? "";
  if (mediaType === "MessageMediaInvoice") {
    logger.info({ botUsername, title: msg.media?.title }, "Received invoice message from PremiumBot");
    return { invoice: msg, firstMsgText: null };
  }

  // Not an invoice — capture text (may be "already active" or a welcome/loading msg)
  const firstMsgText: string = (msg.text ?? msg.message ?? "").trim();
  logger.info({ botUsername, mediaType, text: firstMsgText.slice(0, 120) }, "First message is not invoice — waiting for follow-up invoice");

  const invoiceMsg = await waitForBotMsg(
    client,
    botUsername,
    (m) => m.media?.className === "MessageMediaInvoice",
    20000,
  );
  if (!invoiceMsg) {
    logger.warn({ botUsername, firstMsgText: firstMsgText.slice(0, 120) }, "No invoice message received from PremiumBot");
  } else {
    logger.info({ botUsername, title: invoiceMsg.media?.title }, "Received invoice message");
  }
  return { invoice: invoiceMsg ?? null, firstMsgText };
}

export async function getInvoiceFromPremiumBot(
  client: TelegramClient,
  botUsername: string,
  maxAttempts = 2,
): Promise<{ invoice: any | null; firstMsgText: string | null }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await _getInvoiceFromPremiumBotOnce(client, botUsername);
      if (result.invoice || result.firstMsgText !== null) {
        // Got either an invoice or a meaningful first message — return immediately
        return result;
      }
      // Pure timeout (null, null) — retry if attempts remain
      if (attempt < maxAttempts - 1) {
        logger.warn({ botUsername, attempt: attempt + 1 }, "getInvoiceFromPremiumBot: pure timeout — retrying");
        await delay(3000);
      }
    } catch (err) {
      logger.error({ err, attempt: attempt + 1 }, "getInvoiceFromPremiumBot attempt error");
      if (attempt < maxAttempts - 1) await delay(3000);
    }
  }
  return { invoice: null, firstMsgText: null };
}

// ── Step 2: Accept terms (click inline button if present) ─────────────────────

/**
 * Looks at the invoice message buttons for a terms-acceptance button and clicks it.
 * Common labels: "I Accept", "Qabul qilaman", "Agree", etc.
 * Returns true if a button was clicked.
 */
export async function acceptTermsIfPresent(
  client: TelegramClient,
  botUsername: string,
  invoiceMsg: any,
): Promise<boolean> {
  try {
    const markup = invoiceMsg.replyMarkup;
    if (!markup?.rows) return false;

    const termsKeywords = [
      "accept", "qabul", "agree", "roziman", "ha", "yes", "ok",
      "i accept", "i agree", "qabul qilaman", "shartlar", "terms",
    ];

    for (const row of markup.rows) {
      for (const btn of (row.buttons ?? [])) {
        const btnText: string = ((btn as any).text ?? "").toLowerCase();
        const isTermsBtn = termsKeywords.some((kw) => btnText.includes(kw));
        if (!isTermsBtn) continue;

        const data = (btn as any).data;
        if (!data) continue;

        logger.info({ btnText }, "Clicking terms acceptance button");

        const peer = await client.getInputEntity(botUsername);
        await client.invoke(
          new Api.messages.GetBotCallbackAnswer({
            peer,
            msgId: invoiceMsg.id,
            data: Buffer.from(data),
          }),
        );

        // Bot may respond by editing the existing message (not sending a new one),
        // so we just give it a short fixed delay instead of blocking on a new message.
        await delay(2000);
        logger.info({ btnText }, "Terms accepted");
        return true;
      }
    }

    logger.info({ botUsername }, "No terms acceptance button found — proceeding directly to payment");
    return false;
  } catch (err) {
    logger.warn({ err }, "acceptTermsIfPresent error — continuing anyway");
    return false;
  }
}

// ── Step 3: Get payment form (URL + form_id) via MTProto ──────────────────────

export interface PaymentFormInfo {
  url: string;
  formId: bigint;
  /** Stripe publishable key — present when the provider is Stripe (repreambot). */
  providerPublicKey?: string;
}

/**
 * Calls payments.GetPaymentForm for the invoice message.
 * Returns the payment provider URL + form_id + optional Stripe key.
 */
export async function getPaymentFormUrl(
  client: TelegramClient,
  botUsername: string,
  invoiceMsg: any,
): Promise<string | null> {
  const info = await getPaymentForm(client, botUsername, invoiceMsg);
  return info?.url ?? null;
}

export async function getPaymentForm(
  client: TelegramClient,
  botUsername: string,
  invoiceMsg: any,
): Promise<PaymentFormInfo | null> {
  try {
    const peer = await client.getInputEntity(botUsername);

    const result = await client.invoke(
      new Api.payments.GetPaymentForm({
        invoice: new Api.InputInvoiceMessage({
          peer: peer as any,
          msgId: invoiceMsg.id,
        }),
        themeParams: new Api.DataJSON({ data: "{}" }),
      }),
    );

    const formUrl: string | undefined = (result as any).url;
    // gramjs exposes the TL field form_id as both camelCase and snake_case — try both
    const formId: bigint | undefined =
      (result as any).formId ?? (result as any).form_id;
    const providerPublicKey: string | undefined =
      (result as any).providerPublicKey ?? (result as any).provider_public_key;

    if (!formUrl && !providerPublicKey) {
      logger.warn({ result: JSON.stringify(result).slice(0, 300) }, "GetPaymentForm returned no URL or providerPublicKey");
      return null;
    }

    const safeUrl = (() => {
      try { const u = new URL(formUrl ?? ""); return `${u.host}${u.pathname}`; } catch { return "(no url)"; }
    })();
    logger.info(
      { safeUrl, formId: formId?.toString(), hasStripeKey: !!providerPublicKey },
      "Got payment form info from Telegram",
    );
    return { url: formUrl ?? "", formId: formId ?? BigInt(0), providerPublicKey };
  } catch (err) {
    logger.error({ err }, "getPaymentForm error");
    return null;
  }
}

// ── Step 4: Fill card in Playwright, capture Smart Glocal token ───────────────

export interface PlaywrightCardResult {
  /** Whether the form was submitted without an obvious error */
  submitted: boolean;
  /** Raw credential token from Smart Glocal (JSON string or raw token) */
  credentials?: string;
  /** proxyIps.id of the IP used — caller should call incrementProxyIpUsage after confirmed payment success */
  proxyIpId?: number;
  /**
   * True when the tokenization page itself showed a decline/error message
   * after submit (e.g. anti-fraud block on this specific card/IP combo),
   * as opposed to a technical failure (missing fields, no button, launch
   * timeout). Callers can use this the same way as PremiumFlowResult's
   * `paymentDeclined` — offer the operator a different saved card — since
   * swapping cards can't fix a technical failure but can fix an anti-fraud
   * block.
   */
  cardBlocked?: boolean;
}

/**
 * 3DS OTP selectors — covers Smart Glocal, AcqPay, and common bank 3DS pages.
 * Checked after clicking the pay button; if any is visible we're on an OTP page.
 */
const OTP_SELECTORS = [
  'input[inputmode="numeric"]',
  'input[maxlength="6"]',
  'input[maxlength="5"]',
  'input[maxlength="4"]',
  'input[name*="otp"]',
  'input[name*="code"]',
  'input[name*="sms"]',
  'input[name*="token"]',
  'input[id*="otp"]',
  'input[id*="code"]',
  'input[placeholder*="kod"]',
  'input[placeholder*="code"]',
  'input[placeholder*="SMS"]',
  'input[placeholder*="OTP"]',
  'input[placeholder*="6 ta"]',
  '.otp-input input',
  '.code-input input',
];

/** OTP page submit button selectors */
const OTP_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  "button:has-text(\"Tasdiqlash\")",
  'button:has-text("Подтвердить")',
  'button:has-text("Confirm")',
  'button:has-text("Verify")',
  'button:has-text("OK")',
  'button:has-text("Yuborish")',
  'button:has-text("Send")',
  'button:has-text("Continue")',
];

/**
 * Keywords that indicate the page is a 3DS / OTP verification page rather
 * than the original card-fill form.  At least one must appear in the visible
 * page text before we accept an input as an OTP field (avoids false triggers
 * from numeric inputs still present on the payment form itself).
 */
const OTP_PAGE_KEYWORDS = [
  "3d", "3ds", "sms", "otp", "kod", "code", "tasdiqlash", "подтверд",
  "verify", "verification", "authenticate", "secure", "одноразов",
];

/**
 * Returns true if the current page body text contains at least one 3DS/OTP
 * keyword — used to confirm we've navigated away from the card form.
 */
async function isOtpPage(page: any): Promise<boolean> {
  try {
    const text: string = await page.evaluate(
      () => ((globalThis as any).document.body?.innerText ?? "").toLowerCase(),
    );
    return OTP_PAGE_KEYWORDS.some((kw) => text.includes(kw));
  } catch {
    return false;
  }
}

/**
 * After clicking the pay button, wait up to 10 s for a 3DS OTP input to appear.
 * If found: calls `askOtp()` to get the code from the operator, fills it, and
 * clicks the confirm button.
 *
 * Returns true only if OTP was filled AND a submit button was successfully
 * clicked (or if the input itself triggers auto-submit on fill).
 */
async function handle3dsOtpIfNeeded(
  page: any,
  askOtp: () => Promise<string | null>,
  debugLabel: string,
): Promise<boolean> {
  // Poll for up to 10 s (20 × 500 ms)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);

    // First confirm we're on a 3DS/OTP page (page text context check — Bug #2)
    if (!(await isOtpPage(page))) continue;

    for (const sel of OTP_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;

        logger.info({ sel }, "3DS OTP input detected — requesting code from operator");
        // Screenshot so the operator can see context if needed
        await saveFailureScreenshot(page, `${debugLabel}-3ds-otp`);

        const otp = await askOtp();
        if (!otp) {
          logger.warn("Operator did not provide OTP in time — skipping 3DS");
          return false;
        }

        // Clear field first, then type the OTP
        await el.fill("");
        await el.fill(otp);
        logger.info({ otpLen: otp.length }, "Filled OTP field");
        await page.waitForTimeout(400);

        // Click submit / confirm button — track whether we actually clicked (Bug #3)
        let submitClicked = false;
        for (const btnSel of OTP_SUBMIT_SELECTORS) {
          try {
            const btn = page.locator(btnSel).first();
            if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
              await btn.click();
              submitClicked = true;
              logger.info({ btnSel }, "Clicked OTP submit button");
              break;
            }
          } catch (_) {}
        }

        if (!submitClicked) {
          // Some forms auto-submit when all digits are entered (e.g. 6-digit).
          // Log a warning but still wait and let credential capture decide outcome.
          logger.warn("No OTP submit button found — relying on auto-submit or Enter key");
          // Try pressing Enter as a last resort
          await el.press("Enter").catch(() => {});
        }

        await page.waitForTimeout(1000);
        // Return true only if submit was clicked OR auto-submit is plausible
        // (input maxlength matches OTP length → browser may auto-submit)
        if (submitClicked) return true;
        const maxLen = await el.getAttribute("maxlength").catch(() => null);
        const autoSubmitLikely = maxLen !== null && otp.length >= Number(maxLen);
        if (autoSubmitLikely) {
          logger.info({ maxLen, otpLen: otp.length }, "Auto-submit likely (maxlength reached)");
          return true;
        }
        logger.warn("OTP filled but submit unclear — continuing without 3DS confirmation");
        return false;
      } catch (_) {}
    }
  }
  return false;
}

/**
 * Fills a card field in a way that is compatible with Maskito-masked inputs
 * (used by Smart Glocal). Plain `.fill()` sets the DOM value directly and
 * bypasses Maskito's keyboard-event hooks, so React's controlled-component
 * `onChange` never fires and the form state stays empty.
 *
 * Strategy:
 *  1. Click the field to focus it.
 *  2. Select-all + Delete to clear any existing value (works even when the
 *     field is controlled and `.fill("")` is not enough).
 *  3. `pressSequentially` types one character at a time, triggering the full
 *     keydown → beforeinput → input → keyup chain that Maskito and React
 *     controlled inputs both rely on.
 */
async function humanFill(locator: any, text: string): Promise<void> {
  await locator.click();
  // Clear existing value the keyboard way so Maskito resets properly
  await locator.press("Control+a");
  await locator.press("Delete");
  await locator.pressSequentially(text, { delay: 40 });
}

/**
 * Opens the payment/tokenization URL in a headless browser, fills in the saved
 * card, submits, handles 3DS OTP if the bank requires it, and captures the
 * tokenization credential sent by the payment provider (Smart Glocal) via
 * postMessage / network interception.
 */
export async function payPremiumViaWebApp(
  formUrl: string,
  card: PremiumCardData,
  debugLabel = "unknown",
  /** Called when a 3DS OTP page appears — should ask the operator for the SMS code */
  askOtp?: () => Promise<string | null>,
  /** Called only if this session has to wait for another session's browser slot */
  onQueued?: () => void,
  /** Called right after the slot is actually acquired (queued or not) — safe to tell the operator card entry is starting now */
  onSlotAcquired?: () => void,
): Promise<PlaywrightCardResult> {
  let browser: any = null;
  let page: any = null;

  // Declared here so the response interceptor closure always writes to the same variable,
  // even after a proxy-fallback relaunch.
  let capturedCredentials: string | undefined;

  // Set inside the try block once a proxy is selected; declared here (rather
  // than with `const` inside the try) so the finally block below can always
  // see it to release the in-flight reservation, no matter how the attempt ends.
  let reservedProxyIpId: number | undefined;

  // Cap concurrent headless browsers so one busy operator can't exhaust the
  // container's memory and freeze the whole bot for everyone else.
  await acquireBrowserSlot(onQueued);
  onSlotAcquired?.();

  // Once-guard: guarantees releaseBrowserSlot() is called exactly once even if
  // both the watchdog and the finally block run (race between timeout and normal
  // teardown). Without this, a double-release would corrupt _activeBrowsers.
  let _slotReleased = false;
  const releaseSlotOnce = () => {
    if (!_slotReleased) {
      _slotReleased = true;
      releaseBrowserSlot();
    }
  };

  // Watchdog: if any Playwright await wedges and never settles (a dead chromium
  // ignoring browser.close(), a stuck page.evaluate, a hung network read, or
  // browser.process() returning null so SIGKILL never fires), the finally below
  // might never run. The watchdog closes the browser gracefully first, then
  // SIGKILLs the process, then UNCONDITIONALLY releases the slot — so a stuck
  // step 4 can never block every other operator forever.
  let watchdogFired = false;
  const watchdog = setTimeout(async () => {
    watchdogFired = true;
    logger.error(
      { debugLabel, budgetMs: PLAYWRIGHT_TOTAL_TIMEOUT },
      "payPremiumViaWebApp watchdog fired — force-closing browser and releasing slot",
    );
    // 1. Graceful close (best-effort, 3 s max)
    if (browser) {
      try {
        await Promise.race([
          browser.close(),
          new Promise<void>((r) => setTimeout(r, 3_000)),
        ]);
      } catch (_) {}
    }
    // 2. SIGKILL if process handle is available
    try { browser?.process()?.kill("SIGKILL"); } catch (_) {}
    // 3. Unconditionally release the semaphore slot so queued operators unblock
    releaseSlotOnce();
  }, PLAYWRIGHT_TOTAL_TIMEOUT);

  try {
    const pw = await import("playwright");

    // ── Proxy (DB pool → env → Webshare API) ──────────────────────────────────
    const proxyConfig = await getProxyConfig();
    // Track for usage increment on success. Cleared if we fall back to a direct
    // connection, so a proxy that didn't actually work isn't credited a success
    // (which would otherwise reset its failure counter).
    let proxyIpId = proxyConfig?.ipId;
    // Unlike proxyIpId above, this never gets cleared on fallback — it's only
    // used to release the in-flight reservation taken out in getProxyConfig(),
    // which must happen regardless of how this attempt turns out.
    reservedProxyIpId = proxyConfig?.ipId;

    // ── Inner helper: launch browser + create page + wire interceptors ─────────
    // Extracted so we can relaunch without proxy when the proxy blocks the site.
    const launchPage = async (useProxy: boolean): Promise<void> => {
      const cfg = useProxy ? proxyConfig : undefined;
      // Prefer the Nix-installed system chromium (identical on dev + prod,
      // see getSystemChromiumPath). Fall back to
      // REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE (only realized on some dev
      // machines) and finally to Playwright's own bundled browser if neither
      // system path exists.
      const systemChromiumPath = getSystemChromiumPath();
      const replitChromiumPath = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
      const useReplitChromium =
        !systemChromiumPath && !!replitChromiumPath && existsSync(replitChromiumPath);
      const executablePath = systemChromiumPath ?? (useReplitChromium ? replitChromiumPath : undefined);
      if (!systemChromiumPath && replitChromiumPath && !useReplitChromium) {
        logger.warn(
          { replitChromiumPath },
          "REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE set but not found on this machine — falling back to Playwright's own installed browser",
        );
      }
      logger.info(
        { systemChromiumPath, useReplitChromium, executablePath: executablePath ?? "(playwright bundled)" },
        "Resolved chromium executable for launch",
      );
      const launchOpts = {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        // --no-sandbox + --disable-setuid-sandbox: required in containers/as root
        // (no user namespaces). Both flags needed — setuid-sandbox is a separate
        // layer from the regular sandbox that also fails in restricted runtimes.
        // --disable-dev-shm-usage: /dev/shm is tiny (or absent) in constrained VM
        // containers, which otherwise crashes/hangs Chromium renderer processes.
        // --disable-gpu: no GPU device available here.
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        ...(cfg ? {
          proxy: {
            server: cfg.server,
            ...(cfg.username ? { username: cfg.username, password: cfg.password ?? "" } : {}),
          },
        } : {}),
      };
      // withTimeout() can only stop *waiting* on pw.chromium.launch() — it cannot
      // actually cancel it. If the timeout fires first, the real launch keeps
      // running in the background and, if it eventually succeeds, hands back a
      // full chromium process that nothing ever closes: an orphaned browser.
      // Under repeated launch timeouts (e.g. a wedged proxy) these orphans pile
      // up and quietly consume the container's CPU/memory, which is exactly
      // what makes *every subsequent* launch — proxy or direct — take longer
      // and eventually time out too. launchRacingTimeout kills any late-arriving
      // browser so a timed-out attempt can never leak a live process.
      const launchRacingTimeout = (launchPromise: Promise<any>, label: string) => {
        const raced = withTimeout(launchPromise, PLAYWRIGHT_LAUNCH_TIMEOUT_MS, label);
        raced.catch(() => {
          launchPromise.then(
            (lateBrowser: any) => {
              logger.warn({ label }, "Chromium launch resolved after its own timeout — closing orphaned browser");
              try { lateBrowser?.close().catch(() => {}); } catch (_) {}
              try { lateBrowser?.process()?.kill("SIGKILL"); } catch (_) {}
            },
            () => {},
          );
        });
        return raced;
      };

      try {
        // Default: let Playwright pick its bundled headless-shell build for
        // `chromium` (fastest). If that specific browser wasn't downloaded by
        // the production build step (e.g. after a Playwright version bump
        // adds/renames a browser target), fall back to the full "chromium"
        // channel below instead of failing every payment outright.
        // Bounded explicitly (not just via the outer watchdog): a browser.launch()
        // that never settles (e.g. proxy misconfiguration, exhausted resources)
        // must fail fast with a clear, logged reason rather than silently stalling
        // until the much coarser 120s total-flow watchdog eventually kills it.
        browser = await launchRacingTimeout(serializeLaunch(() => pw.chromium.launch(launchOpts)), "Browser launch");
      } catch (launchErr: any) {
        const msg: string = launchErr?.message ?? "";
        if (!useReplitChromium && /Executable doesn't exist/i.test(msg)) {
          logger.warn(
            { err: msg.slice(0, 200) },
            "Default chromium launch failed (browser binary missing) — retrying with channel:'chromium'",
          );
          browser = await launchRacingTimeout(
            serializeLaunch(() => pw.chromium.launch({ ...launchOpts, channel: "chromium" })),
            "Browser launch (chromium channel)",
          );
        } else {
          logger.error({ err: msg.slice(0, 300), useProxy }, "Browser launch failed or timed out");
          throw launchErr;
        }
      }
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        viewport: { width: 390, height: 844 },
      });
      page = await context.newPage();

      // ── Intercept Smart Glocal tokenization API response ────────────────────
      page.on("response", async (response: any) => {
        try {
          if (capturedCredentials) return;
          const url: string = response.url();
          // Broadened beyond the initial tokenize call: after a 3DS OTP step,
          // Smart Glocal (or the issuing bank's ACS) often redirects through a
          // callback/return/complete endpoint on a *different* host before the
          // final token response comes back — matching only "tokenize"/"token"
          // missed those, silently leaving capturedCredentials unset.
          const looksRelevant =
            url.includes("smart-glocal") ||
            url.includes("tokenize") ||
            url.includes("token") ||
            url.includes("callback") ||
            url.includes("complete") ||
            url.includes("return") ||
            url.includes("3ds") ||
            url.includes("finish");
          if (!looksRelevant) return;
          const ct: string = response.headers()["content-type"] ?? "";
          if (!ct.includes("application/json")) return;
          const body = await response.json().catch(() => null);
          if (!body) return;
          const token =
            body?.data?.token ??
            body?.token ??
            body?.result?.token ??
            body?.payment_token ??
            body?.credentials;
          if (token) {
            capturedCredentials = JSON.stringify({ type: "card", token });
            logger.info({ url }, "Captured Smart Glocal token via network response");
          }
        } catch (_) {}
      });

      // ── Init script: capture postMessage / Telegram.WebApp.sendData ─────────
      await page.addInitScript(() => {
        const noop = () => {};
        try {
          Object.defineProperty(window, "parent", {
            configurable: true,
            get() { return window; },
          });
        } catch (_) {}
        const captureMessage = (e: MessageEvent) => {
          const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
          if (raw && raw.length > 2) (window as any).__sgMessage = raw;
        };
        window.addEventListener("message", captureMessage);
        // Some 3DS ACS iframes/redirects post to window.top instead of the
        // immediate parent — listen there too so a post-OTP token doesn't
        // silently go uncaptured.
        try {
          if (window.top && window.top !== window) {
            window.top.addEventListener("message", captureMessage as any);
          }
        } catch (_) {}
        (window as any).TelegramGameProxy = {
          receiveEvent(event: string, data: any) {
            (window as any).__sgEvent = JSON.stringify({ event, data });
          },
        };
        (globalThis as any).Telegram = {
          WebApp: {
            initData: "", initDataUnsafe: {}, colorScheme: "light",
            themeParams: {
              bg_color: "#ffffff", text_color: "#000000",
              hint_color: "#999999", link_color: "#2481cc",
              button_color: "#2481cc", button_text_color: "#ffffff",
            },
            isExpanded: true, viewportHeight: 844, viewportStableHeight: 844,
            platform: "android", version: "7.2", isClosingConfirmationEnabled: false,
            MainButton: {
              isVisible: false, isActive: true, text: "CONTINUE",
              color: "#2481cc", textColor: "#ffffff",
              hide: noop, show: noop, setText: noop, enable: noop, disable: noop,
              onClick: noop, offClick: noop, showProgress: noop, hideProgress: noop,
            },
            BackButton: { isVisible: false, onClick: noop, offClick: noop, show: noop, hide: noop },
            HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
            CloudStorage: { setItem: noop, getItem: noop, getItems: noop, removeItem: noop, removeItems: noop, getKeys: noop },
            ready: noop, expand: noop, close: noop,
            sendData(data: string) { (window as any).__sgSendData = data; },
            onEvent: noop, offEvent: noop,
            showAlert: (_: string, cb?: () => void) => { cb?.(); },
            showConfirm: (_: string, cb: (ok: boolean) => void) => { cb(true); },
            showPopup: (_: any, cb?: (id: string) => void) => { cb?.(""); },
            setHeaderColor: noop, setBackgroundColor: noop,
            enableClosingConfirmation: noop, disableClosingConfirmation: noop,
            openLink: noop, openTelegramLink: noop, openInvoice: noop, switchInlineQuery: noop,
          },
        };
      });
    };

    try {
      await launchPage(!!proxyConfig);
    } catch (launchErr: any) {
      // Browser launch itself timed out/failed (e.g. a dead/unresponsive proxy
      // wedging chromium's startup). Unlike the goto-level network-error
      // fallback below, this path previously just aborted the whole flow
      // without ever penalizing the proxy — so a bad IP kept getting
      // re-selected forever. Record the failure and retry once without a
      // proxy before giving up.
      if (proxyConfig) {
        logger.warn(
          { proxyServer: proxyConfig.server, err: (launchErr?.message ?? "").slice(0, 200) },
          "Browser launch failed with proxy — retrying with direct connection",
        );
        if (proxyIpId) await recordProxyIpFailure(proxyIpId).catch(() => {});
        proxyIpId = undefined; // proxy didn't work — don't credit it a success later
        try { await browser?.close(); } catch (_) {}
        browser = null; page = null;
        await launchPage(false); // direct connection, no proxy
      } else {
        throw launchErr;
      }
    }

    const safeUrl = (() => {
      try { const u = new URL(formUrl); return `${u.host}${u.pathname}`; } catch { return "(url parse error)"; }
    })();
    logger.info({ safeUrl }, "Opening payment form in Playwright");

    // ── Navigate — if proxy blocks the site, fall back to a direct connection ──
    try {
      await page.goto(formUrl, { timeout: PLAYWRIGHT_GOTO_TIMEOUT, waitUntil: "domcontentloaded" });
    } catch (gotoErr: any) {
      const msg: string = gotoErr?.message ?? "";
      const isNetErr = /ERR_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_TUNNEL_CONNECTION_FAILED|net::ERR/i.test(msg);
      if (isNetErr && proxyConfig) {
        logger.warn(
          { proxyServer: proxyConfig.server, err: msg.slice(0, 120) },
          "Proxy network error on goto — retrying with direct connection",
        );
        // Record the failure so a persistently dead proxy is auto-retired.
        if (proxyIpId) await recordProxyIpFailure(proxyIpId).catch(() => {});
        proxyIpId = undefined; // proxy didn't work — don't credit it a success later
        try { await browser.close(); } catch (_) {}
        browser = null; page = null;
        await launchPage(false); // direct connection, no proxy
        await page.goto(formUrl, { timeout: PLAYWRIGHT_GOTO_TIMEOUT, waitUntil: "domcontentloaded" });
        logger.info("Direct-connection goto succeeded after proxy failure");
      } else {
        throw gotoErr;
      }
    }

    // Wait for the card-number input to actually appear in the DOM (the Smart
    // Glocal tokenize page is a React SPA — content arrives after JS runs, so
    // a fixed 3 s sleep often races against slow proxy connections or cold
    // browser starts).  Fall back to a 10 s sleep if the selector never shows.
    const CARD_READY_SELECTORS = [
      'input[autocomplete="cc-number"]',
      'input[name="paymentDetails.card.number"]',
      'input[placeholder="1234 5678 1234 5678"]',
    ];
    let formReady = false;
    for (const readySel of CARD_READY_SELECTORS) {
      try {
        await page.waitForSelector(readySel, { state: "visible", timeout: 12000 });
        formReady = true;
        logger.info({ readySel }, "Card form ready (selector visible)");
        break;
      } catch (_) {}
    }
    if (!formReady) {
      logger.warn("Card form selector never appeared — waiting 10 s as fallback");
      await page.waitForTimeout(10000);
    }

    const [expMonth, rawYear] = card.expiry.split("/");
    const cardNum = card.cardNumber.replace(/\s/g, "");
    const expFull = `${expMonth.padStart(2, "0")} / ${rawYear.padStart(2, "0")}`;
    const expShort = `${expMonth.padStart(2, "0")}/${rawYear.padStart(2, "0")}`;
    // Maskito auto-inserts the "/" separator — pass only the 4 digits (MMYY)
    // so pressSequentially doesn't collide with the mask's auto-insert logic.
    const expDigits = `${expMonth.padStart(2, "0")}${rawYear.padStart(2, "0")}`;

    // Save pre-fill screenshot for diagnosis (before any sensitive data is entered)
    await saveFailureScreenshot(page, `${debugLabel}-prefill`);

    // ── Shared error-text detector ────────────────────────────────────────────
    // Used both at the end of the flow (after submit) AND at each early-return
    // point below (no card inputs found / fields unidentified / no submit
    // button) — a page can already be showing a decline/error message before
    // we ever get to clicking anything (e.g. the card was rejected as soon as
    // the form loaded, or a prior attempt's error banner is still visible).
    // Without checking here too, those cases silently returned a generic
    // "technical failure" instead of being flagged as a card decline eligible
    // for the operator's card-retry prompt.
    const ERROR_KEYWORDS = [
      "error", "invalid", "declined", "xato", "insufficient",
      "something went wrong", "try another card", "try a different card",
      "different payment method", "payment failed", "payment was declined",
      "unable to process", "not accepted", "card was declined",
      "unsupported card", "verification failed", "please check your card",
      "card number is not valid", "expired card", "do not honor",
    ];
    const checkForErrorText = async (): Promise<{ isError: boolean; snippet: string }> => {
      const text: string = await page.evaluate(
        () => (globalThis as any).document.body?.innerText ?? ""
      ).catch(() => "");
      const lower = text.toLowerCase();
      const isError = ERROR_KEYWORDS.some((kw) => lower.includes(kw));
      return { isError, snippet: text.slice(0, 200) };
    };

    let filled = false;

    // ── Try Stripe iframes first ──────────────────────────────────────────────
    for (const frameSel of SELECTORS.stripeIframes) {
      try {
        if ((await page.locator(frameSel).count()) === 0) continue;
        const frame = page.frameLocator(frameSel).first();

        const cardInput = frame.locator(SELECTORS.stripeCard).first();
        if (!await cardInput.isVisible({ timeout: 3000 }).catch(() => false)) continue;

        await humanFill(cardInput, cardNum);
        let stripeFieldsFilled = 1;

        const expInput = frame.locator(SELECTORS.stripeExpiry).first();
        if (await expInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await humanFill(expInput, expDigits);
          stripeFieldsFilled++;
        }

        const cvcInput = frame.locator(SELECTORS.stripeCvc).first();
        if (await cvcInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await humanFill(cvcInput, card.cvv);
          stripeFieldsFilled++;
        }

        if (stripeFieldsFilled >= 3) {
          logger.info({ frameSel, stripeFieldsFilled }, "Filled all card fields via Stripe iframe");
          filled = true;
          break;
        }
        logger.warn({ frameSel, stripeFieldsFilled }, "Stripe iframe found but not all fields filled — trying next");
      } catch (_) {}
    }

    // ── Try direct named selectors ────────────────────────────────────────────
    if (!filled) {
      let filledCard = false;
      let filledExp = false;
      let filledCvc = false;

      for (const sel of SELECTORS.cardNumber) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            await humanFill(el, cardNum);
            filledCard = true;
            logger.info({ sel }, "Filled card number");
            break;
          }
        } catch (_) {}
      }

      for (const sel of SELECTORS.expiry) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            await humanFill(el, expDigits);
            filledExp = true;
            logger.info({ sel }, "Filled expiry");
            break;
          }
        } catch (_) {}
      }

      for (const sel of SELECTORS.cvc) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            await humanFill(el, card.cvv);
            filledCvc = true;
            logger.info({ sel }, "Filled CVC");
            break;
          }
        } catch (_) {}
      }

      for (const sel of SELECTORS.holder) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            await humanFill(el, card.cardHolder);
            logger.info({ sel }, "Filled card holder");
            break;
          }
        } catch (_) {}
      }

      if (filledCard && filledExp && filledCvc) {
        filled = true;
        logger.info("Filled all 3 required card fields via direct selectors");
      } else {
        logger.warn({ filledCard, filledExp, filledCvc }, "Direct selector fill incomplete");
      }
    }

    // ── Fallback: attribute-pattern scan of all visible inputs ─────────────────
    if (!filled) {
      const allInputs = await page.locator('input[type="text"], input[type="number"], input[type="tel"], input:not([type])').all();

      if (allInputs.length === 0) {
        const { isError, snippet } = await checkForErrorText();
        if (isError) {
          logger.warn({ snippet }, "No card inputs found — page already shows an error/decline message");
          return { submitted: false, cardBlocked: true };
        }
        logger.warn("No card inputs found on page — check pre-fill screenshot");
        await logVisibleHtml(page);
        return { submitted: false };
      }

      let filledCard = false;
      let filledExp = false;
      let filledCvc = false;

      for (const input of allInputs as any[]) {
        const attrs = {
          name: (await input.getAttribute("name")) ?? "",
          placeholder: (await input.getAttribute("placeholder")) ?? "",
          autocomplete: (await input.getAttribute("autocomplete")) ?? "",
          id: (await input.getAttribute("id")) ?? "",
          dataField: (await input.getAttribute("data-field")) ?? "",
        };
        const combined = Object.values(attrs).join(" ").toLowerCase();

        try {
          if (!filledCard && /card.?num|cardnum|cc.?num|pan/.test(combined)) {
            await humanFill(input, cardNum); filledCard = true;
          } else if (!filledExp && /exp|cc.?exp|muddat/.test(combined)) {
            await humanFill(input, expDigits); filledExp = true;
          } else if (!filledCvc && /cvc|cvv|csc|security/.test(combined)) {
            await humanFill(input, card.cvv); filledCvc = true;
          } else if (/holder|owner|name|ism/.test(combined)) {
            await humanFill(input, card.cardHolder);
          }
        } catch (_) {}
      }

      if (filledCard && filledExp && filledCvc) {
        filled = true;
        logger.info("Filled all 3 required card fields via attribute-pattern scan");
      } else {
        const { isError, snippet } = await checkForErrorText();
        if (isError) {
          logger.warn({ snippet, filledCard, filledExp, filledCvc }, "Could not identify all card fields — page already shows an error/decline message");
          return { submitted: false, cardBlocked: true };
        }
        logger.warn({ filledCard, filledExp, filledCvc, inputCount: allInputs.length },
          "Could not identify all card fields — check pre-fill screenshot and HTML");
        await logVisibleHtml(page);
        return { submitted: false };
      }
    }

    // ── Click Pay/Submit button ───────────────────────────────────────────────
    let clicked = false;
    for (const sel of SELECTORS.payButton) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          await el.click();
          clicked = true;
          logger.info({ sel }, "Clicked pay button");
          break;
        }
      } catch (_) {}
    }

    if (!clicked) {
      logger.warn("No pay button matched — trying last visible button");
      const lastBtn = page.locator("button").last();
      if (await lastBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await lastBtn.click();
        clicked = true;
        logger.info("Clicked last button as fallback");
      }
    }

    if (!clicked) {
      const { isError, snippet } = await checkForErrorText();
      if (isError) {
        logger.warn({ snippet }, "Could not find any submit button — page already shows an error/decline message");
        return { submitted: false, cardBlocked: true };
      }
      logger.warn("Could not find any submit button");
      await saveFailureScreenshot(page, debugLabel);
      return { submitted: false };
    }

    // ── Handle 3DS OTP if the bank requires it ────────────────────────────────
    // After clicking pay, some banks redirect to a 3DS page asking for an SMS
    // code.  If askOtp is provided, wait for the OTP input to appear (up to
    // 10 s), request the code from the operator, fill it and continue.
    let otpHandled = false;
    if (askOtp) {
      otpHandled = await handle3dsOtpIfNeeded(page, askOtp, debugLabel);
      if (otpHandled) {
        logger.info("3DS OTP step completed — waiting for final credential capture");
        // Give the page extra time to process after OTP submission — the ACS
        // redirect chain back to the merchant page is often slower than the
        // plain (non-3DS) tokenize response.
        await page.waitForTimeout(5000);
      }
    }

    // ── Wait for credential capture (longer when 3DS involved) ────────────────
    // Smart Glocal sends credentials via:
    //   a) window.__sgSendData  (Telegram.WebApp.sendData)
    //   b) window.__sgMessage   (postMessage to parent/top)
    //   c) window.__sgEvent     (TelegramGameProxy.receiveEvent)
    //   d) network response     (capturedCredentials set above)
    // After a 3DS OTP round-trip the redirect chain is slower, so double the
    // poll budget (30s vs 15s) instead of giving up on the same fixed window.
    const captureAttempts = otpHandled ? 60 : 30;
    for (let i = 0; i < captureAttempts; i++) {
      await page.waitForTimeout(500);

      const sgData: string | null = await page.evaluate(() => {
        return (
          (window as any).__sgSendData ??
          (window as any).__sgMessage ??
          (window as any).__sgEvent ??
          null
        );
      }).catch(() => null);

      if (sgData) {
        capturedCredentials = sgData;
        logger.info("Captured credentials via browser event");
        break;
      }

      if (capturedCredentials) break;
    }

    if (capturedCredentials) {
      logger.info("Card tokenization complete — credentials captured");
      return { submitted: true, credentials: capturedCredentials, proxyIpId };
    }

    // ── Fallback: check if card inputs disappeared (form processed) ───────────
    const cardInputGone = !(await page.locator('input[autocomplete="cc-number"]').isVisible({ timeout: 500 }).catch(() => false));
    if (cardInputGone) {
      logger.info("Card input gone after submit — form processed (no explicit credentials captured)");
      return { submitted: true, proxyIpId };
    }

    // Check for error text
    {
      const { isError, snippet } = await checkForErrorText();
      if (isError) {
        // Distinguish this from a technical fill/submit failure: the page loaded
        // and processed the card, then explicitly rejected it (often an
        // anti-fraud block on this card/IP combo). Swapping to a different
        // saved card can fix this even though it can't fix a technical failure.
        logger.warn({ snippet }, "Error text found after submit — likely card/anti-fraud decline");
        return { submitted: false, cardBlocked: true, proxyIpId };
      }
    }

    // Ambiguous — allow SendPaymentForm attempt
    logger.warn("Could not capture credentials — will try SendPaymentForm without explicit token");
    return { submitted: true, proxyIpId };

  } catch (err) {
    if (watchdogFired) {
      logger.error({ debugLabel }, "payPremiumViaWebApp aborted by watchdog (card step exceeded time budget)");
    } else {
      logger.error({ err }, "payPremiumViaWebApp error");
      // Screenshot only while the browser is still alive — after a watchdog kill
      // the page is gone and page.screenshot() would itself hang.
      if (page) await saveFailureScreenshot(page, debugLabel).catch(() => {});
    }
    return { submitted: false };
  } finally {
    // Cancel the watchdog first so it doesn't fire again after we've cleaned up.
    clearTimeout(watchdog);
    // Guaranteed browser teardown: bound close + hard-kill so a wedged chromium
    // can never leak. Skip if watchdog already closed it (browser set to null).
    if (browser) {
      const b = browser;
      browser = null;
      try {
        await withTimeout(b.close(), BROWSER_CLOSE_TIMEOUT_MS, "browser.close");
      } catch (_) {
        try { b.process()?.kill("SIGKILL"); } catch (_) {}
      }
    }
    // Release the semaphore slot. releaseSlotOnce is idempotent — safe to call
    // even when the watchdog already released it (prevents double-release bug).
    releaseSlotOnce();
    // Free the proxy for future selection now that this attempt is fully done
    // (see _proxyInFlight in getProxyConfig).
    releaseProxyIpReservation(reservedProxyIpId);
  }
}

// ── Step 5: Send payment form via MTProto ─────────────────────────────────────

export interface SendPaymentResult {
  success: boolean;
  /** Present when Telegram returns PaymentVerificationNeeded — bank 3DS URL */
  verificationUrl?: string;
  /** Telegram RPC error code (e.g. "PAYMENT_FAILED") when success is false */
  errorCode?: string;
}

/**
 * Calls payments.SendPaymentForm with the credentials obtained from the
 * tokenization page. This is what actually charges the card via Telegram.
 *
 * Returns { success: true } on PaymentResult (done).
 * Returns { success: true, verificationUrl } on PaymentVerificationNeeded
 *   — caller must open the URL for the admin to complete 3DS.
 * Returns { success: false } on RPC error.
 */
export async function sendPaymentFormToTelegram(
  client: TelegramClient,
  botUsername: string,
  invoiceMsg: any,
  formId: bigint,
  credentials?: string,
): Promise<SendPaymentResult> {
  try {
    const peer = await client.getInputEntity(botUsername);

    let credentialsInput: any;

    if (credentials) {
      let credData: string;
      try {
        const parsed = JSON.parse(credentials);
        if (parsed?.data?.credentials) {
          credData = JSON.stringify(parsed.data.credentials);
        } else if (parsed?.credentials) {
          credData = JSON.stringify(parsed.credentials);
        } else {
          credData = credentials;
        }
      } catch {
        credData = credentials;
      }

      credentialsInput = new Api.InputPaymentCredentials({
        save: false,
        data: new Api.DataJSON({ data: credData }),
      });
      logger.info("Sending payment form with captured credentials");
    } else {
      credentialsInput = new Api.InputPaymentCredentials({
        save: false,
        data: new Api.DataJSON({ data: "{}" }),
      });
      logger.warn("Sending payment form with empty credentials (no token captured)");
    }

    const result = await client.invoke(
      new Api.payments.SendPaymentForm({
        invoice: new Api.InputInvoiceMessage({
          peer: peer as any,
          msgId: invoiceMsg.id,
        }),
        formId: formId as any,
        credentials: credentialsInput,
      }),
    );

    const className: string = (result as any).className ?? "";
    logger.info({ resultClass: className }, "payments.SendPaymentForm result");

    if (className === "payments.PaymentVerificationNeeded") {
      // Telegram may return the URL with HTML-encoded ampersands (&amp;).
      // Decode them so the URL is valid when opened in a browser.
      const rawUrl: string | undefined = (result as any).url;
      const verificationUrl = rawUrl?.replace(/&amp;/g, "&");
      logger.info({ verificationUrl }, "3DS verification required — URL extracted");
      return { success: true, verificationUrl };
    }

    return { success: true };
  } catch (err: any) {
    logger.error({ err }, "sendPaymentFormToTelegram error");
    return { success: false, errorCode: err?.errorMessage ?? undefined };
  }
}

// ── Step 6: Wait for premiumbot receipt message ───────────────────────────────

/**
 * After SendPaymentForm succeeds, premiumbot sends a receipt/confirmation
 * message. We wait for it as the authoritative success signal.
 *
 * Returns the confirmation message, or null on timeout.
 */
export async function waitForPremiumReceipt(
  client: TelegramClient,
  botUsername: string,
  timeoutMs = 30000,
): Promise<any | null> {
  const receiptKeywords = [
    "premium", "obuna", "faollashtirildi", "activated", "subscription",
    "receipt", "payment", "to'lov", "confirmed", "muvaffaqiyat",
    "✅", "⭐", "🎉",
  ];

  logger.info({ botUsername, timeoutMs }, "Waiting for premium receipt from bot");

  const msg = await waitForBotMsg(
    client,
    botUsername,
    (m) => {
      const text: string = (m.text ?? m.message ?? "").toLowerCase();
      return receiptKeywords.some((kw) => text.includes(kw.toLowerCase()));
    },
    timeoutMs,
  );

  if (msg) {
    logger.info({ text: (msg.text ?? msg.message ?? "").slice(0, 150) }, "Received premium receipt message");
  } else {
    logger.warn({ botUsername }, "No receipt message received within timeout");
  }

  return msg;
}

// ── Step 7: Cancel auto-renewal (proper button clicks) ───────────────────────

/**
 * Cancel auto-renewal flow:
 *  1. Send /stop to premiumbot
 *  2. Wait for the bot to respond with a menu
 *  3. Click the FIRST button on that menu
 *  4. Wait for the next menu
 *  5. Click the FIRST button on that menu
 *
 * Per direct confirmation from the operator, @premiumbot shows two keyboards
 * in a row here and the correct choice on each is always the first option —
 * so we always click position 0 rather than trying to match button text by
 * keyword (wording can vary/change, position doesn't). There is no
 * text-based fallback: @premiumbot only reacts to real callback-button
 * clicks here, so sending literal text was never effective and is not used.
 */
export interface CancelAutoRenewalResult {
  /** True only if we confirmed a button-driven path through /stop → confirm → reason. */
  success: boolean;
  /** Human-readable reason, surfaced to the operator regardless of success/failure. */
  reason: string;
}

export async function cancelPremiumAutoRenewal(
  client: TelegramClient,
  botUsername: string,
): Promise<CancelAutoRenewalResult> {
  try {
    logger.info({ botUsername }, "Cancelling auto-renewal: sending /stop");

    // ── Send /stop and wait for bot response ──────────────────────────────────
    const stopReplyPromise = waitForBotMsg(client, botUsername, () => true, 15000);
    await client.sendMessage(botUsername, { message: "/stop" });
    logger.info({ botUsername }, "Sent /stop");

    const stopReply = await stopReplyPromise;
    if (!stopReply) {
      logger.warn({ botUsername }, "No response to /stop — auto-renewal may not be cancelled");
      return { success: false, reason: "/stop ga javob kelmadi — obuna bekor qilinmagan bo'lishi mumkin" };
    }

    const stopText: string = (stopReply.text ?? stopReply.message ?? "").slice(0, 100);
    logger.info({ stopText }, "Got /stop response");

    // ── Click the FIRST button on the /stop reply keyboard ────────────────────
    const stopBtn = getFirstButton(stopReply);
    const peer = await client.getInputEntity(botUsername);

    if (stopBtn) {
      // Wait 5s before clicking — mirrors a human reading the message instead
      // of instantly tapping, and gives @premiumbot's keyboard time to settle.
      await delay(5000);
      const confirmPromise = waitForBotMsg(client, botUsername, () => true, 15000);
      await pressButton(client, peer, stopReply.id, stopBtn);
      logger.info({ kind: stopBtn.kind }, "Clicked stop-confirm button");

      // ── Wait for the second (reason) menu, click its (single) button ─────────
      const reasonReply = await confirmPromise;
      if (!reasonReply) {
        logger.warn("No reason menu received after stop confirm");
        return { success: false, reason: "Stop tasdiqlandi, lekin sabab menyusi kelmadi — holat noaniq" };
      }

      const reasonText: string = (reasonReply.text ?? reasonReply.message ?? "").slice(0, 100);
      logger.info({ reasonText }, "Got reason menu");

      // ── Click the FIRST button on the reason keyboard ───────────────────────
      const reasonBtn = getFirstButton(reasonReply);

      if (reasonBtn) {
        await delay(5000);
        await pressButton(client, peer, reasonReply.id, reasonBtn);
        logger.info({ kind: reasonBtn.kind }, "Clicked reason button");
        return { success: true, reason: "Tugmalar orqali muvaffaqiyatli bekor qilindi" };
      }

      logger.warn("Reason menu had no clickable button at all — cannot confirm cancellation");
      return {
        success: false,
        reason: "Sabab menyusida bosiladigan tugma topilmadi — bekor qilinishi tasdiqlanmadi",
      };
    } else {
      logger.warn("/stop reply had no clickable button at all — cannot confirm cancellation");
      return {
        success: false,
        reason: "/stop javobida bosiladigan tugma topilmadi — bekor qilinishi tasdiqlanmadi",
      };
    }
  } catch (err: any) {
    logger.error({ err }, "cancelPremiumAutoRenewal error");
    return { success: false, reason: `Xato: ${err?.message ?? "noma'lum"}` };
  }
}

type FirstButton =
  | { kind: "callback"; data: Buffer }
  | { kind: "text"; text: string };

/**
 * Returns the first clickable button found on a message, regardless of its
 * text. Handles BOTH keyboard types @premiumbot may send:
 *  - Inline keyboard (Api.ReplyInlineMarkup) — buttons carry `.data` and are
 *    "clicked" via messages.GetBotCallbackAnswer.
 *  - Custom reply keyboard (Api.ReplyKeyboardMarkup) — plain KeyboardButtons
 *    with only `.text`, shown as an overlay above the input box. Tapping one
 *    of these just sends its label back to the bot as an ordinary message;
 *    there is no callback data at all. The /stop confirm + reason menus turned
 *    out to be this type, which is why the previous callback-only lookup
 *    always came back empty and the flow silently stopped after /stop.
 */
function getFirstButton(msg: any): FirstButton | null {
  const markup = msg.replyMarkup;
  if (!markup?.rows) return null;

  for (const row of markup.rows) {
    for (const btn of (row.buttons ?? [])) {
      const data = (btn as any).data;
      if (data) {
        logger.info({ btnText: (btn as any).text }, "Using first available button (callback)");
        return { kind: "callback", data: Buffer.from(data) };
      }
      const text = (btn as any).text;
      if (text) {
        logger.info({ btnText: text }, "Using first available button (reply-keyboard text)");
        return { kind: "text", text };
      }
    }
  }
  return null;
}

async function pressButton(
  client: TelegramClient,
  peer: any,
  msgId: number,
  btn: FirstButton,
): Promise<void> {
  if (btn.kind === "callback") {
    await client.invoke(
      new Api.messages.GetBotCallbackAnswer({ peer, msgId, data: btn.data }),
    );
  } else {
    // Reply-keyboard button — tapping it just sends its label text to the bot.
    await client.sendMessage(peer, { message: btn.text });
  }
}

// ── Step 7b: Verify premium directly via @PremiumBot ─────────────────────────

/**
 * Checks premium status by sending /start to @PremiumBot and reading its
 * response. If the bot shows "Your Telegram Premium Plan" the account is
 * confirmed premium. Falls back gracefully on any error.
 */
export async function checkPremiumWithPremiumBot(
  client: TelegramClient,
  premiumBotUsername: string,
): Promise<{ hasPremium: boolean; expiresAt?: Date; rawText: string }> {
  try {
    // Wait briefly so any queued messages from the cancel flow (step 6) settle
    // before we send /start and listen for the fresh response.
    await delay(2000);
    const msgPromise = waitForBotMsg(client, premiumBotUsername, () => true, 20000);
    await client.sendMessage(premiumBotUsername, { message: "/start" });

    const msg = await msgPromise;
    if (!msg) {
      logger.warn({ premiumBotUsername }, "No response from PremiumBot on /start for verification");
      return { hasPremium: false, rawText: "" };
    }

    const text: string = msg.message ?? msg.text ?? "";
    logger.info({ text: text.slice(0, 200) }, "PremiumBot verification response");

    // @PremiumBot shows "Your Telegram Premium Plan" for an active plan, but
    // once /stop is used it switches to "You have an active Telegram Premium
    // subscription... Recurring payments have been stopped" — still active
    // premium, just non-renewing. Confirmed live: after a successful /stop,
    // @PremiumBot returned exactly this wording and the old check (missing
    // this signature) reported hasPremium=false for a still-active account.
    const lower = text.toLowerCase();
    const hasPremium =
      lower.includes("your telegram premium plan") ||
      lower.includes("premium plan") ||
      lower.includes("you have an active") ||
      (lower.includes("premium") && (lower.includes("next payment") || lower.includes("recurring payments have been stopped")));

    let expiresAt: Date | undefined;
    // "Next payment: 35 990,00 UZS on 10 Aug 2026"
    const onDateMatch = text.match(/on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
    const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    const dotMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);

    if (onDateMatch) {
      const d = new Date(`${onDateMatch[2]} ${onDateMatch[1]} ${onDateMatch[3]}`);
      if (!isNaN(d.getTime())) expiresAt = d;
    } else if (isoMatch) {
      const d = new Date(isoMatch[1]);
      if (!isNaN(d.getTime())) expiresAt = d;
    } else if (dotMatch) {
      const d = new Date(`${dotMatch[3]}-${dotMatch[2].padStart(2, "0")}-${dotMatch[1].padStart(2, "0")}`);
      if (!isNaN(d.getTime())) expiresAt = d;
    } else if (hasPremium) {
      expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    }

    return { hasPremium, expiresAt, rawText: text };
  } catch (err) {
    logger.error({ err }, "checkPremiumWithPremiumBot error");
    return { hasPremium: false, rawText: "" };
  }
}

// ── Step 8: Verify premium on verifier bot ────────────────────────────────────

// Batch runs share ONE masterClient per operator (getMasterClient caches by
// operatorId) across up to BATCH_CONCURRENCY concurrent phone flows. Step 8
// of each flow calls checkPremiumWithRepream on that SAME client/chat with
// @RePreAmooBot at the same time. Its message listeners only filter by bot
// username, not by which phone's check they belong to — with two calls in
// flight at once, phone A's listener can catch phone B's reply (or vice
// versa), reporting a false "not confirmed" for whichever call loses the
// race. This queue serializes all checkPremiumWithRepream calls per client
// so only one conversation with the source bot happens at a time; the rest
// wait their turn instead of racing on the same event stream.
const _repreamCheckQueues = new WeakMap<TelegramClient, Promise<any>>();

export function checkPremiumWithRepream(
  client: TelegramClient,
  repreamBotUsername: string,
  existingMsgId?: number,
): Promise<{ hasPremium: boolean; expiresAt?: Date; rawText: string }> {
  const prev = _repreamCheckQueues.get(client) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => _checkPremiumWithRepreamImpl(client, repreamBotUsername, existingMsgId));
  // Store a settle-safe tail so the next queued call always proceeds even if
  // this one throws/rejects.
  _repreamCheckQueues.set(client, next.catch(() => {}));
  return next;
}

async function _checkPremiumWithRepreamImpl(
  client: TelegramClient,
  repreamBotUsername: string,
  /**
   * If provided, skip /start and instead fetch this specific message from the
   * provider bot (the original number-issue message) to find the Check Premium button.
   */
  existingMsgId?: number,
): Promise<{ hasPremium: boolean; expiresAt?: Date; rawText: string }> {
  try {
    let startMsg: any;

    if (existingMsgId) {
      // Fetch the original message directly — no /start needed
      logger.info({ repreamBotUsername, existingMsgId }, "Fetching original provider bot message for premium check");
      const msgs = await client.getMessages(repreamBotUsername, { ids: [existingMsgId] });
      startMsg = msgs?.[0] ?? null;
      if (!startMsg) {
        logger.warn({ repreamBotUsername, existingMsgId }, "Original message not found — falling back to /start");
      }
    }

    if (!startMsg) {
      // Fallback: send /start and wait for response
      const msgPromise = waitForBotMsg(client, repreamBotUsername, () => true, 30000);
      await client.sendMessage(repreamBotUsername, { message: "/start" });
      startMsg = await msgPromise;
      if (!startMsg) {
        logger.warn({ repreamBotUsername }, "No response from verifier bot after /start");
        return { hasPremium: false, rawText: "" };
      }
    }

    const markup = startMsg.replyMarkup;
    let checkPremiumData: Buffer | null = null;
    let checkPremiumMsgId: number | null = null;

    if (markup?.rows) {
      outerLoop:
      for (const row of markup.rows) {
        for (const btn of (row.buttons ?? [])) {
          const btnText: string = ((btn as any).text ?? "").toLowerCase();
          if (
            btnText.includes("premium") ||
            btnText.includes("check") ||
            btnText.includes("tekshir")
          ) {
            const data = (btn as any).data;
            if (data) {
              checkPremiumData = Buffer.from(data);
              checkPremiumMsgId = startMsg.id;
              logger.info({ btnText, msgId: checkPremiumMsgId }, "Found check premium button in verifier bot");
              break outerLoop;
            }
          }
        }
      }
    }

    if (!checkPremiumData || !checkPremiumMsgId) {
      const text: string = startMsg.text ?? startMsg.message ?? "";
      logger.info({ text: text.slice(0, 200) }, "No check button — reading response text directly");
      return parsePremiumResponse(text);
    }

    // Build a cancellable listener for the verifier bot's response.
    // The bot may reply via a new message OR by editing the original one —
    // we handle both so we never miss a fast response.
    const { promise: textPromise, cancel: cancelListener } =
      (() => {
        let settled = false;
        let newH: (e: NewMessageEvent) => Promise<void>;
        let editH: (e: EditedMessageEvent) => Promise<void>;
        const newF  = new NewMessage({ fromUsers: [repreamBotUsername] });
        const editF = new EditedMessage({ fromUsers: [repreamBotUsername] });
        let resolvePromise: (v: string | null) => void;

        const settle = (text: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { client.removeEventHandler(newH,  newF);  } catch (_) {}
          try { client.removeEventHandler(editH, editF); } catch (_) {}
          resolvePromise(text);
        };

        const timer = setTimeout(() => settle(null), 30000);

        newH = async (e: NewMessageEvent) => {
          const t: string = e.message.text ?? e.message.message ?? "";
          if (t) settle(t);
        };
        editH = async (e: EditedMessageEvent) => {
          const t: string = e.message.text ?? e.message.message ?? "";
          if (t) settle(t);
        };

        client.addEventHandler(newH,  newF);
        client.addEventHandler(editH, editF);

        return {
          promise: new Promise<string | null>((res) => { resolvePromise = res; }),
          cancel: () => settle(null),
        };
      })();

    let callbackText = "";
    try {
      const peer = await Promise.race([
        client.getInputEntity(repreamBotUsername),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("getInputEntity timeout")), 10_000),
        ),
      ]);
      const callbackAnswer = await Promise.race([
        client.invoke(
          new Api.messages.GetBotCallbackAnswer({
            peer,
            msgId: checkPremiumMsgId,
            data: checkPremiumData,
          }),
        ) as Promise<{ message?: string }>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("GetBotCallbackAnswer timeout (20s)")), 20_000),
        ),
      ]);

      // Fast path: some bots return the premium status directly in the callback
      // answer popup (the `message` field of BotCallbackAnswer).
      callbackText = callbackAnswer?.message ?? "";
    } catch (invokeErr) {
      cancelListener();
      throw invokeErr;
    }

    if (callbackText) {
      cancelListener();
      logger.info({ callbackText: callbackText.slice(0, 200) }, "Verifier bot: callback answer text");
      return parsePremiumResponse(callbackText);
    }

    // Slow path: wait for the new/edited message we set up above.
    const resultText = await textPromise;
    if (!resultText) {
      logger.warn({ repreamBotUsername }, "No response after clicking check premium button");
      return { hasPremium: false, rawText: "" };
    }

    logger.info({ resultText: resultText.slice(0, 200) }, "Verifier bot response");
    return parsePremiumResponse(resultText);
  } catch (err) {
    logger.error({ err }, "checkPremiumWithRepream error");
    return { hasPremium: false, rawText: "" };
  }
}

function parsePremiumResponse(text: string): {
  hasPremium: boolean;
  expiresAt?: Date;
  rawText: string;
} {
  const lower = text.toLowerCase();

  // ── 1. Parse expiry date (all formats) ───────────────────────────────────────
  let expiresAt: Date | undefined;
  const isoMatch   = text.match(/(\d{4}-\d{2}-\d{2})/);
  const dotMatch   = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);

  if (isoMatch) {
    const d = new Date(isoMatch[1]);
    if (!isNaN(d.getTime())) expiresAt = d;
  } else if (dotMatch) {
    const d = new Date(`${dotMatch[3]}-${dotMatch[2].padStart(2, "0")}-${dotMatch[1].padStart(2, "0")}`);
    if (!isNaN(d.getTime())) expiresAt = d;
  } else if (slashMatch) {
    const d = new Date(`${slashMatch[3]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[1].padStart(2, "0")}`);
    if (!isNaN(d.getTime())) expiresAt = d;
  }

  // ── 2. Definitive negative signals — always means no premium ─────────────────
  const negativeSignals = [
    "not premium", "no premium",
    "premium yo'q", "premium mavjud emas", "premium topilmadi",
    "premium bekor", "premium muddati tugagan", "premium expired",
    "premium inactive", "premium faol emas",
    "не premium", "нет premium",
    "premium: yo'q", "premium: no", "premium: false",
    "standard account", "free account",
  ];
  if (negativeSignals.some((s) => lower.includes(s))) {
    return { hasPremium: false, expiresAt: undefined, rawText: text };
  }

  // ── 3. Positive signals — require an explicit affirmation ────────────────────
  // An expiry date in the message is the strongest signal of active premium.
  const hasDate = Boolean(expiresAt);

  // Explicit active keywords
  const positiveSignals = [
    "premium faol", "premium: faol", "premium: ha",
    "premium active", "premium: active", "premium activated",
    "premium status: active", "premium: yes", "premium: true",
    "✅ premium", "⭐ premium", "premium ✅", "premium ⭐",
    "premium: ✅", "premium: ⭐",
    "obuna faol", "obuna aktiv",
    "subscription active", "subscription: active",
    "premium включён", "premium активен",
  ];
  const hasPositiveKeyword = positiveSignals.some((s) => lower.includes(s));

  // A date alongside "premium" (without negative signals above) is a strong
  // implicit signal the bot is reporting an active expiry.
  const hasPremium = hasDate
    ? lower.includes("premium")
    : hasPositiveKeyword;

  // Only set fallback expiry when premium is confirmed but date wasn't parsed
  if (hasPremium && !expiresAt) {
    expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  return { hasPremium, expiresAt, rawText: text };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const PREMIUM_CHECK_MAX_ATTEMPTS = 4;
const PREMIUM_CHECK_RETRY_DELAY_MS = 15000;

/**
 * Thrown by `onStep6` when the operator presses "Evro ekan" — the entire flow
 * should restart from step 1.
 */
export class FlowRestartError extends Error {
  constructor() { super("flow_restart"); }
}

/**
 * Thrown by `onStep6` when the operator presses "Bekor qilish" — abort.
 */
export class FlowAbortError extends Error {
  constructor() { super("flow_abort"); }
}

/**
 * Thrown by `onStep6` when neither the operator's button press nor the
 * auto-detect `/start` poll confirmed Premium within the poll window. The
 * flow is treated as an automatic failure (not a silent freeze, and not a
 * false "success") — distinct from FlowAbortError so the operator sees a
 * clear "auto-timeout" message instead of "operator bekor qildi".
 */
export class FlowStep6TimeoutError extends Error {
  constructor() { super("flow_step6_timeout"); }
}

/**
 * Full premium purchase flow:
 *   Steps 1-6 → @premiumBotUsername (premiumbot) — invoice, terms, Smart Glocal
 *               form fill via Playwright (+ Playwright 3DS OTP if detected),
 *               SendPaymentForm, cancel auto-renewal.
 *   Step 7    → @repreamBotUsername — verify premium is active.
 *
 * If SendPaymentForm returns PaymentVerificationNeeded (bank 3DS required),
 * `onVerificationNeeded(url)` is called. The caller should show the URL to the
 * admin and wait until they complete 3DS, then resolve the returned promise.
 */
export async function runFullPremiumFlow(
  client: TelegramClient,
  premiumBotUsername: string,
  repreamBotUsername: string,
  card?: PremiumCardData,
  onProgress?: (msg: string) => Promise<void>,
  /**
   * Called when the bank's Playwright 3DS page requests an SMS OTP code.
   * Should prompt the operator for the code and return it (or null on timeout).
   */
  onAskOtp?: () => Promise<string | null>,
  /**
   * Called when Telegram returns PaymentVerificationNeeded (bank 3DS URL).
   * Receives the URL the admin must open to complete verification.
   * Should resolve after the admin confirms they have completed 3DS.
   */
  onVerificationNeeded?: (url: string) => Promise<void>,
  /**
   * If the phone number was obtained from a provider bot (e.g. @RePreAmooBot),
   * pass the original message ID so the verify step clicks "Check Premium" in
   * that exact message instead of sending /start afresh.
   */
  repreamMsgId?: number,
  /**
   * Called just before step 6 (cancel auto-renewal).
   * Should resolve to 'continue' (proceed), throw FlowRestartError (restart from
   * step 1), or throw FlowAbortError (stop entirely).
   * If not provided, step 6 runs unconditionally.
   */
  onStep6?: () => Promise<void>,
  /**
   * Operator's master Telegram client — used in step 8 to check premium via
   * @RePreAmooBot after the userbot has logged out (step 7).
   * If not provided, premium confirmation is skipped.
   */
  masterClient?: TelegramClient,
  /**
   * Called right after step 4 (card tokenized) completes, before step 5
   * (SendPaymentForm) begins. Used by the batch-relay scheduler to pace
   * staggered sessions (e.g. a flat delay) without touching this function's
   * own step sequencing.
   */
  onBeforeStep5?: () => Promise<void>,
): Promise<PremiumFlowResult> {
  const progress = async (msg: string) => {
    logger.info(msg);
    if (onProgress) await onProgress(msg).catch(() => {});
  };

  if (!card) {
    return { success: false, hasPremium: false, message: "Karta saqlanmagan" };
  }

  // ── Steps 7-8 shared helper: log out, then verify via the manba/source bot ──
  // (@RePreAmooBot) using the operator's master client. Extracted so the
  // "already has Premium" early-exit path (Step 1) still goes through a real
  // Check Premium confirmation instead of trusting @PremiumBot's own text.
  const logoutAndVerify = async (
    maxAttemptsOverride?: number,
    autoRenewalCancelled?: boolean,
  ): Promise<PremiumFlowResult> => {
    await progress(`7️⃣ Telegram akkauntdan chiqilmoqda...`);
    try {
      await client.invoke(new Api.auth.LogOut());
      logger.info("Step 7: auth.LogOut successful");
    } catch (e) {
      logger.warn({ e }, "Step 7: auth.LogOut failed — session may already be invalid");
    }

    // ── Step 8: Verify premium via @RePreAmooBot using master client ──────────
    // The userbot is now logged out, so we must use the operator's master client.
    let verification: { hasPremium: boolean; expiresAt?: Date; rawText: string } = {
      hasPremium: false,
      rawText: "",
    };

    const maxAttempts = maxAttemptsOverride ?? PREMIUM_CHECK_MAX_ATTEMPTS;
    if (masterClient) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt === 0) {
          await progress(`8️⃣ @${repreamBotUsername} orqali premium tekshirilmoqda...`);
          await delay(5000);
        } else {
          await progress(
            `🔄 Premium hali faol emas — ${attempt}/${maxAttempts}-urinish (${PREMIUM_CHECK_RETRY_DELAY_MS / 1000}s)...`,
          );
          await delay(PREMIUM_CHECK_RETRY_DELAY_MS);
        }

        const check = await checkPremiumWithRepream(masterClient, repreamBotUsername, repreamMsgId);
        if (check.hasPremium) {
          verification = check;
          logger.info({ attempt }, "Step 8: premium confirmed via RePreAmooBot");
          break;
        }
        logger.info({ attempt, rawText: check.rawText.slice(0, 80) }, "Step 8: premium not yet active");
        if (attempt === maxAttempts - 1) {
          await progress(
            `❌ ${maxAttempts} urinishdan keyin premium tasdiqlanmadi — @${repreamBotUsername} javob: "${check.rawText.slice(0, 120) || "bo'sh"}"`,
          );
        }
      }
    } else {
      logger.warn("Step 8: no masterClient provided — skipping repream premium check");
      await progress(`⚠️ Master client yo'q — premium tasdiqlanmadi`);
    }

    return {
      success: true,
      hasPremium: verification.hasPremium,
      premiumExpiresAt: verification.expiresAt,
      message: verification.hasPremium
        ? `⭐ Premium faollashtirildi${verification.expiresAt ? ` (muddat: ${verification.expiresAt.toLocaleDateString("uz")})` : ""}`
        : `⚠️ @${repreamBotUsername} (manba bot) premium holatini tasdiqlamadi`,
      autoRenewalCancelled,
    };
  };

  // ── Step 1: Send /start → get invoice ────────────────────────────────────────
  await progress(`1️⃣ @${premiumBotUsername} ga /start yuborilmoqda...`);
  const { invoice: invoiceMsg, firstMsgText } = await getInvoiceFromPremiumBot(client, premiumBotUsername);
  if (!invoiceMsg) {
    if (firstMsgText === null) {
      // Bot umuman javob bermadi — xato, premium tekshirishga o'tish noto'g'ri
      return {
        success: false,
        hasPremium: false,
        message: `@${premiumBotUsername} javob bermadi (30s timeout) — tarmoq yoki sessiya muammosi`,
      };
    }
    // Bot birinchi xabar yubordi lekin invoice kelmadi — "allaqachon premium" bo'lishi mumkin
    const lower = firstMsgText.toLowerCase();
    const looksAlreadyActive =
      lower.includes("your telegram premium plan") ||
      lower.includes("you have an active") ||
      lower.includes("premium plan") ||
      (lower.includes("premium") && lower.includes("next payment"));
    if (!looksAlreadyActive) {
      // Noma'lum xabar — invoice kutilayotgan edi, kelmadi
      await progress(
        `⚠️ @${premiumBotUsername} invoice bermadi. Xabar: "${firstMsgText.slice(0, 100)}"`,
      );
      return {
        success: false,
        hasPremium: false,
        message: `@${premiumBotUsername} invoice bermadi — kutilmagan xabar: "${firstMsgText.slice(0, 120)}"`,
      };
    }
    // "Already active" xabari — to'lov shart emas, repream orqali tekshiramiz
    await progress(`@${premiumBotUsername} invoice bermadi — allaqachon Premium bo'lishi mumkin, ${repreamBotUsername} orqali tekshirilmoqda...`);
    return logoutAndVerify();
  }
  await progress(`📄 Invoice olindi: ${invoiceMsg.media?.title ?? "Telegram Premium"}`);

  // ── Step 2: Accept terms ──────────────────────────────────────────────────────
  await progress(`2️⃣ Shartlar qabul qilinmoqda...`);
  await acceptTermsIfPresent(client, premiumBotUsername, invoiceMsg);
  await delay(1500);

  // ── Step 3: Get payment form (URL + formId) ───────────────────────────────────
  await progress(`3️⃣ To'lov formasi olinmoqda...`);
  const paymentFormInfo = await getPaymentForm(client, premiumBotUsername, invoiceMsg);
  if (!paymentFormInfo) {
    return {
      success: false,
      hasPremium: false,
      message: "To'lov formasi olinmadi (GetPaymentForm xatosi)",
    };
  }

  // ── Step 4: Tokenize card ─────────────────────────────────────────────────────
  let credentials: string | undefined;
  let playwrightProxyIpId: number | undefined;

  if (paymentFormInfo.providerPublicKey) {
    // Stripe path (when providerPublicKey is present) — direct API, no Playwright
    await progress(`4️⃣ Karta ma'lumotlari yuborilmoqda...`);
    try {
      const stripeToken = await tokenizeCardWithStripe(paymentFormInfo.providerPublicKey, {
        cardNumber: card.cardNumber,
        expiry: card.expiry,
        cvv: card.cvv,
        cardHolder: card.cardHolder,
      });
      if (!stripeToken || typeof stripeToken !== "string") {
        throw new Error("Stripe bo'sh yoki noto'g'ri token qaytardi");
      }
      credentials = JSON.stringify({ type: "card", id: stripeToken });
      await progress(`🔑 Karta ma'lumotlari qabul qilindi — Telegram ga yuborilmoqda...`);
    } catch (err: any) {
      logger.error({ err }, "Stripe tokenizatsiya xatosi");
      return {
        success: false,
        hasPremium: false,
        message: `Stripe karta tokenizatsiya xatosi: ${err.message ?? "noma'lum"}`,
      };
    }
  } else {
    // Smart Glocal path — Playwright fills the web form. Only 1 browser can
    // actually be filling/submitting a card at a time (PLAYWRIGHT_MAX_CONCURRENCY
    // mutex), so report "waiting in line" if another session currently holds
    // the slot, and only announce "entering card data" once this session
    // actually has it — otherwise 3 sessions all show step 4 at once even
    // though only one of them is doing anything.
    const playwrightResult = await payPremiumViaWebApp(
      paymentFormInfo.url,
      card,
      premiumBotUsername,
      onAskOtp
        ? async () => {
            await progress(`🔐 3DS SMS kodi kutilmoqda — operator kodini yuboring...`);
            return onAskOtp();
          }
        : undefined,
      () => {
        void progress(`🕐 Navbatda kutilmoqda (bitta vaqtda faqat 1 ta karta kiritiladi)...`);
      },
      () => {
        void progress(`4️⃣ Karta ma'lumotlari kiritilmoqda...`);
      },
    );

    if (!playwrightResult.submitted) {
      // A card/anti-fraud decline (cardBlocked) is reported the same way as a
      // Telegram-side PAYMENT_FAILED so the caller's existing card-retry UI
      // fires here too — swapping to a different saved card and restarting
      // the whole flow from a fresh @PremiumBot /start (see the caller's
      // retry loop) can recover from this, unlike a technical fill failure.
      if (playwrightResult.cardBlocked && playwrightResult.proxyIpId) {
        cooldownProxyIp(playwrightResult.proxyIpId);
        await recordProxyIpFailure(playwrightResult.proxyIpId).catch(() => {});
      }
      return {
        success: false,
        hasPremium: false,
        message: playwrightResult.cardBlocked
          ? "Karta anti-fraud tomonidan bloklandi (to'lov sahifasida xato ko'rsatildi)"
          : "Karta formasi to'ldirishda xato — /tmp/premium-fail-*.png ga screenshot saqlandi",
        paymentDeclined: playwrightResult.cardBlocked,
      };
    }

    credentials = playwrightResult.credentials;
    playwrightProxyIpId = playwrightResult.proxyIpId;
    await progress(
      credentials
        ? `🔑 Karta tokenizatsiya qilindi — Telegram ga yuborilmoqda...`
        : `🔑 Telegram ga to'lov yuborilmoqda (token yo'q)...`,
    );
  }

  // ── Relay pacing hook: fires after step 4, before step 5 ─────────────────────
  if (onBeforeStep5) {
    await onBeforeStep5().catch(() => {});
  }

  // ── Step 5: Send payment form via MTProto ────────────────────────────────────
  await progress(`5️⃣ Telegram orqali to'lov yuborilmoqda...`);

  const payResult = await sendPaymentFormToTelegram(
    client,
    premiumBotUsername,
    invoiceMsg,
    paymentFormInfo.formId,
    credentials,
  );

  if (!payResult.success) {
    const isPaymentDeclined = payResult.errorCode === "PAYMENT_FAILED";
    if (isPaymentDeclined && playwrightProxyIpId) {
      // Anti-fraud signal likely tied to the tokenizing browser's IP — rotate
      // away from it immediately (cooldown) and count it toward the
      // longer-term auto-retirement threshold too.
      cooldownProxyIp(playwrightProxyIpId);
      await recordProxyIpFailure(playwrightProxyIpId).catch(() => {});
    }
    return {
      success: false,
      hasPremium: false,
      message: isPaymentDeclined
        ? "payments.SendPaymentForm xatosi — to'lov rad etildi (PAYMENT_FAILED)"
        : "payments.SendPaymentForm xatosi — to'lov o'tmadi",
      paymentDeclined: isPaymentDeclined,
    };
  }

  // Increment proxy IP usage only after confirmed payment success
  if (playwrightProxyIpId) await incrementProxyIpUsage(playwrightProxyIpId).catch(() => {});

  // ── Step 5b: Bank 3DS verification (PaymentVerificationNeeded) ───────────────
  if (payResult.verificationUrl) {
    if (onVerificationNeeded) {
      await progress(
        `🔐 Bank 3DS tasdiqlash talab qildi — admin sahifani ochib kodni kiritsin...`,
      );
      await onVerificationNeeded(payResult.verificationUrl);
      await progress(`🔐 3DS so'rovi yuborildi — operator tasdig'i kutilmoqda...`);
    } else {
      // No handler — log and continue; premium verify will confirm outcome
      logger.warn({ verificationUrl: payResult.verificationUrl }, "PaymentVerificationNeeded but no handler provided");
      await progress(`⚠️ Bank 3DS talab qildi lekin handler yo'q — tekshirishga o'tilmoqda...`);
    }
  } else {
    await progress(`✅ To'lov qabul qilindi!`);
  }

  // ── Step 6: Cancel auto-renewal ───────────────────────────────────────────────
  // Give the operator a chance to signal "Evro ekan" (restart) or "Bekor qilish"
  // (abort) before we proceed. Throws FlowRestartError / FlowAbortError if chosen.
  if (onStep6) await onStep6();
  await progress(`6️⃣ @${premiumBotUsername} avto-obunani bekor qilish...`);
  const cancelResult = await cancelPremiumAutoRenewal(client, premiumBotUsername).catch(
    (err: any): CancelAutoRenewalResult => ({ success: false, reason: `Xato: ${err?.message ?? "noma'lum"}` }),
  );
  await progress(
    cancelResult.success
      ? `✅ Avto-obuna bekor qilindi: ${cancelResult.reason}`
      : `⚠️ Avto-obuna bekor qilinmagan bo'lishi mumkin: ${cancelResult.reason}`,
  );

  // ── Steps 7-8: Log out, then verify via the manba/source bot ─────────────────
  return logoutAndVerify(payResult.verificationUrl ? 10 : undefined, cancelResult.success);
}
