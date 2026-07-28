import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { EditedMessage, EditedMessageEvent } from "telegram/events/EditedMessage.js";
import { Api } from "telegram";
import { computeCheck } from "telegram/Password.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { db } from "@workspace/db";
import { masterSessions, userbotSessions } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { withTimeout, isTimeoutError } from "../lib/timeout.js";

const API_ID = parseInt(process.env.API_ID || "0");
const API_HASH = process.env.API_HASH || "";

// Max time to wait for an MTProto connection before giving up. A dead/slow proxy
// is the most common freeze source, so bound every connect() to fail fast.
// 45s per attempt — Replit → Telegram MTProto can be slow on cold connections.
const CLIENT_CONNECT_TIMEOUT_MS = 45_000;
// Any single MTProto RPC call (getInputEntity, invoke, etc.) must resolve or
// fail within this window — an unbounded call on a stalled connection would
// otherwise freeze the whole flow forever.
const RPC_TIMEOUT_MS = 30_000;
// How many times to retry a timed-out connect before giving up entirely.
const CONNECT_RETRIES = 2;


// ── Per-operator client caches ─────────────────────────────────────────────────
// Active master clients: one per operatorId (the first working slot found).
const _masterClients = new Map<number, TelegramClient>();

// ── Per-client sendCommand mutex ───────────────────────────────────────────────
// sendCommandAndWaitForNumber registers an event listener then sends a command.
// If two callers share the same TelegramClient and run concurrently, the first
// bot response fires BOTH listeners — one call steals the other's number.
// This queue serialises all sendCommandAndWaitForNumber calls per TelegramClient
// instance so only one is in-flight at a time.
const _sendCommandQueues = new WeakMap<TelegramClient, Promise<unknown>>();
function enqueueSendCommand<T>(client: TelegramClient, fn: () => Promise<T>): Promise<T> {
  const prev = _sendCommandQueues.get(client) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn()); // run even if previous threw
  _sendCommandQueues.set(client, next.catch(() => {})); // store settled tail
  return next;
}
// Pending (not-yet-authorized) login clients, keyed by "${operatorId}:${slot}"
// so a super admin can run up to 3 parallel login flows simultaneously.
const _pendingClients = new Map<string, { client: TelegramClient; createdAt: number }>();
const PENDING_CLIENT_TTL_MS = 15 * 60 * 1000; // abandoned login attempts expire after 15 min

/** Returns the pending-client map key for a given operator + slot. */
function pKey(operatorId: number, slot: number): string { return `${operatorId}:${slot}`; }

async function _purgeStalePendingClients() {
  const now = Date.now();
  for (const [key, entry] of _pendingClients) {
    if (now - entry.createdAt > PENDING_CLIENT_TTL_MS) {
      _pendingClients.delete(key);
      try { await entry.client.disconnect(); } catch (_) {}
    }
  }
}

// ── Typed errors ──────────────────────────────────────────────────────────────

export class TwoFARequiredError extends Error {
  constructor() {
    super("2FA_REQUIRED");
    this.name = "TwoFARequiredError";
  }
}

/**
 * Connect a client with a bounded timeout + retry on timeout.
 * Retries up to CONNECT_RETRIES times if the connection times out (slow network).
 * On any non-timeout error or exhausted retries, disconnects the client cleanly.
 */
export async function connectWithCleanup(
  client: TelegramClient,
  label = "Telegram ulanish",
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CONNECT_RETRIES + 1; attempt++) {
    try {
      await withTimeout(client.connect(), CLIENT_CONNECT_TIMEOUT_MS, label);
      return; // success
    } catch (err) {
      lastErr = err;
      if (!isTimeoutError(err)) {
        // Non-timeout error — no point retrying, clean up and bail immediately
        try { await client.disconnect(); } catch (_) { /* ignore */ }
        throw err;
      }
      if (attempt <= CONNECT_RETRIES) {
        logger.warn({ attempt, label }, "Telegram ulanish timeout — qayta urinilmoqda...");
        // Brief pause before retry to let any half-open socket settle
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  // All attempts exhausted
  try { await client.disconnect(); } catch (_) { /* ignore */ }
  throw lastErr;
}

// ── Userbot session invalidation & cleanup ─────────────────────────────────────

// Telegram error signatures that mean a userbot session can never be reused
// again (the account logged the session out, revoked it, or was deactivated).
// Any other error (network hiccup, timeout, flood wait) is transient and must
// NOT invalidate the session.
const SESSION_INVALID_SIGNATURES = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
];

export function isSessionInvalidError(err: any): boolean {
  const msg: string = String(err?.errorMessage ?? err?.message ?? err ?? "");
  return SESSION_INVALID_SIGNATURES.some((sig) => msg.includes(sig));
}

/**
 * Marks a userbot session as permanently invalid so it's excluded from future
 * flows (queries filter on status='active') and becomes eligible for the
 * scheduled cleanup job to delete after the grace period.
 */
export async function markUserbotSessionInvalid(phone: string, reason: string): Promise<void> {
  try {
    await db
      .update(userbotSessions)
      .set({ status: "invalid", lastFailedAt: new Date(), failReason: reason.slice(0, 300) })
      .where(eq(userbotSessions.phone, phone));
    logger.warn({ phone, reason }, "Userbot session marked invalid");
  } catch (err) {
    logger.error({ err, phone }, "Failed to mark userbot session invalid");
  }
}

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const INVALID_SESSION_GRACE_MS = 24 * 60 * 60 * 1000; // keep invalid rows visible for 24h before purging

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function _runUserbotSessionCleanup(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - INVALID_SESSION_GRACE_MS);
    const { sql } = await import("drizzle-orm");
    const deleted = await db
      .delete(userbotSessions)
      .where(
        sql`${userbotSessions.status} = 'invalid' AND ${userbotSessions.lastFailedAt} IS NOT NULL AND ${userbotSessions.lastFailedAt} < ${cutoff}`,
      )
      .returning({ phone: userbotSessions.phone });
    if (deleted.length > 0) {
      logger.info({ count: deleted.length, phones: deleted.map((d) => d.phone) }, "Cleaned up stale invalid userbot sessions");
    }
  } catch (err) {
    logger.error({ err }, "Userbot session cleanup failed");
  }

  // Also purge abandoned /login attempts (operator started login but never
  // finished it) so their open MTProto connections don't leak indefinitely.
  await _purgeStalePendingClients().catch((err) => {
    logger.error({ err }, "Pending client cleanup failed");
  });
}

