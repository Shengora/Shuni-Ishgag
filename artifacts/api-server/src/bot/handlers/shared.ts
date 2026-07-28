/**
 * Shared state, constants, keyboards, and helper functions for all bot handlers.
 * Imported by every handler module instead of passing a large context object.
 */
import { InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import {
  masterSessions,
  pendingNumbers,
  userbotSessions,
  savedCards,
  providerBots,
  verifierBots,
  admins,
} from "@workspace/db";
import { eq, and, asc, desc, gte } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { E, EID } from "../../lib/emoji.js";
import {
  isSuperAdmin,
  isAnySuperAdmin,
  isActiveAdmin,
  getAdminStats,
  getCurrentPeriod,
} from "../super-admin.js";
import {
  getMasterClient,
  clickRepreamButton,
  getLinkFromPremiumBot,
} from "../client.js";
import { recordStat } from "../super-admin.js";
import type { PremiumCardData } from "../premium.js";

// ── Bot-level constants (from env) ─────────────────────────────────────────────
export const DEFAULT_REPREAM_BOT = (process.env.REPREAM_BOT || "RePreAmooBot").replace(/^@/, "");
export const REPREAM_BOT = DEFAULT_REPREAM_BOT;
export const PREMIUM_BOT = (process.env.PREMIUM_BOT || "premiumbot").replace(/^@/, "");
export const MAX_PREMIUM_RESTARTS = 5;
export const PREMIUM_FLOW_TOTAL_TIMEOUT = 20 * 60 * 1000;
export const ALLOWED_BATCH_COUNTS = new Set([1, 3, 5, 10, 20]);
export const ALLOWED_PREMIUM_COUNTS = new Set([1, 5, 10]);
export const ALLOWED_CARD_USES = new Set([1, 2, 3, 4, 5]);

// ── Legacy operator IDs (env fallback) ────────────────────────────────────────
const _rawLegacyIds = process.env.OPERATOR_USER_IDS ?? "";
const LEGACY_IDS = new Set(
  _rawLegacyIds.split(",").map((s) => s.trim()).filter(Boolean).map(Number),
);

export const isOperator = async (userId: number): Promise<boolean> => {
  if (isSuperAdmin(userId)) return true;
  if (LEGACY_IDS.has(userId)) return true;
  return isActiveAdmin(userId);
};

// ── Per-operator batch locks ──────────────────────────────────────────────────
export const batchRunning = new Set<number>();
export const batchPremiumRunning = new Set<number>();

// ── Global per-session premium lock ───────────────────────────────────────────
export const activePremiumSessions = new Set<string>();

// ── Per-operator manually selected source bot ─────────────────────────────────
export const operatorSelectedSource = new Map<number, string>();

// ── Verifier input awaiting ────────────────────────────────────────────────────
export const awaitingVerifierInput = new Set<number>();

// ── Step6 choice type ─────────────────────────────────────────────────────────
export type Step6Choice = "restart" | "abort" | "continue" | "step6_timeout";

// ── Pending callback Maps with TTL safety net ─────────────────────────────────
// Each Map has a parallel timestamp Map used by the background cleanup job.
// Individual flows already register their own shorter timers (120 s OTP,
// 90 s card-retry, 5-min step6 auto-detect). These are a last-resort safety
// net for entries orphaned by crashes or unexpected code paths.
export const pendingOtpCallbacks = new Map<string, (otp: string | null) => void>();
export const activeOtpFlow = new Map<number, string[]>();
export const pendingStep6Callbacks = new Map<string, (choice: Step6Choice) => void>();
export const pendingCardRetryCallbacks = new Map<string, (choice: number | "cancel") => void>();

// Timestamp tracking for TTL cleanup
const _otpTs  = new Map<string, number>();
const _s6Ts   = new Map<string, number>();
const _crTs   = new Map<string, number>();

/** Call after setting a pendingOtpCallbacks entry. */
export function trackOtpTs(flowId: string): void { _otpTs.set(flowId, Date.now()); }
/** Call before/after deleting a pendingOtpCallbacks entry. */
export function clearOtpTs(flowId: string): void  { _otpTs.delete(flowId); }
/** Call after setting a pendingStep6Callbacks entry. */
export function trackS6Ts(flowId: string): void   { _s6Ts.set(flowId, Date.now()); }
/** Call before/after deleting a pendingStep6Callbacks entry. */
export function clearS6Ts(flowId: string): void   { _s6Ts.delete(flowId); }
/** Call after setting a pendingCardRetryCallbacks entry. */
export function trackCrTs(id: string): void       { _crTs.set(id, Date.now()); }
/** Call before/after deleting a pendingCardRetryCallbacks entry. */
export function clearCrTs(id: string): void       { _crTs.delete(id); }

const TTL_CLEANUP_INTERVAL_MS = 5 * 60_000;   // run every 5 min
const STALE_THRESHOLD_MS      = 15 * 60_000;  // expire entries older than 15 min

/** Start the background TTL cleanup job. Call once on bot startup. */
export function startCallbackMapCleanup(): void {
  setInterval(() => {
    const cutoff = Date.now() - STALE_THRESHOLD_MS;

    // OTP callbacks
    for (const [id, ts] of _otpTs) {
      if (ts < cutoff) {
        const cb = pendingOtpCallbacks.get(id);
        pendingOtpCallbacks.delete(id);
        _otpTs.delete(id);
        // Also purge from activeOtpFlow
        for (const [uid, list] of activeOtpFlow) {
          const idx = list.indexOf(id);
          if (idx !== -1) {
            list.splice(idx, 1);
            if (!list.length) activeOtpFlow.delete(uid);
          }
        }
        if (cb) { try { cb(null); } catch {} }
        logger.warn({ flowId: id }, "pendingOtpCallbacks: TTL expired, resolved null");
      }
    }

    // Step6 callbacks
    for (const [id, ts] of _s6Ts) {
      if (ts < cutoff) {
        const cb = pendingStep6Callbacks.get(id);
        pendingStep6Callbacks.delete(id);
        _s6Ts.delete(id);
        if (cb) { try { cb("step6_timeout"); } catch {} }
        logger.warn({ flowId: id }, "pendingStep6Callbacks: TTL expired, resolved step6_timeout");
      }
    }

    // Card retry callbacks
    for (const [id, ts] of _crTs) {
      if (ts < cutoff) {
        const cb = pendingCardRetryCallbacks.get(id);
        pendingCardRetryCallbacks.delete(id);
        _crTs.delete(id);
        if (cb) { try { cb("cancel"); } catch {} }
        logger.warn({ attemptId: id }, "pendingCardRetryCallbacks: TTL expired, resolved cancel");
      }
    }
  }, TTL_CLEANUP_INTERVAL_MS).unref();
}

// ── OTP flow helpers ──────────────────────────────────────────────────────────
export const addActiveOtpFlow = (operatorId: number, flowId: string) => {
  const list = activeOtpFlow.get(operatorId) ?? [];
  list.push(flowId);
  activeOtpFlow.set(operatorId, list);
};
export const removeActiveOtpFlow = (operatorId: number, flowId: string) => {
  const list = activeOtpFlow.get(operatorId);
  if (!list) return;
  const idx = list.indexOf(flowId);
  if (idx !== -1) list.splice(idx, 1);
  if (list.length === 0) activeOtpFlow.delete(operatorId);
};

// ── Keyboard builders ─────────────────────────────────────────────────────────
export function mainMenuKeyboard(showLogin = false): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("Holat", "menu_status").icon(EID.STATS).primary()
    .text("Raqam olish", "menu_getnumber").icon(EID.PHONE).success()
    .row()
    .text("Sessiyalar", "menu_list").icon(EID.FOLDER).primary()
    .text("Kartalar", "menu_cards").icon(EID.CARD).primary()
    .row();
  if (showLogin) {
    kb.text("Login", "menu_login").icon(EID.KEY).success()
      .text("Karta qo'shish", "menu_addcard").icon(EID.ADD).success()
      .row();
  } else {
    kb.text("Karta qo'shish", "menu_addcard").icon(EID.ADD).success()
      .row();
  }
  kb.text("Premium olish", "menu_getpremium").icon(EID.STAR).primary();
  return kb;
}