/**
 * Starts the periodic cleanup of failed/stale userbot sessions. Idempotent —
 * calling twice does not create a second timer. Runs once immediately, then
 * every CLEANUP_INTERVAL_MS.
 */
export function startUserbotSessionCleanup(): void {
  if (_cleanupTimer) return;
  _runUserbotSessionCleanup().catch(() => {});
  _cleanupTimer = setInterval(() => {
    _runUserbotSessionCleanup().catch(() => {});
  }, CLEANUP_INTERVAL_MS);
}

/**
 * Actively verifies every 'active' userbot session against Telegram (via a
 * cheap `users.GetFullUser(me)` call) instead of waiting for a real flow to
 * stumble on it later. Sessions the source/provider bot has frozen, cancelled,
 * or logged out show up in our list as ordinary 'active' rows until something
 * actually tries to use them — this lets an operator purge them on demand.
 * Confirmed-dead sessions are deleted immediately (no grace period, since this
 * is an explicit manual check, not an inferred failure from a background job).
 * Sessions that error for any other reason (timeout, flood wait, proxy issue)
 * are left untouched — only a confirmed invalid-session signature counts as dead.
 */
export async function verifyAndPurgeDeadSessions(
  onProgress?: (checked: number, total: number, phone: string) => void,
  skipPhones?: Set<string>,
  ownerId?: number,
): Promise<{ checked: number; removed: string[]; errors: string[]; skipped: string[] }> {
  const sessions = await db
    .select()
    .from(userbotSessions)
    .where(
      ownerId !== undefined
        ? and(eq(userbotSessions.status, "active"), eq(userbotSessions.ownerId, ownerId))
        : eq(userbotSessions.status, "active"),
    );

  const removed: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  const CONCURRENCY = 3;
  let nextIndex = 0;
  let checked = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= sessions.length) return;
      const row = sessions[i];

      // Don't open a second concurrent connection with the same session string
      // while a Premium flow is actively using it — Telegram can flag duplicate
      // simultaneous connections on one auth key as suspicious.
      if (skipPhones?.has(row.phone)) {
        skipped.push(row.phone);
        checked++;
        onProgress?.(checked, sessions.length, row.phone);
        continue;
      }

      let client: TelegramClient | null = null;
      try {
        client = await createClientFromSession(row.sessionString);
        await client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
      } catch (err: any) {
        if (isSessionInvalidError(err)) {
          await db.delete(userbotSessions).where(eq(userbotSessions.phone, row.phone));
          removed.push(row.phone);
          logger.warn({ phone: row.phone, err: err?.errorMessage ?? err?.message }, "Purged dead userbot session (manual cleanup)");
        } else {
          errors.push(row.phone);
          logger.warn({ phone: row.phone, err: err?.errorMessage ?? err?.message }, "Session check failed with non-fatal error — left untouched");
        }
      } finally {
        if (client) await client.disconnect().catch(() => {});
        checked++;
        onProgress?.(checked, sessions.length, row.phone);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sessions.length) }, worker));
  return { checked, removed, errors, skipped };
}

// ── Master client (per operator) ──────────────────────────────────────────────