export function menuButton(): InlineKeyboard {
  return new InlineKeyboard().text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
}

export function countPickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1 ta", "batch_count:1").primary()
    .text("3 ta", "batch_count:3").primary()
    .text("5 ta", "batch_count:5").primary()
    .row()
    .text("10 ta", "batch_count:10").primary()
    .text("20 ta", "batch_count:20").primary()
    .row()
    .text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
}

export function premiumPickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1 ta", "batch_premium:1").primary()
    .text("5 ta", "batch_premium:5").primary()
    .text("10 ta", "batch_premium:10").primary()
    .row()
    .text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
}

export function cardUsagePickerKeyboard(sessionCount: number, usedIn3Days: number, cardId: number): InlineKeyboard {
  const remaining = Math.max(0, 5 - usedIn3Days);
  const kb = new InlineKeyboard();
  for (let n = 1; n <= 5; n++) {
    const allowed = n <= remaining;
    if (allowed) {
      kb.text(`${n} ta`, `batch_premium_run:${sessionCount}:${n}:${cardId}`).success();
    } else {
      kb.text(`${n} ✗`, `card_limit_exceeded`).danger();
    }
  }
  return kb.row()
    .text("Kartalar", `batch_premium:${sessionCount}`).icon(EID.CARD).primary()
    .text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
}