export async function getMasterClient(operatorId: number): Promise<TelegramClient | null> {
  const cached = _masterClients.get(operatorId);
  if (cached) {
    try {
      if (await cached.isUserAuthorized()) return cached;
      // Cached client is connected but no longer authorized — drop it and
      // fall through to reload from the DB session below.
      await cached.disconnect().catch(() => {});
    } catch (_) {
      await cached.disconnect().catch(() => {});
    }
    _masterClients.delete(operatorId);
  }

  // ── 1. Own sessions — try all slots in ascending order ───────────────────
  const sessions = await db
    .select()
    .from(masterSessions)
    .where(eq(masterSessions.operatorId, operatorId))
    .orderBy(asc(masterSessions.slot));

  for (const row of sessions) {
    try {
      const session = new StringSession(row.sessionString);
      const client = new TelegramClient(session, API_ID, API_HASH, {
        connectionRetries: 3,
        baseLogger: new Logger(LogLevel.NONE),
      });
      await connectWithCleanup(client);
      if (await client.isUserAuthorized()) {
        _masterClients.set(operatorId, client);
        return client;
      }
      // Connected, but Telegram no longer considers this session authorized
      // (revoked/logged out elsewhere). The DB row is stale — remove it so
      // the login menu doesn't keep showing a phone number that no longer
      // actually works, contradicting every other flow that correctly
      // reports "not connected".
      await client.disconnect().catch(() => {});
      await db.delete(masterSessions).where(
        and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, row.slot)),
      );
      logger.warn({ operatorId, slot: row.slot }, "Master session no longer authorized — stale row removed");
    } catch (err) {
      if (isSessionInvalidError(err)) {
        await db.delete(masterSessions).where(
          and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, row.slot)),
        );
        logger.warn({ operatorId, slot: row.slot, err: (err as any)?.errorMessage ?? (err as any)?.message }, "Master session invalid — stale row removed");
      } else {
        logger.error({ err, slot: row.slot }, "Failed to load master session");
      }
    }
  }

  // ── 2. Shared session fallback ────────────────────────────────────────────
  // If the operator has no own session, check whether another operator has
  // shared their master session with this one. Try ALL matching rows (all
  // slots) in slot-asc order so a dead slot doesn't block a live one.
  // We do NOT delete the owner's DB row on failure — it belongs to the owner.
  const allRows = await db
    .select()
    .from(masterSessions)
    .orderBy(asc(masterSessions.slot));

  const sharedRows = allRows.filter((row) => {
    if (!row.sharedWith) return false;
    try {
      const ids: number[] = JSON.parse(row.sharedWith);
      return ids.includes(operatorId);
    } catch { return false; }
  });

  for (const sharedRow of sharedRows) {
    try {
      const session = new StringSession(sharedRow.sessionString);
      const client = new TelegramClient(session, API_ID, API_HASH, {
        connectionRetries: 3,
        baseLogger: new Logger(LogLevel.NONE),
      });
      await connectWithCleanup(client);
      if (await client.isUserAuthorized()) {
        // Cache under requester's ID — disconnects cleanly on next auth check
        _masterClients.set(operatorId, client);
        logger.info({ operatorId, ownerOperatorId: sharedRow.operatorId, slot: sharedRow.slot }, "Using shared master session");
        return client;
      }
      await client.disconnect().catch(() => {});
      logger.warn({ operatorId, ownerOperatorId: sharedRow.operatorId, slot: sharedRow.slot }, "Shared master session no longer authorized — trying next slot");
    } catch (err) {
      logger.error({ err, ownerOperatorId: sharedRow.operatorId, slot: sharedRow.slot }, "Failed to load shared master session — trying next slot");
    }
  }

  return null;
}

/**
 * When Telegram sends SentCodeTypeApp, it delivers a service message from
 * user 777000 to every active session of that phone number.
 * This helper connects to an existing session string and waits for that message,
 * then extracts the numeric code.
 */
async function tryReadAuthCodeFromSession(
  sessionString: string,
  timeoutMs = 30000,
): Promise<string | null> {
  let client: TelegramClient | null = null;
  try {
    client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
    });
    await connectWithCleanup(client);

    const code = await new Promise<string | null>((resolve) => {
      let resolved = false;
      const evFilter = new NewMessage({ fromUsers: ["777000"] });
      let handler: (e: NewMessageEvent) => Promise<void>;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { client!.removeEventHandler(handler, evFilter); } catch (_) {}
        resolve(null);
      }, timeoutMs);

      handler = async (e: NewMessageEvent) => {
        if (resolved) return;
        const text: string = e.message?.text ?? e.message?.message ?? "";
        // Extract 5-digit login code from Telegram service message
        const match = text.match(/\b(\d{5,6})\b/);
        if (match) {
          resolved = true;
          clearTimeout(timer);
          try { client!.removeEventHandler(handler, evFilter); } catch (_) {}
          resolve(match[1]);
        }
      };

      client!.addEventHandler(handler, evFilter);
    });

    return code;
  } catch (err) {
    logger.warn({ err }, "tryReadAuthCodeFromSession failed");
    return null;
  } finally {
    if (client) try { await client.disconnect(); } catch (_) {}
  }
}

export async function startMasterLogin(
  phone: string,
  operatorId: number,
  slot = 1,
): Promise<{ phoneCodeHash: string; codeType: string; nextType: string; autoCode?: string }> {
  await _purgeStalePendingClients();
  const key = pKey(operatorId, slot);
  const existing = _pendingClients.get(key);
  if (existing) {
    try { await existing.client.disconnect(); } catch (_) {}
  }

  const session = new StringSession("");
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
  });
  await connectWithCleanup(client);
  _pendingClients.set(key, { client, createdAt: Date.now() });

  let result: Api.auth.SentCode;
  try {
    result = await withTimeout(
      client.invoke(
        new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: API_ID,
          apiHash: API_HASH,
          settings: new Api.CodeSettings({}),
        }),
      ),
      RPC_TIMEOUT_MS,
      "SendCode",
    ) as Api.auth.SentCode;
  } catch (err: any) {
    logger.error({ err, phone, errMsg: err?.message, errCode: err?.errorMessage }, "SendCode API error");
    throw err;
  }

  // Strip "auth." prefix GramJS includes in className (e.g. "auth.SentCodeTypeApp" → "SentCodeTypeApp")
  const typeName = (result.type?.className    ?? "unknown").replace(/^auth\./, "");
  const nextType = (result.nextType?.className ?? "none"  ).replace(/^auth\./, "");
  logger.info({ phone, typeName, nextType }, "SendCode success");

  // For SentCodeTypeApp the code lands in an existing Telegram session.
  // Try to read it automatically from userbotSessions or masterSessions.
  // Phones may be stored with or without leading "+", so try both forms.
  let autoCode: string | undefined;
  if (typeName === "SentCodeTypeApp") {
    const phoneVariants = Array.from(new Set([
      phone,
      phone.startsWith("+") ? phone.slice(1) : `+${phone}`,
    ]));

    let sessionString: string | undefined;
    for (const ph of phoneVariants) {
      const ubRow = await db
        .select({ sessionString: userbotSessions.sessionString })
        .from(userbotSessions)
        .where(eq(userbotSessions.phone, ph))
        .limit(1);
      if (ubRow[0]?.sessionString) { sessionString = ubRow[0].sessionString; break; }

      const msRow = await db
        .select({ sessionString: masterSessions.sessionString })
        .from(masterSessions)
        .where(eq(masterSessions.phone, ph))
        .limit(1);
      if (msRow[0]?.sessionString) { sessionString = msRow[0].sessionString; break; }
    }

    logger.info({ phone, found: !!sessionString }, "SentCodeTypeApp — session lookup");
    if (sessionString) {
      const found = await tryReadAuthCodeFromSession(sessionString, 28000);
      if (found) {
        autoCode = found;
        logger.info({ phone }, "Auto-read auth code from existing session");
      } else {
        logger.warn({ phone }, "SentCodeTypeApp — session found but no code message in 28s");
      }
    }
  }

  return { phoneCodeHash: result.phoneCodeHash, codeType: typeName, nextType, autoCode };
}

export async function removeMasterSession(operatorId: number, slot?: number): Promise<void> {
  const client = _masterClients.get(operatorId);
  if (client) {
    try { await client.disconnect(); } catch (_) {}
    _masterClients.delete(operatorId);
  }
  if (slot !== undefined) {
    // Remove only the specific slot's pending client
    const key = pKey(operatorId, slot);
    const pending = _pendingClients.get(key);
    if (pending) {
      try { await pending.client.disconnect(); } catch (_) {}
      _pendingClients.delete(key);
    }
  } else {
    // Remove all pending clients for this operator (all slots)
    for (const [key, entry] of _pendingClients) {
      if (key.startsWith(`${operatorId}:`)) {
        try { await entry.client.disconnect(); } catch (_) {}
        _pendingClients.delete(key);
      }
    }
  }
}

export async function resendCodeForPhone(
  phone: string,
  phoneCodeHash: string,
  operatorId: number,
  slot = 1,
): Promise<{ newPhoneCodeHash: string; codeType: string }> {
  const pending = _pendingClients.get(pKey(operatorId, slot));
  if (!pending) throw new Error("Faol login sessiyasi topilmadi. Qaytadan /login yuboring.");
  const client = pending.client;

  let result: Api.auth.SentCode;
  try {
    result = await withTimeout(
      client.invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash })),
      RPC_TIMEOUT_MS,
      "ResendCode",
    ) as Api.auth.SentCode;
  } catch (err: any) {
    logger.error({ err, phone, errMsg: err?.message }, "ResendCode API error");
    throw err;
  }

  const typeName = result.type?.className ?? "unknown";
  logger.info({ phone, typeName }, "ResendCode success");
  return { newPhoneCodeHash: result.phoneCodeHash, codeType: typeName };
}

export async function completeMasterLoginCode(
  phone: string,
  code: string,
  phoneCodeHash: string,
  operatorId: number,
  slot = 1,
): Promise<string> {
  const key = pKey(operatorId, slot);
  const pending = _pendingClients.get(key);

  // Must use the exact same client that called SendCode — a new client would
  // give PHONE_CODE_EXPIRED because Telegram ties the code to the session.
  if (!pending) {
    throw new Error("Login sessiyasi topilmadi yoki muddati o'tgan. Qaytadan /login dan boshlang.");
  }
  const client = pending.client;

  try {
    await withTimeout(
      client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: code,
        }),
      ),
      RPC_TIMEOUT_MS,
      "SignIn",
    );
  } catch (err: any) {
    if (
      err?.errorMessage === "SESSION_PASSWORD_NEEDED" ||
      err?.message?.includes("SESSION_PASSWORD_NEEDED")
    ) {
      _pendingClients.set(key, { client, createdAt: Date.now() });
      throw new TwoFARequiredError();
    }
    throw err;
  }

  const sessionString = client.session.save() as unknown as string;
  _masterClients.set(operatorId, client);
  _pendingClients.delete(key);
  return sessionString;
}