// ── sendMainMenu (async — uses isAnySuperAdmin to show Login button for DB SAs) ─
export async function sendMainMenu(
  ctx: { reply: (t: string, o?: any) => Promise<any> },
  userId: number,
): Promise<void> {
  const showLogin = await isAnySuperAdmin(userId);
  await ctx.reply(
    `${E.ROBOT} <b>Userbot Manager</b>\n\nQuyidagi tugmalardan birini tanlang:`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard(showLogin) },
  );
}

// ── Provider bot helpers ───────────────────────────────────────────────────────
export async function getActiveBots(): Promise<string[]> {
  const rows = await db.select().from(providerBots).where(eq(providerBots.isActive, true));
  if (rows.length === 0) {
    await db.insert(providerBots).values({ username: DEFAULT_REPREAM_BOT, isActive: true }).onConflictDoNothing();
    return [DEFAULT_REPREAM_BOT];
  }
  return rows.map((r) => r.username);
}

export async function getFreestBot(): Promise<string> {
  const active = await db.select().from(providerBots).where(eq(providerBots.isActive, true));
  if (active.length === 0) {
    await db.insert(providerBots).values({ username: DEFAULT_REPREAM_BOT, isActive: true }).onConflictDoNothing();
    return DEFAULT_REPREAM_BOT;
  }
  if (active.length === 1) return active[0].username;

  const busyRows = await db
    .select({ providerBot: pendingNumbers.providerBot })
    .from(pendingNumbers)
    .where(eq(pendingNumbers.status, "waiting"));

  const busyCount = new Map<string, number>();
  for (const row of busyRows) {
    if (row.providerBot) busyCount.set(row.providerBot, (busyCount.get(row.providerBot) ?? 0) + 1);
  }

  let best = active[0].username;
  let bestCount = busyCount.get(best) ?? 0;
  for (const bot of active.slice(1)) {
    const cnt = busyCount.get(bot.username) ?? 0;
    if (cnt < bestCount) { best = bot.username; bestCount = cnt; }
  }
  return best;
}

export async function getOperatorSource(uid: number): Promise<string> {
  const selected = operatorSelectedSource.get(uid);
  if (selected) {
    const rows = await db
      .select()
      .from(providerBots)
      .where(and(eq(providerBots.username, selected), eq(providerBots.isActive, true)));
    if (rows.length > 0) return selected;
    operatorSelectedSource.delete(uid);
  }
  const active = await db.select().from(providerBots).where(eq(providerBots.isActive, true));
  if (active.length === 0) {
    await db.insert(providerBots).values({ username: DEFAULT_REPREAM_BOT, isActive: true }).onConflictDoNothing();
    return DEFAULT_REPREAM_BOT;
  }
  return active[0].username;
}