export async function completeMasterLogin2FA(
  password: string,
  operatorId: number,
  slot = 1,
): Promise<string> {
  const key = pKey(operatorId, slot);
  const pending = _pendingClients.get(key);
  if (!pending) {
    throw new Error("Faol login jarayoni topilmadi. Qaytadan /login boshlang.");
  }
  const client = pending.client;

  // SRP_ID_INVALID: the server's SRP session expires quickly (~30 s).
  // If it fires we must re-fetch GetPassword (new SRP ID) and retry — up to 3 times.
  const MAX_SRP_RETRIES = 3;
  let lastSrpError: any;
  for (let attempt = 0; attempt < MAX_SRP_RETRIES; attempt++) {
    try {
      const passwordInfo = await withTimeout(client.invoke(new Api.account.GetPassword()), RPC_TIMEOUT_MS, "GetPassword");
      const check = await computeCheck(passwordInfo, password.trim());
      await withTimeout(client.invoke(new Api.auth.CheckPassword({ password: check })), RPC_TIMEOUT_MS, "CheckPassword");
      lastSrpError = undefined;
      break; // success
    } catch (err: any) {
      const isSrpExpired =
        err?.errorMessage === "SRP_ID_INVALID" ||
        err?.message?.includes("SRP_ID_INVALID");
      if (isSrpExpired && attempt < MAX_SRP_RETRIES - 1) {
        logger.warn({ attempt }, "SRP_ID_INVALID on CheckPassword — refetching GetPassword and retrying");
        lastSrpError = err;
        continue;
      }
      throw err;
    }
  }
  if (lastSrpError) throw lastSrpError;

  const sessionString = client.session.save() as unknown as string;
  _masterClients.set(operatorId, client);
  _pendingClients.delete(key);
  return sessionString;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function createClientFromSession(
  sessionString: string,
): Promise<TelegramClient> {
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
  });
  try {
    await connectWithCleanup(client);
  } catch (err: any) {
    // Clean disconnect before re-throwing so gramJS doesn't leave a dangling
    // connection that fires events on an already-failed client.
    try { await client.disconnect(); } catch (_) {}
    throw err;
  }
  return client;
}

export function waitForRepreamMessage(
  client: TelegramClient,
  botUsername: string,
  timeoutMs = 30000,
): Promise<{ text: string; message: any } | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const eventFilter = new NewMessage({ fromUsers: [botUsername] });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { client.removeEventHandler(handler, eventFilter); } catch (_) {}
      resolve(null);
    }, timeoutMs);

    // eslint-disable-next-line prefer-const
    let handler: (event: NewMessageEvent) => Promise<void>;
    handler = async (event: NewMessageEvent) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { client.removeEventHandler(handler, eventFilter); } catch (_) {}
      const msg = event.message;
      resolve({ text: msg.text || "", message: msg });
    };

    client.addEventHandler(handler, eventFilter);
  });
}

/**
 * Waits for the source bot to deliver the auth code after "GetCode" is clicked.
 * The bot may send a NEW message OR edit the original number message in-place —
 * both cases are handled so we never time out when the reply actually arrived.
 *
 * @param originalMessageId - the message ID of the "/getnumber" reply (the one
 *   that had Cancel/Freeze/GetCode buttons).  Used to match edits precisely.
 */
export function waitForRepreamCode(
  client: TelegramClient,
  botUsername: string,
  originalMessageId: number,
  timeoutMs = 35000,
  /** Extra senders to accept on new-message path (e.g. relay bots like RePreAmooBot). */
  extraSenders: string[] = [],
): Promise<{ text: string; message: any } | null> {
  return new Promise((resolve) => {
    let resolved = false;

    const settle = (msg: any) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { client.removeEventHandler(newHandler, newFilter); } catch (_) {}
      try { client.removeEventHandler(editHandler, editFilter); } catch (_) {}
      resolve({ text: msg.text || "", message: msg });
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { client.removeEventHandler(newHandler, newFilter); } catch (_) {}
      try { client.removeEventHandler(editHandler, editFilter); } catch (_) {}
      resolve(null);
    }, timeoutMs);

    // ── New message from whitelisted senders ─────────────────────────────
    // Include botUsername + any relay bots (e.g. RePreAmooBot) that may
    // forward the OTP on the source bot's behalf.
    const allowedSenders = Array.from(new Set([botUsername, ...extraSenders]));
    const newFilter = new NewMessage({ fromUsers: allowedSenders });
    // eslint-disable-next-line prefer-const
    let newHandler: (event: NewMessageEvent) => Promise<void>;
    newHandler = async (event: NewMessageEvent) => {
      const msg = event.message;
      if (/Code\s*:/i.test(msg.text || "")) settle(msg);
    };
    client.addEventHandler(newHandler, newFilter);

    // ── Edited message from the bot (bot edits the original number message) ─
    const editFilter = new EditedMessage({ fromUsers: [botUsername] });
    // eslint-disable-next-line prefer-const
    let editHandler: (event: EditedMessageEvent) => Promise<void>;
    editHandler = async (event: EditedMessageEvent) => {
      const msg = event.message;
      // Accept only the specific message that was edited AND contains a code.
      if (
        msg.id === originalMessageId &&
        /Code\s*:/i.test(msg.text || "")
      ) {
        settle(msg);
      }
    };
    client.addEventHandler(editHandler, editFilter);
  });
}

export function waitForRepreamMessageWithButtons(
  client: TelegramClient,
  botUsername: string,
  timeoutMs = 30000,
): Promise<{ text: string; message: any } | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const eventFilter = new NewMessage({ fromUsers: [botUsername] });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { client.removeEventHandler(handler, eventFilter); } catch (_) {}
      resolve(null);
    }, timeoutMs);

    // eslint-disable-next-line prefer-const
    let handler: (event: NewMessageEvent) => Promise<void>;
    handler = async (event: NewMessageEvent) => {
      const msg = event.message;
      // Only resolve if the message has inline buttons (the number response)
      if (msg.replyMarkup) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try { client.removeEventHandler(handler, eventFilter); } catch (_) {}
        resolve({ text: msg.text || "", message: msg });
      } else {
        // Log messages without buttons so we know the bot IS responding
        logger.warn(
          { from: botUsername, text: (msg.text || "").slice(0, 200) },
          "waitForRepreamMessageWithButtons: message without replyMarkup ignored",
        );
      }
    };

    client.addEventHandler(handler, eventFilter);
  });
}

// Listens for @PremiumBot response — text message OR Telegram invoice media
type PremiumBotMsg =
  | { type: "text"; text: string; message: any }
  | { type: "invoice"; message: any };

function waitForPremiumBotMessage(
  client: TelegramClient,
  botUsername: string,
  timeoutMs = 45000,
): Promise<PremiumBotMsg | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const eventFilter = new NewMessage({ fromUsers: [botUsername] });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { client.removeEventHandler(handler, eventFilter); } catch (_) {}
      resolve(null);
    }, timeoutMs);

    // eslint-disable-next-line prefer-const
    let handler: (event: NewMessageEvent) => Promise<void>;
    handler = async (event: NewMessageEvent) => {
      if (resolved) return;
      const msg = event.message;

      // Invoice message (MessageMediaInvoice)
      if (msg.media && msg.media.className === "MessageMediaInvoice") {
        resolved = true;
        clearTimeout(timer);
        try { client.removeEventHandler(handler, eventFilter); } catch (_) {}
        resolve({ type: "invoice", message: msg });
        return;
      }

      // Any text/non-invoice message
      const text: string = msg.text || msg.message || "";
      if (text) {
        resolved = true;
        clearTimeout(timer);
        try { client.removeEventHandler(handler, eventFilter); } catch (_) {}
        resolve({ type: "text", text, message: msg });
      }
    };

    client.addEventHandler(handler, eventFilter);
  });
}

export async function clickRepreamButton(
  client: TelegramClient,
  botUsername: string,
  messageId: number,
  buttonDataBase64: string,
): Promise<void> {
  const peer = await withTimeout(client.getInputEntity(botUsername), RPC_TIMEOUT_MS, "getInputEntity");
  await withTimeout(
    client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer,
        msgId: messageId,
        data: Buffer.from(buttonDataBase64, "base64"),
      }),
    ),
    RPC_TIMEOUT_MS,
    "GetBotCallbackAnswer",
  );
}

// ── Stripe tokenization ───────────────────────────────────────────────────────

export interface SavedCardData {
  cardNumber: string;
  expiry: string; // MM/YY
  cvv: string;
  cardHolder: string;
}

export async function tokenizeCardWithStripe(
  publishableKey: string,
  card: SavedCardData,
): Promise<string> {
  const [month, rawYear] = card.expiry.split("/");
  const expYear = rawYear.length === 2 ? `20${rawYear}` : rawYear;

  const params = new URLSearchParams({
    "card[number]": card.cardNumber.replace(/\s/g, ""),
    "card[exp_month]": month.trim(),
    "card[exp_year]": expYear.trim(),
    "card[cvc]": card.cvv,
    "card[name]": card.cardHolder,
  });

  const controller = new AbortController();
  const tOut = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(tOut);
  }

  const data = (await res.json()) as any;
  if (!res.ok || !data.id) {
    throw new Error(
      `Stripe tokenizatsiya xatosi: ${data.error?.message ?? "noma'lum"}`,
    );
  }
  return data.id as string;
}

// ── sendCodeForPhone / signInWithCode ─────────────────────────────────────────

// Map entries: key → { client, createdAt }
// Clients from abandoned flows are purged after 10 min.
const TEMP_CLIENT_TTL_MS = 10 * 60 * 1000;

interface TempClientEntry {
  client: TelegramClient;
  createdAt: number;
}

const _tempSignInClients = new Map<string, TempClientEntry>();

async function _purgeStaleTempClients() {
  const now = Date.now();
  for (const [key, entry] of _tempSignInClients) {
    if (now - entry.createdAt > TEMP_CLIENT_TTL_MS) {
      _tempSignInClients.delete(key);
      try { await entry.client.disconnect(); } catch (_) {}
    }
  }
}

export async function sendCodeForPhone(phone: string): Promise<string> {
  await _purgeStaleTempClients();

  // Guard against two operators starting /login for the SAME phone number at
  // the same time. Without this, the second call would silently overwrite
  // the first operator's entry in _tempSignInClients — the first operator's
  // SMS code hash would then be tied to a client object no longer reachable
  // by phone lookup, so their signInWithCodeAndPass would run against the
  // WRONG client and fail (or hang) instead of failing clearly up front.
  if (_tempSignInClients.has(phone)) {
    throw new Error(
      `PHONE_LOGIN_IN_PROGRESS: ${phone} raqami uchun boshqa operator allaqachon kod so'ragan. Bir necha daqiqa kuting yoki boshqa raqam bilan urinib ko'ring.`,
    );
  }

  const session = new StringSession("");
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
  });
  await connectWithCleanup(client);

  try {
    const result = await withTimeout(
      client.invoke(
        new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: API_ID,
          apiHash: API_HASH,
          settings: new Api.CodeSettings({}),
        }),
      ),
      RPC_TIMEOUT_MS,
      "SendCode",
    );
    _tempSignInClients.set(phone, { client, createdAt: Date.now() });
    return (result as Api.auth.SentCode).phoneCodeHash;
  } catch (err) {
    await client.disconnect();
    throw err;
  }
}