export async function getDefaultVerifierBot(): Promise<string> {
  const rows = await db.select().from(verifierBots).where(eq(verifierBots.isActive, true));
  if (rows.length === 0) {
    await db.insert(verifierBots).values({ username: REPREAM_BOT, isDefault: true, isActive: true }).onConflictDoNothing();
    return REPREAM_BOT;
  }
  const defaultBot = rows.find((r) => r.isDefault) ?? rows[0];
  return defaultBot.username;
}

// ── Card helpers ──────────────────────────────────────────────────────────────
export async function getDefaultCard(userId: number): Promise<PremiumCardData | undefined> {
  const cards = await db
    .select()
    .from(savedCards)
    .where(and(eq(savedCards.userId, userId), eq(savedCards.isDefault, true)))
    .limit(1);
  if (!cards.length) return undefined;
  return {
    cardNumber: cards[0].cardNumber,
    expiry: cards[0].expiry,
    cvv: cards[0].cvv,
    cardHolder: cards[0].cardHolder,
  };
}

// ── Session ownership guard ───────────────────────────────────────────────────
export async function claimUserbotSession(
  phone: string,
  sessionString: string,
  ownerId: number,
): Promise<{ ok: true } | { ok: false; ownerId: number }> {
  const existing = await db
    .select({ ownerId: userbotSessions.ownerId })
    .from(userbotSessions)
    .where(eq(userbotSessions.phone, phone))
    .limit(1);
  if (existing.length && existing[0].ownerId != null && existing[0].ownerId !== ownerId) {
    return { ok: false, ownerId: existing[0].ownerId };
  }
  await db
    .insert(userbotSessions)
    .values({ phone, sessionString, status: "active", ownerId })
    .onConflictDoUpdate({
      target: userbotSessions.phone,
      set: { sessionString, status: "active", ownerId },
    });
  return { ok: true };
}

// ── Status builder ────────────────────────────────────────────────────────────
export async function buildOperatorStatusText(operatorId: number): Promise<string> {
  const [client, sessions, masterRows, period] = await Promise.all([
    getMasterClient(operatorId),
    db.select().from(userbotSessions).where(eq(userbotSessions.ownerId, operatorId)),
    db.select({ slot: masterSessions.slot, phone: masterSessions.phone })
      .from(masterSessions)
      .where(eq(masterSessions.operatorId, operatorId))
      .orderBy(asc(masterSessions.slot)),
    getCurrentPeriod(),
  ]);

  const active  = sessions.filter((s) => s.status === "active").length;
  const premium = sessions.filter((s) => s.hasPremium).length;
  const myStats = await getAdminStats(operatorId, period.id);

  let slotLabel: string;
  if (masterRows.length) {
    slotLabel = masterRows.map((r) =>
      masterRows.length > 1
        ? `<code>${r.phone}</code> (slot ${r.slot})`
        : `<code>${r.phone}</code>`,
    ).join(", ");
  } else if (client) {
    const allMaster = await db.select({ phone: masterSessions.phone, sharedWith: masterSessions.sharedWith }).from(masterSessions);
    const sharedRow = allMaster.find((row) => {
      if (!row.sharedWith) return false;
      try { return (JSON.parse(row.sharedWith) as number[]).includes(operatorId); } catch { return false; }
    });
    slotLabel = sharedRow ? `Ulashilgan ${E.SHARE}` : "Ulashilgan";
  } else {
    slotLabel = "Yo'q";
  }

  return (
    `${E.STATS} <b>Holat</b>\n\n` +
    `Operator: ${client ? `${E.OK} Ulangan (${slotLabel})` : `${E.NO} Ulanmagan`}\n` +
    `Userbot sessiyalar: <b>${sessions.length}</b> ta (${active} faol)\n` +
    `${E.STAR} Premium sessiyalar: <b>${premium}</b> ta\n\n` +
    `<b>${E.STATS} Statistika (Davr #${period.id}):</b>\n` +
    `${E.PHONE} Olingan raqamlar: <b>${myStats.numbersGotten}</b>\n` +
    `${E.OK} Yaratilgan sessiyalar: <b>${myStats.sessionsCreated}</b>\n` +
    `${E.NO} Bekor qilingan: <b>${myStats.sessionsCancelled}</b>\n` +
    `${E.STAR} Premium olinganlar: <b>${myStats.premiumsObtained}</b>\n` +
    `${E.CARD} Qo'shilgan kartalar: <b>${myStats.cardsAdded}</b>\n` +
    `${E.KEY} Loginlar: <b>${myStats.logins}</b>`
  );
}

// ── Freeze & sign-in helpers ──────────────────────────────────────────────────
export type PendingRow = {
  id: number;
  phone: string;
  requestedByUserId: number;
  repreamMessageId: number | string | null;
  freezeData: string | null;
  providerBot?: string | null;
};

export async function autoFreezeAndNotify(
  ctx: { reply: (text: string, opts?: any) => Promise<any> },
  row: PendingRow,
  reason: string,
): Promise<void> {
  const botName = row.providerBot ?? DEFAULT_REPREAM_BOT;
  const masterClient = await getMasterClient(row.requestedByUserId);
  if (masterClient && row.repreamMessageId && row.freezeData) {
    try {
      await clickRepreamButton(masterClient, botName, Number(row.repreamMessageId), row.freezeData);
      logger.info({ phone: row.phone, botName }, "Freeze button clicked on provider bot");
    } catch (e) {
      logger.warn({ e }, "Failed to click freeze button");
    }
  }
  await db.update(pendingNumbers).set({ status: "frozen" }).where(eq(pendingNumbers.id, row.id));

  const keyboard = new InlineKeyboard()
    .text("Yangi raqam olish", `getnew:${row.requestedByUserId}`).icon(EID.REFRESH).success()
    .text("Menyu", "menu_home").icon(EID.HOME).primary();

  await ctx.reply(
    `🧊 <b>Raqam freeze qilindi</b>\n\n📱 Raqam: <code>${row.phone}</code>\n❌ Sabab: ${reason}`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

export type SignInRow = { id: number; phone: string };

export async function finishSignInAndDeliverLink(
  ctx: { reply: (text: string, opts?: any) => Promise<any> },
  row: SignInRow,
  sessionString: string,
  userId: number,
  otp: string,
): Promise<void> {
  const claim = await claimUserbotSession(row.phone, sessionString, userId);
  if (!claim.ok) {
    await ctx.reply(
      `⚠️ <code>${row.phone}</code> raqami allaqachon boshqa admin tomonidan olingan. O'tkazib yuborildi.`,
      { parse_mode: "HTML" },
    );
    await db.update(pendingNumbers).set({ status: "frozen" }).where(eq(pendingNumbers.id, row.id));
    return;
  }

  await db.update(pendingNumbers).set({ status: "completed", otpCode: otp }).where(eq(pendingNumbers.id, row.id));
  await recordStat(userId, "getnumber");
  await recordStat(userId, "session_created");

  const card = await getDefaultCard(userId);

  await ctx.reply(
    card
      ? `⏳ @${PREMIUM_BOT} dan havola olinmoqda...\n💳 Karta: ****${card.cardNumber.slice(-4)} bilan to'lov amalga oshiriladi`
      : `⏳ @${PREMIUM_BOT} dan havola olinmoqda...\n⚠️ Karta saqlanmagan — to'lov o'tkazib yuboriladi`,
  );

  const link = await getLinkFromPremiumBot(sessionString, row.phone, PREMIUM_BOT, card);

  if (link) {
    await db.update(userbotSessions).set({ telegramLink: link }).where(eq(userbotSessions.phone, row.phone));
    await ctx.reply(
      `✅ <b>Muvaffaqiyat!</b>\n\n📱 Raqam: <code>${row.phone}</code>\n🔗 Havola: ${link}`,
      { parse_mode: "HTML", reply_markup: menuButton() },
    );
  } else {
    await ctx.reply(
      `✅ <b>Sessiya yaratildi!</b>\n\n📱 Raqam: <code>${row.phone}</code>\n⚠️ @${PREMIUM_BOT} dan havola olinmadi.`,
      { parse_mode: "HTML", reply_markup: menuButton() },
    );
  }
}