export async function signInWithCode(
  phone: string,
  phoneCodeHash: string,
  code: string,
): Promise<string> {
  return signInWithCodeAndPass(phone, phoneCodeHash, code, null);
}

/**
 * Sign in with SMS code; if SESSION_PASSWORD_NEEDED and `pass` is provided,
 * automatically completes 2FA — no separate step needed.
 */
export async function signInWithCodeAndPass(
  phone: string,
  phoneCodeHash: string,
  code: string,
  pass: string | null | undefined,
): Promise<string> {
  const entry = _tempSignInClients.get(phone);
  let client: TelegramClient;

  if (entry) {
    client = entry.client;
  } else {
    const session = new StringSession("");
    client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
    });
    await connectWithCleanup(client);
  }

  try {
    await withTimeout(
      client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: code,
        }),
      ),
      RPC_TIMEOUT_MS,
      "SignIn",
    );
  } catch (err: any) {
    const is2FA =
      err?.errorMessage === "SESSION_PASSWORD_NEEDED" ||
      err?.message?.includes("SESSION_PASSWORD_NEEDED");

    if (is2FA && pass) {
      // Auto-complete 2FA with the password provided by @RePreAmooBot
      // SRP_ID_INVALID: re-fetch GetPassword (new SRP ID) and retry up to 3 times.
      const pwdMod = await import("telegram/Password.js" as string);
      const computeCheckFn: (pwd: any, password: string) => Promise<any> =
        pwdMod.computeCheck ?? pwdMod.default?.computeCheck;
      if (!computeCheckFn) throw new Error("computeCheck funksiyasi topilmadi");
      const MAX_SRP_RETRIES = 3;
      let lastSrpErr: any;
      for (let attempt = 0; attempt < MAX_SRP_RETRIES; attempt++) {
        try {
          const passwordInfo = await withTimeout(client.invoke(new Api.account.GetPassword()), RPC_TIMEOUT_MS, "GetPassword");
          const check = await computeCheckFn(passwordInfo, pass);
          await withTimeout(client.invoke(new Api.auth.CheckPassword({ password: check })), RPC_TIMEOUT_MS, "CheckPassword");
          lastSrpErr = undefined;
          break;
        } catch (srpErr: any) {
          const isSrpExpired =
            srpErr?.errorMessage === "SRP_ID_INVALID" ||
            srpErr?.message?.includes("SRP_ID_INVALID");
          if (isSrpExpired && attempt < MAX_SRP_RETRIES - 1) {
            logger.warn({ attempt }, "SRP_ID_INVALID on userbot CheckPassword — retrying GetPassword");
            lastSrpErr = srpErr;
            continue;
          }
          throw srpErr;
        }
      }
      if (lastSrpErr) throw lastSrpErr;
    } else {
      throw err;
    }
  }

  const sessionString = client.session.save() as unknown as string;
  _tempSignInClients.delete(phone);
  // Keep connected client for getLinkFromPremiumBot (reuses the same session)
  _tempSignInClients.set(`${phone}_done`, { client, createdAt: Date.now() });
  return sessionString;
}

export async function getClientForPhone(
  phone: string,
  sessionString: string,
): Promise<TelegramClient> {
  const entry = _tempSignInClients.get(`${phone}_done`);
  if (entry) {
    _tempSignInClients.delete(`${phone}_done`);
    return entry.client;
  }
  return createClientFromSession(sessionString);
}

/**
 * Disconnect and discard the temporary client stored after `signInWithCodeAndPass`
 * when the caller does not need it for `getLinkFromPremiumBot`.
 * Safe to call even if no `_done` entry exists.
 */
export async function releaseSignedInClient(phone: string): Promise<void> {
  const entry = _tempSignInClients.get(`${phone}_done`);
  if (entry) {
    _tempSignInClients.delete(`${phone}_done`);
    try { await entry.client.disconnect(); } catch (_) {}
  }
}

// ── getLinkFromPremiumBot — with auto-payment support ─────────────────────────

export async function getLinkFromPremiumBot(
  sessionString: string,
  phone: string,
  botUsername: string,
  card?: SavedCardData,
): Promise<string | null> {
  let client: TelegramClient | null = null;
  try {
    client = await getClientForPhone(phone, sessionString);

    // Set up listener BEFORE sending /start to avoid race
    const listenPromise = waitForPremiumBotMessage(client, botUsername, 45000);
    await client.sendMessage(botUsername, { message: "/start" });

    const result = await listenPromise;
    if (!result) return null;

    // ── Text response (already has the link) ─────────────────────────────────
    if (result.type === "text") {
      const linkMatch = result.text.match(/https?:\/\/t\.me\/[^\s\n]+/);
      return linkMatch ? linkMatch[0] : result.text.slice(0, 200);
    }

    // ── Invoice response — attempt auto-payment ───────────────────────────────
    if (result.type === "invoice") {
      if (!card) {
        logger.warn(
          { botUsername },
          "Invoice from PremiumBot but no card saved — skipping payment",
        );
        return null;
      }

      const invoiceMsg = result.message;
      const peer = await withTimeout(client.getInputEntity(botUsername), RPC_TIMEOUT_MS, "getInputEntity");

      logger.info({ msgId: invoiceMsg.id }, "Getting payment form from Telegram");

      // gramjs uses InputInvoiceMessage to reference a message-based invoice
      const invoiceRef = new Api.InputInvoiceMessage({ peer, msgId: invoiceMsg.id });

      const form = await withTimeout(
        client.invoke(
          new Api.payments.GetPaymentForm({
            invoice: invoiceRef,
            themeParams: new Api.DataJSON({ data: "{}" }),
          }),
        ),
        RPC_TIMEOUT_MS,
        "GetPaymentForm",
      );

      const providerKey = (form as any).providerPublicKey as string | undefined;
      if (!providerKey) {
        logger.error("Payment form missing providerPublicKey — cannot tokenize card");
        return null;
      }

      logger.info("Tokenizing card with Stripe...");
      const stripeToken = await tokenizeCardWithStripe(providerKey, card);

      logger.info("Submitting payment form to Telegram...");
      await withTimeout(
        client.invoke(
          new Api.payments.SendPaymentForm({
            formId: (form as any).formId,
            invoice: invoiceRef,
            credentials: new Api.InputPaymentCredentials({
              save: false,
              data: new Api.DataJSON({
                data: JSON.stringify({ type: "card", id: stripeToken }),
              }),
            }),
          }),
        ),
        RPC_TIMEOUT_MS,
        "SendPaymentForm",
      );

      logger.info("Payment submitted — waiting for PremiumBot confirmation...");

      // Wait for PremiumBot to send the activation link after payment
      const confirmPromise = waitForPremiumBotMessage(client, botUsername, 45000);
      const confirm = await confirmPromise;
      if (!confirm) return null;

      if (confirm.type === "text") {
        const linkMatch = confirm.text.match(/https?:\/\/t\.me\/[^\s\n]+/);
        return linkMatch ? linkMatch[0] : confirm.text.slice(0, 300);
      }
    }

    return null;
  } catch (err) {
    logger.error({ err }, "Error in getLinkFromPremiumBot");
    return null;
  } finally {
    if (client) {
      try { await client.disconnect(); } catch (_) {}
    }
  }
}

// ── parseRepreamCodeMessage ───────────────────────────────────────────────────

/**
 * Parses the "Code received:" message from @RePreAmooBot.
 *
 * Example input:
 *   Code received:
 *
 *   Number: 79612840258
 *
 *   Code: 55163
 *
 *   Pass: 334034
 */
export function parseRepreamCodeMessage(text: string): {
  number: string | null;
  code: string | null;
  pass: string | null;
} {
  // Capture the raw token after the label (may be bare or backtick-wrapped).
  // strip() removes surrounding backticks, whitespace, and trailing punctuation.
  const extract = (pattern: RegExp) => {
    const m = text.match(pattern);
    return m ? m[1].replace(/^`+|`+$/g, "").replace(/[.,;!?]+$/, "").trim() || null : null;
  };

  return {
    number: extract(/Number\s*:\s*(`?\+?[\d`]+`?)/i),
    code:   extract(/Code\s*:\s*(`?\d+`?)/i),
    pass:   extract(/Pass(?:word)?\s*:\s*(`?[^`\s]+`?)/i),
  };
}

// ── sendCommandAndWaitForNumber ───────────────────────────────────────────────

export interface RepreamResult {
  phone: string;
  messageId: number;
  buttons: {
    cancel: string | null;
    freeze: string | null;
    getCode: string | null;
  };
}

export function sendCommandAndWaitForNumber(
  client: TelegramClient,
  botUsername: string,
  command: string,
): Promise<RepreamResult | null> {
  return enqueueSendCommand(client, () => _sendCommandAndWaitForNumberImpl(client, botUsername, command));
}

async function _sendCommandAndWaitForNumberImpl(
  client: TelegramClient,
  botUsername: string,
  command: string,
): Promise<RepreamResult | null> {
  // Set up listener BEFORE sending to avoid race condition
  const promise = waitForRepreamMessageWithButtons(client, botUsername, 30000);

  await client.sendMessage(botUsername, { message: command });

  const result = await promise;
  if (!result) return null;

  const text = result.text;

  // Extract phone number from message.
  // Try "+digit…" first; fall back to bare digit sequences (≥10 digits) and
  // prepend "+" so Telegram's SendCode accepts it.
  const withPlus = text.match(/\+\d[\d\s\-()]{7,}/);
  let phone: string;
  if (withPlus) {
    phone = withPlus[0].replace(/[\s\-()]/g, "");
  } else {
    const bare = text.match(/\b(\d{10,15})\b/);
    phone = bare ? `+${bare[1]}` : text.split("\n")[0].trim();
  }

  const buttons: RepreamResult["buttons"] = {
    cancel: null,
    freeze: null,
    getCode: null,
  };

  const markup = result.message.replyMarkup;
  if (markup?.rows) {
    for (const row of markup.rows) {
      for (const btn of row.buttons) {
        const btnText: string = (btn.text || "").toLowerCase();
        const data: string | null = btn.data
          ? Buffer.from(btn.data).toString("base64")
          : null;

        if (btnText.includes("cancel") || btnText.includes("bekor")) {
          buttons.cancel = data;
        } else if (
          btnText.includes("freeze") ||
          btnText.includes("friz") ||
          btnText.includes("freez")
        ) {
          buttons.freeze = data;
        } else if (
          btnText.includes("code") ||
          btnText.includes("kod") ||
          btnText.includes("get")
        ) {
          buttons.getCode = data;
        }
      }
    }
  }

  return { phone, messageId: result.message.id, buttons };
}
