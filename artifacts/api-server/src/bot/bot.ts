import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import {
  masterSessions,
  pendingAuthStates,
  pendingNumbers,
  userbotSessions,
  savedCards,
  providerBots,
  verifierBots,
  admins,
  cardUsages,
} from "@workspace/db";
import { eq, and, desc, gte, asc, ne } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import {
  getMasterClient,
  startMasterLogin,
  resendCodeForPhone,
  removeMasterSession,
  completeMasterLoginCode,
  completeMasterLogin2FA,
  TwoFARequiredError,
  sendCommandAndWaitForNumber,
  clickRepreamButton,
  waitForRepreamMessage,
  waitForRepreamCode,
  sendCodeForPhone,
  signInWithCodeAndPass,
  getLinkFromPremiumBot,
  parseRepreamCodeMessage,
  createClientFromSession,
  releaseSignedInClient,
  isSessionInvalidError,
  markUserbotSessionInvalid,
  verifyAndPurgeDeadSessions,
} from "./client.js";
import {
  runFullPremiumFlow,
  FlowRestartError,
  FlowAbortError,
  FlowStep6TimeoutError,
  setOnProxyExhausted,
  pollPremiumActiveViaStart,
} from "./premium.js";
import { withTimeout } from "../lib/timeout.js";
import { E, EID } from "../lib/emoji.js";
import {
  isActiveAdmin,
  isSuperAdmin,
  isAnySuperAdmin,
  ensureSuperAdminSeeded,
  recordStat,
  getAdminStats,
  getCurrentPeriod,
  registerSuperAdminCommands,
} from "./super-admin.js";
import { initNotify, notifyError } from "./notify.js";

// In development we must NOT poll with the same token as production — both
// processes would compete for Telegram's single getUpdates consumer per
// token, and since each process keeps its own in-memory flow state (pending
// login/OTP/step6 callbacks) and its own database, a real user's multi-step
// flow (login code entry, OTP, batch premium) can randomly get split across
// the two processes and break. DEV_BOT_TOKEN (a separate @BotFather bot used
// only for local testing) keeps dev traffic completely isolated from prod.
function resolveBotToken(): string {
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    const devToken = process.env.DEV_BOT_TOKEN;
    if (devToken) return devToken;
    logger.warn(
      "DEV_BOT_TOKEN not set — falling back to BOT_TOKEN in development. " +
        "This means dev and production will poll the same bot and can interfere " +
        "with real user flows. Set DEV_BOT_TOKEN to a separate @BotFather bot.",
    );
  }
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN env var is required");
  return token;
}

export function createBot() {
  const BOT_TOKEN = resolveBotToken();

  const DEFAULT_REPREAM_BOT = (process.env.REPREAM_BOT || "RePreAmooBot").replace(/^@/, "");
  const REPREAM_BOT = DEFAULT_REPREAM_BOT;
  const PREMIUM_BOT = (process.env.PREMIUM_BOT || "premiumbot").replace(/^@/, "");

  // ── Reliability limits (anti-freeze) ─────────────────────────────────────────
  // Auto-continue a 3DS wait after this long so a never-pressed button can't
  // freeze a premium flow; cap restart loops so "Evro" can't loop forever.
  const MAX_PREMIUM_RESTARTS = 5;
  // Absolute backstop for a single premium attempt. Every network step already
  // has its own inner timeout; this only fires if something with no inner bound
  // wedges, guaranteeing the attempt's finally blocks run so all locks, pending
  // callbacks and clients are released and the next purchase works without a restart.
  const PREMIUM_FLOW_TOTAL_TIMEOUT = 20 * 60 * 1000;

  // Returns active provider bots from DB; seeds from env on first run
  async function getActiveBots(): Promise<string[]> {
    const rows = await db.select().from(providerBots).where(eq(providerBots.isActive, true));
    if (rows.length === 0) {
      // First run — seed default bot
      await db
        .insert(providerBots)
        .values({ username: DEFAULT_REPREAM_BOT, isActive: true })
        .onConflictDoNothing();
      return [DEFAULT_REPREAM_BOT];
    }
    return rows.map((r) => r.username);
  }

  // Returns the least-busy active provider bot (parallel mode).
  // Each operator gets a different bot if possible — picks the one with
  // the fewest active "waiting" pendingNumbers sessions.
  async function getFreestBot(): Promise<string> {
    const active = await db
      .select()
      .from(providerBots)
      .where(eq(providerBots.isActive, true));

    if (active.length === 0) {
      await db
        .insert(providerBots)
        .values({ username: DEFAULT_REPREAM_BOT, isActive: true })
        .onConflictDoNothing();
      return DEFAULT_REPREAM_BOT;
    }

    if (active.length === 1) return active[0].username;

    // Count how many "waiting" sessions each bot currently holds
    const busyRows = await db
      .select({ providerBot: pendingNumbers.providerBot })
      .from(pendingNumbers)
      .where(eq(pendingNumbers.status, "waiting"));

    const busyCount = new Map<string, number>();
    for (const row of busyRows) {
      if (row.providerBot) {
        busyCount.set(row.providerBot, (busyCount.get(row.providerBot) ?? 0) + 1);
      }
    }

    // Pick the bot with the fewest active sessions (0 wins immediately)
    let best = active[0].username;
    let bestCount = busyCount.get(best) ?? 0;
    for (const bot of active.slice(1)) {
      const cnt = busyCount.get(bot.username) ?? 0;
      if (cnt < bestCount) {
        best = bot.username;
        bestCount = cnt;
      }
    }
    logger.debug({ best, busyCount: Object.fromEntries(busyCount) }, "getFreestBot selected");
    return best;
  }

  // ── Operator check: DB-based (admins table) + legacy env-var fallback ─────────
  const rawLegacyIds = process.env.OPERATOR_USER_IDS ?? "";
  const LEGACY_IDS = new Set(
    rawLegacyIds.split(",").map((s) => s.trim()).filter(Boolean).map(Number),
  );
  const isOperator = async (userId: number): Promise<boolean> => {
    if (isSuperAdmin(userId)) return true;
    if (LEGACY_IDS.has(userId)) return true;
    return isActiveAdmin(userId);
  };

  // Seed super admin on startup
  ensureSuperAdminSeeded().catch((err) =>
    logger.error({ err }, "ensureSuperAdminSeeded failed"),
  );

  const bot = new Bot(BOT_TOKEN);

  // ── Error notification → super admin ─────────────────────────────────────────
  {
    const saId = Number(process.env.SUPER_ADMIN_ID);
    if (saId) {
      initNotify(async (msg) => {
        await bot.api.sendMessage(saId, msg, { parse_mode: "HTML" });
      });
    }
  }

  // ── Proxy exhaustion notification → super admin ───────────────────────────────
  {
    const rawSA = process.env.SUPER_ADMIN_ID ?? "";
    const saIds = rawSA.split(",").map((s) => Number(s.trim())).filter(Boolean);
    setOnProxyExhausted(async () => {
      for (const id of saIds) {
        await bot.api.sendMessage(
          id,
          `⚠️ <b>Proksi IP lar to'ldi!</b>\n\n` +
          `Barcha IP lar limitga yetdi — Webshare API ga o'tildi.\n\n` +
          `🔄 Davom ettirish uchun:\n` +
          `/superadmin → 🌐 Proksi IP → 🔄 Hammasini qayta boshlash`,
          { parse_mode: "HTML" },
        ).catch(() => {});
      }
    });
  }

  // ── Per-operator batch lock (prevents overlapping waitForRepreamMessage) ──────
  const batchRunning = new Set<number>();

  // ── Per-operator batch-premium lock ──────────────────────────────────────────
  const batchPremiumRunning = new Set<number>();

  // ── Global per-session premium lock (phone → true) ───────────────────────────
  // Prevents two operators from running a premium flow on the same session at once.
  const activePremiumSessions = new Set<string>();

  // ── Session ownership guard ───────────────────────────────────────────────────
  // A phone number's provider (e.g. @RepreamBot) should never hand out a number
  // that's already claimed by another admin, but if it ever did — or an admin
  // manually re-logs a number someone else already owns — this stops the login
  // from silently overwriting the existing owner's session row. Instead of a
  // last-write-wins overwrite (which would erase the first admin's session and
  // reassign it without anyone noticing), the newer login is rejected.
  const claimUserbotSession = async (
    phone: string,
    sessionString: string,
    ownerId: number,
  ): Promise<{ ok: true } | { ok: false; ownerId: number }> => {
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
  };

  // ── Pending 3DS OTP callbacks ─────────────────────────────────────────────────
  // Each premium flow gets a unique flowId so concurrent flows don't overwrite
  // each other's callbacks.
  // pendingOtpCallbacks : flowId → resolve function
  // activeOtpFlow       : operatorId → ordered list of pending flowIds (FIFO)
  // With limited-concurrency batch runs, more than one session can be waiting
  // on a typed OTP code from the same operator at once. A code typed by the
  // operator is routed to the OLDEST still-pending flow — a reasonable
  // heuristic since that OTP prompt was shown to the operator first.
  const pendingOtpCallbacks = new Map<string, (otp: string | null) => void>();
  const activeOtpFlow = new Map<number, string[]>(); // operatorId → flowIds (FIFO)

  const addActiveOtpFlow = (operatorId: number, flowId: string) => {
    const list = activeOtpFlow.get(operatorId) ?? [];
    list.push(flowId);
    activeOtpFlow.set(operatorId, list);
  };
  const removeActiveOtpFlow = (operatorId: number, flowId: string) => {
    const list = activeOtpFlow.get(operatorId);
    if (!list) return;
    const idx = list.indexOf(flowId);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) activeOtpFlow.delete(operatorId);
  };

  // pendingStep6Callbacks : flowId → resolve('restart' | 'abort' | 'continue')
  const pendingStep6Callbacks = new Map<string, (choice: "restart" | "abort" | "continue" | "step6_timeout") => void>();

  // ── Pending "choose another card" callbacks ─────────────────────────────────
  // After a PAYMENT_FAILED decline, the operator is offered their other saved
  // cards to retry the same target with instead of an automatic hard failure.
  // pendingCardRetryCallbacks : attemptId → resolve(cardId | 'cancel')
  const pendingCardRetryCallbacks = new Map<string, (choice: number | "cancel") => void>();

  // ── Main menu keyboard ────────────────────────────────────────────────────────
  // showLogin: true only for super admins — Login section is SA-exclusive.
  function mainMenuKeyboard(showLogin = false) {
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

  // Premium emoji shorthand for common statuses used in HTML messages
  const ok  = E.OK;
  const no  = E.NO;
  const star = E.STAR;

  // In-memory state: users awaiting text input for adding verifier bots
  const awaitingVerifierInput = new Set<number>();

  // Per-operator manually selected source bot (overrides auto-selection)
  const operatorSelectedSource = new Map<number, string>();

  // Returns the operator's chosen source bot; verifies it's still active.
  // Falls back to the first active bot if the selection is stale or unset.
  async function getOperatorSource(uid: number): Promise<string> {
    const selected = operatorSelectedSource.get(uid);
    if (selected) {
      const rows = await db
        .select()
        .from(providerBots)
        .where(and(eq(providerBots.username, selected), eq(providerBots.isActive, true)));
      if (rows.length > 0) return selected;
      operatorSelectedSource.delete(uid); // stale — clear it
    }
    // Fall back to first active bot
    const active = await db.select().from(providerBots).where(eq(providerBots.isActive, true));
    if (active.length === 0) {
      await db.insert(providerBots).values({ username: DEFAULT_REPREAM_BOT, isActive: true }).onConflictDoNothing();
      return DEFAULT_REPREAM_BOT;
    }
    return active[0].username;
  }

  // Returns the active default verifier bot username, seeding from env on first run.
  async function getDefaultVerifierBot(): Promise<string> {
    const rows = await db
      .select()
      .from(verifierBots)
      .where(eq(verifierBots.isActive, true));

    if (rows.length === 0) {
      // First run — seed from env
      await db
        .insert(verifierBots)
        .values({ username: REPREAM_BOT, isDefault: true, isActive: true })
        .onConflictDoNothing();
      return REPREAM_BOT;
    }

    // Prefer the one marked as default; fall back to first active
    const defaultBot = rows.find((r) => r.isDefault) ?? rows[0];
    return defaultBot.username;
  }

  function menuButton() {
    return new InlineKeyboard().text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
  }

  function countPickerKeyboard() {
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

  function premiumPickerKeyboard() {
    return new InlineKeyboard()
      .text("1 ta", "batch_premium:1").primary()
      .text("5 ta", "batch_premium:5").primary()
      .text("10 ta", "batch_premium:10").primary()
      .row()
      .text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
  }

  // Card usage picker: how many subscriptions to buy with THIS specific card (1–5, 3-day limit)
  function cardUsagePickerKeyboard(sessionCount: number, usedIn3Days: number, cardId: number) {
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

  async function sendMainMenu(ctx: { reply: (t: string, o?: any) => Promise<any> }, userId: number) {
    await ctx.reply(
      `${E.ROBOT} <b>Userbot Manager</b>\n\nQuyidagi tugmalardan birini tanlang:`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard(isSuperAdmin(userId)) },
    );
  }

  // ── Register super admin commands ─────────────────────────────────────────────
  registerSuperAdminCommands(bot);

  // ── /start ────────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    if (!(await isOperator(ctx.from.id))) {
      await ctx.reply("❌ Bu bot faqat operatorlar uchun.");
      return;
    }
    await sendMainMenu(ctx, ctx.from.id);
  });

  // ── /menu ─────────────────────────────────────────────────────────────────────
  bot.command("menu", async (ctx) => {
    if (!ctx.from || !(await isOperator(ctx.from.id))) return;
    await sendMainMenu(ctx, ctx.from.id);
  });

  // ── Operator-only middleware ──────────────────────────────────────────────────
  // All commands require operator access. Login commands are SA-only and guarded
  // in their own handlers — there is no longer a self-registration flow.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !(await isOperator(userId))) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery("❌ Ruxsat yo'q.").catch(() => {});
      else if (ctx.message) await ctx.reply("❌ Bu bot faqat operatorlar uchun.");
      return;
    }
    // Keep firstName/username fresh — fire-and-forget, never blocks the handler
    const from = ctx.from!;
    db.update(admins)
      .set({
        username:  from.username  ?? null,
        firstName: from.first_name ?? null,
      })
      .where(eq(admins.telegramUserId, userId))
      .catch(() => {});
    return next();
  });

  // ── 3DS OTP intercept ─────────────────────────────────────────────────────────
  // Must run BEFORE other text handlers so an OTP code isn't mistaken for a
  // command or phone number.  Only intercepts if this operator has a pending
  // OTP request AND the message looks like a 4-8 digit code.
  bot.on("message:text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const pending = activeOtpFlow.get(userId);
    if (!pending || pending.length === 0) return next();
    const flowId = pending[0]; // oldest pending flow (FIFO)
    const resolve = pendingOtpCallbacks.get(flowId);
    if (!resolve) {
      removeActiveOtpFlow(userId, flowId); // stale entry — drop and fall through
      return next();
    }
    const text = ctx.message.text.trim();
    if (!/^\d{4,8}$/.test(text)) return next(); // not a code — pass through
    // Consume the OTP: remove both maps, resolve the waiting promise
    try {
      pendingOtpCallbacks.delete(flowId);
      removeActiveOtpFlow(userId, flowId);
      resolve(text);
      await ctx.reply("✅ Kod qabul qilindi, 3DS tekshirilmoqda...").catch(() => {});
    } catch (err) {
      logger.error({ err }, "OTP intercept handler error");
      await notifyError(err, "OTP intercept handler error");
    }
    // Don't call next() — message is consumed
  });

  // ── Step-6 "Evro ekan" / "Bekor qilish" buttons ─────────────────────────────
  // Tolerant of stale/duplicate presses: if the flow already finished (no
  // resolver in the Map) we still answer with a friendly toast and strip the
  // now-dead keyboard so the operator can't keep pressing it.
  bot.callbackQuery(/^step6_euro:(.+)$/, async (ctx) => {
    const flowId = ctx.match[1];
    const resolve = pendingStep6Callbacks.get(flowId);
    // Claim AND settle synchronously so flow progression is never gated on Bot API
    // latency: a hung answerCallbackQuery must not leave step6Promise pending
    // (the auto-continue timer rescue is already disabled once we claim).
    if (resolve) {
      pendingStep6Callbacks.delete(flowId);
      resolve("restart");
    }
    // Fire-and-forget UX cleanup — never await; a slow/hung Bot API call here must
    // not stall the premium flow.
    ctx.answerCallbackQuery(resolve ? "🔄 Qaytadan boshlanmoqda..." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.callbackQuery(/^step6_done:(.+)$/, async (ctx) => {
    const flowId = ctx.match[1];
    const resolve = pendingStep6Callbacks.get(flowId);
    // Claim AND settle synchronously so flow progression is never gated on Bot API latency.
    if (resolve) {
      pendingStep6Callbacks.delete(flowId);
      resolve("continue");
    }
    // Fire-and-forget UX cleanup — never await.
    ctx.answerCallbackQuery(resolve ? "✅ Davom etilmoqda..." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.callbackQuery(/^step6_abort:(.+)$/, async (ctx) => {
    const flowId = ctx.match[1];
    const resolve = pendingStep6Callbacks.get(flowId);
    // Claim AND settle synchronously so flow progression is never gated on Bot API latency.
    if (resolve) {
      pendingStep6Callbacks.delete(flowId);
      resolve("abort");
    }
    // Fire-and-forget UX cleanup — never await.
    ctx.answerCallbackQuery(resolve ? "❌ Bekor qilindi." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // ── "Boshqa karta bilan urinish" buttons (after PAYMENT_FAILED) ─────────────
  bot.callbackQuery(/^card_retry:(.+):(\d+)$/, async (ctx) => {
    const attemptId = ctx.match[1];
    const cardId = Number(ctx.match[2]);
    const resolve = pendingCardRetryCallbacks.get(attemptId);
    if (resolve) {
      pendingCardRetryCallbacks.delete(attemptId);
      resolve(cardId);
    }
    ctx.answerCallbackQuery(resolve ? "🔄 Boshqa karta bilan qayta urinilmoqda..." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.callbackQuery(/^card_retry_cancel:(.+)$/, async (ctx) => {
    const attemptId = ctx.match[1];
    const resolve = pendingCardRetryCallbacks.get(attemptId);
    if (resolve) {
      pendingCardRetryCallbacks.delete(attemptId);
      resolve("cancel");
    }
    ctx.answerCallbackQuery(resolve ? "❌ Bekor qilindi." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // ── Shared status builder ─────────────────────────────────────────────────────
  async function buildOperatorStatusText(operatorId: number): Promise<string> {
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

    // For regular operators: own masterSessions rows are empty — find shared phone
    let slotLabel: string;
    if (masterRows.length) {
      slotLabel = masterRows.map((r) =>
        masterRows.length > 1
          ? `<code>${r.phone}</code> (slot ${r.slot})`
          : `<code>${r.phone}</code>`,
      ).join(", ");
    } else if (client) {
      // Shared session — find which SA shared with this operator
      const allMaster = await db.select({ phone: masterSessions.phone, sharedWith: masterSessions.sharedWith })
        .from(masterSessions);
      const sharedRow = allMaster.find((row) => {
        if (!row.sharedWith) return false;
        try { return (JSON.parse(row.sharedWith) as number[]).includes(operatorId); }
        catch { return false; }
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

  // ── /status ───────────────────────────────────────────────────────────────────
  bot.command("status", async (ctx) => {
    const text = await buildOperatorStatusText(ctx.from!.id);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: menuButton() });
  });

  // ── /login ────────────────────────────────────────────────────────────────────
  // Restricted to super admins — up to 3 slots per SA.
  bot.command("login", async (ctx) => {
    const operatorId = ctx.from!.id;
    if (!await isAnySuperAdmin(operatorId)) {
      await ctx.reply(`${E.NO} Bu buyruq faqat super admin uchun.`, { parse_mode: "HTML" });
      return;
    }

    const phone = ctx.match?.trim();
    if (!phone) {
      await ctx.reply(
        `${E.INFO} Telefon raqam kiriting:\n/login <code>+998901234567</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // ── Find first free slot (1–3) ──────────────────────────────────────────
    const ownRows = await db
      .select({ slot: masterSessions.slot, phone: masterSessions.phone })
      .from(masterSessions)
      .where(eq(masterSessions.operatorId, operatorId))
      .orderBy(asc(masterSessions.slot));

    const usedSlots = new Set(ownRows.map(r => r.slot));
    const slot = [1, 2, 3].find(s => !usedSlots.has(s));
    if (!slot) {
      await ctx.reply(
        `${E.NO} Barcha 3 ta slot band.\n\nAvval birini o'chirish uchun Login menyusiga boring:`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
      );
      return;
    }

    // ── Guard: this phone must not already be linked in any slot ───────────
    const phoneConflict = await db
      .select({ slot: masterSessions.slot })
      .from(masterSessions)
      .where(eq(masterSessions.phone, phone))
      .limit(1);
    if (phoneConflict.length) {
      await ctx.reply(
        `${E.ALERT} <code>${phone}</code> allaqachon ulangan (Slot ${phoneConflict[0].slot}).\n\nHar bir slot uchun alohida raqam kerak.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    try {
      await ctx.reply(`${E.CLOCK} Slot ${slot} — kod yuborilmoqda...`, { parse_mode: "HTML" });
      const { phoneCodeHash, codeType, autoCode } = await startMasterLogin(phone, operatorId, slot);

      // ── Auto-login: code read from existing session ───────────────────────
      if (autoCode) {
        await ctx.reply(`${E.REFRESH} <b>${phone}</b> — mavjud sessiondan kod o'qildi, kirilmoqda...`, { parse_mode: "HTML" });
        try {
          const sessionString = await completeMasterLoginCode(phone, autoCode, phoneCodeHash, operatorId, slot);
          await db
            .insert(masterSessions)
            .values({ operatorId, slot, phone, sessionString })
            .onConflictDoUpdate({
              target: [masterSessions.operatorId, masterSessions.slot],
              set: { phone, sessionString },
            });
          await db.delete(pendingAuthStates).where(
            and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)),
          );
          await ctx.reply(
            `${E.OK} <b>Slot ${slot}:</b> <code>${phone}</code> muvaffaqiyatli ulandi!`,
            { parse_mode: "HTML", reply_markup: mainMenuKeyboard(true) },
          );
        } catch (autoErr: any) {
          // 2FA required — fall through to manual flow
          if (autoErr instanceof TwoFARequiredError) {
            await db.delete(pendingAuthStates).where(
              and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)),
            );
            await db.insert(pendingAuthStates).values({ userId: operatorId, slot, phone, phoneCodeHash, step: "2fa" });
            await ctx.reply(
              `${E.LOCK} <b>2FA parol kerak!</b>\n\nParolingizni kiriting:\n/2fa <code>parolingiz</code>`,
              { parse_mode: "HTML" },
            );
          } else {
            throw autoErr;
          }
        }
        return;
      }

      // ── Manual flow: user must type /code ────────────────────────────────
      await db.delete(pendingAuthStates).where(
        and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)),
      );
      await db.insert(pendingAuthStates).values({
        userId: operatorId,
        slot,
        phone,
        phoneCodeHash,
        step: "code",
      });

      const codeDestHint =
        codeType === "SentCodeTypeApp"
          ? `${E.PHONE} Kod <b>Telegram ilovangizga</b> yuborildi — telefondagi Telegram dasturini oching, u yerda Telegram xizmatidan xabar keladi.`
          : codeType === "SentCodeTypeSms"
          ? `${E.ANNOUNCE} Kod <b>SMS</b> orqali yuborildi.`
          : codeType === "SentCodeTypeCall"
          ? `${E.PHONE} Kod <b>telefon qo'ng'irog'i</b> orqali keladi.`
          : `${E.ANNOUNCE} Kod yuborildi (tur: <code>${codeType}</code>).`;

      await ctx.reply(
        `${E.OK} Slot ${slot} — kod <b>${phone}</b> ga yuborildi.\n\n${codeDestHint}\n\nKelgan kodni yuboring:\n/code <code>KELGAN_KOD</code>`,
        { parse_mode: "HTML" },
      );
    } catch (err: any) {
      logger.error({ err }, "login command error");
      const waitMatch = err?.message?.match(/wait of (\d+) seconds/i) || err?.seconds;
      if (waitMatch) {
        const secs = typeof waitMatch === "number" ? waitMatch : parseInt(waitMatch[1] ?? "0");
        const hours = Math.floor(secs / 3600);
        const mins  = Math.floor((secs % 3600) / 60);
        await ctx.reply(
          `${E.CLOCK} <b>Telegram FLOOD_WAIT</b>\n\nBu raqamga yoki bu API dan juda ko'p kod so'rovi yuborildi.\n\n` +
          `Kutish vaqti: <b>${hours > 0 ? `${hours} soat ` : ""}${mins} daqiqa</b>\n\n` +
          `Boshqa raqam sinab ko'ring yoki kutib turing.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      await notifyError(err, "login command error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });

  // ── /code ─────────────────────────────────────────────────────────────────────
  bot.command("code", async (ctx) => {
    const operatorId = ctx.from!.id;
    if (!await isAnySuperAdmin(operatorId)) {
      await ctx.reply(`${E.NO} Bu buyruq faqat super admin uchun.`, { parse_mode: "HTML" });
      return;
    }

    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply("❌ /code <code>12345</code> formatida yuboring", { parse_mode: "HTML" });
      return;
    }

    const authStates = await db
      .select()
      .from(pendingAuthStates)
      .where(eq(pendingAuthStates.userId, operatorId))
      .orderBy(desc(pendingAuthStates.createdAt))
      .limit(1);

    if (!authStates.length) {
      await ctx.reply("❌ Avval /login buyrug'ini yuboring.");
      return;
    }

    const { phone, phoneCodeHash, slot } = authStates[0];

    try {
      await ctx.reply(`${E.CLOCK} Kirilmoqda...`, { parse_mode: "HTML" });
      const sessionString = await completeMasterLoginCode(phone, code, phoneCodeHash, operatorId, slot);

      await db
        .insert(masterSessions)
        .values({ operatorId, slot, phone, sessionString })
        .onConflictDoUpdate({
          target: [masterSessions.operatorId, masterSessions.slot],
          set: { phone, sessionString },
        });
      await db.delete(pendingAuthStates).where(
        and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)),
      );

      await recordStat(operatorId, "login");
      await ctx.reply(
        `${E.OK} <b>Slot ${slot}:</b> <code>${phone}</code> muvaffaqiyatli ulandi!`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard(true) },
      );
    } catch (err: any) {
      if (err instanceof TwoFARequiredError) {
        await db
          .update(pendingAuthStates)
          .set({ step: "2fa" })
          .where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
        await ctx.reply(
          `${E.LOCK} <b>2FA parol kerak!</b>\n\nHisobingizda ikki bosqichli tasdiqlash yoqilgan.\n\nParolingizni kiriting:\n/2fa <code>parolingiz</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      if (err?.errorMessage === "PHONE_CODE_INVALID" || err?.message?.includes("PHONE_CODE_INVALID")) {
        await ctx.reply(
          `${E.NO} <b>Kod noto'g'ri.</b>\n\n` +
          "Mumkin sabablar:\n" +
          "• Kod raqamlari noto'g'ri kiritildi\n" +
          "• Telegram ilovadagi so'nggi kodni oling (eski kod emas)\n\n" +
          "Qaytadan urinib ko'ring: /login",
          { parse_mode: "HTML" },
        );
        return;
      }
      if (err?.errorMessage === "PHONE_CODE_EXPIRED" || err?.message?.includes("PHONE_CODE_EXPIRED")) {
        await ctx.reply(
          `${E.CLOCK} <b>Kod muddati o'tgan.</b>\n\nYangi kod olish uchun: /login`,
          { parse_mode: "HTML" },
        );
        return;
      }
      logger.error({ err }, "code command error");
      await notifyError(err, "code command error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });

  // ── /resendcode ───────────────────────────────────────────────────────────────
  bot.command("resendcode", async (ctx) => {
    const operatorId = ctx.from!.id;
    if (!await isAnySuperAdmin(operatorId)) {
      await ctx.reply(`${E.NO} Bu buyruq faqat super admin uchun.`, { parse_mode: "HTML" });
      return;
    }

    const authStates = await db
      .select()
      .from(pendingAuthStates)
      .where(eq(pendingAuthStates.userId, operatorId))
      .orderBy(desc(pendingAuthStates.createdAt))
      .limit(1);

    if (!authStates.length || authStates[0].step !== "code") {
      await ctx.reply("❌ Faol login so'rovi topilmadi. Avval /login yuboring.");
      return;
    }

    const { phone, phoneCodeHash, slot } = authStates[0];
    await ctx.reply(`${E.CLOCK} Kod qayta yuborilmoqda...`, { parse_mode: "HTML" });
    void (async () => {
    try {
      const { newPhoneCodeHash, codeType } = await resendCodeForPhone(phone, phoneCodeHash, operatorId, slot);

      // Save new hash
      await db
        .update(pendingAuthStates)
        .set({ phoneCodeHash: newPhoneCodeHash })
        .where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));

      const hint =
        codeType === "SentCodeTypeSms"
          ? `${E.ANNOUNCE} Kod <b>SMS</b> orqali yuborildi.`
          : codeType === "SentCodeTypeCall"
          ? `${E.PHONE} Kod <b>telefon qo'ng'irog'i</b> orqali keladi.`
          : codeType === "SentCodeTypeApp"
          ? `${E.PHONE} Kod <b>Telegram ilovangizga</b> yuborildi.`
          : `${E.ANNOUNCE} Kod yuborildi (tur: <code>${codeType}</code>).`;

      await ctx.reply(
        `${E.OK} Qayta yuborildi!\n\n${hint}\n\nKelgan kodni yuboring:\n/code <code>KELGAN_KOD</code>`,
        { parse_mode: "HTML" },
      );
    } catch (err: any) {
      logger.error({ err }, "resendcode error");
      await notifyError(err, "resendcode error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
    })(); // end void resendcode worker
  });

  // ── /2fa ──────────────────────────────────────────────────────────────────────
  bot.command("2fa", async (ctx) => {
    const operatorId = ctx.from!.id;
    if (!await isAnySuperAdmin(operatorId)) {
      await ctx.reply(`${E.NO} Bu buyruq faqat super admin uchun.`, { parse_mode: "HTML" });
      return;
    }

    const password = ctx.match?.trim();
    if (!password) {
      await ctx.reply("❌ Format: /2fa <code>parolingiz</code>", { parse_mode: "HTML" });
      return;
    }

    const authStates = await db
      .select()
      .from(pendingAuthStates)
      .where(
        and(
          eq(pendingAuthStates.userId, operatorId),
          eq(pendingAuthStates.step, "2fa"),
        ),
      )
      .orderBy(desc(pendingAuthStates.createdAt))
      .limit(1);

    if (!authStates.length) {
      await ctx.reply("❌ Faol 2FA so'rov topilmadi.\n\nQaytadan /login dan boshlang.");
      return;
    }

    const { phone, slot } = authStates[0];

    try {
      await ctx.reply(`${E.CLOCK} 2FA paroli tekshirilmoqda...`, { parse_mode: "HTML" });
      const sessionString = await completeMasterLogin2FA(password, operatorId, slot);

      await db
        .insert(masterSessions)
        .values({ operatorId, slot, phone, sessionString })
        .onConflictDoUpdate({
          target: [masterSessions.operatorId, masterSessions.slot],
          set: { phone, sessionString },
        });
      await db.delete(pendingAuthStates).where(
        and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)),
      );

      await recordStat(operatorId, "login");
      await ctx.reply(
        `${E.OK} <b>Slot ${slot}:</b> <code>${phone}</code> 2FA bilan muvaffaqiyatli ulandi!`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard(true) },
      );
    } catch (err: any) {
      // Server restart clears _pendingClients — pending session is lost, must restart login
      if (err?.message?.includes("Faol login jarayoni topilmadi")) {
        await db.delete(pendingAuthStates).where(
          and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)),
        );
        await ctx.reply(
          `${E.ALERT} <b>Login sessiyasi eskirgan</b> (server qayta ishga tushdi).\n\nQaytadan boshlang: /login`,
          { parse_mode: "HTML" },
        );
        return;
      }
      if (err?.errorMessage === "PASSWORD_HASH_INVALID" || err?.message?.includes("PASSWORD_HASH_INVALID")) {
        await ctx.reply(`${E.NO} <b>Parol noto'g'ri.</b>\n\nQaytadan kiriting: /2fa <code>parolingiz</code>`, { parse_mode: "HTML" });
        return;
      }
      logger.error({ err }, "2fa command error");
      await notifyError(err, "2fa command error");
      await ctx.reply(`❌ 2FA xato: ${err.message}`);
    }
  });

  // ── /addcard ──────────────────────────────────────────────────────────────────
  // Format: /addcard BANKNAME 4111111111111111 12/26 123
  bot.command("addcard", async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    // Minimum: BankName + CardNumber + Expiry + CVV = 4 parts
    if (parts.length < 4) {
      await ctx.reply(
        "❌ Format:\n/addcard <code>BANK_NOMI 4111111111111111 12/26 123</code>\n\n" +
          "Misol:\n/addcard <code>Kapital 4111111111111111 12/26 123</code>\n" +
          "/addcard <code>Uzcard 8600123456781234 03/28 456</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const cvv = parts[parts.length - 1];
    const expiry = parts[parts.length - 2];
    const cardNumber = parts[parts.length - 3].replace(/\s/g, "");
    const bankName = parts.slice(0, parts.length - 3).join(" ");

    if (!/^\d{13,19}$/.test(cardNumber)) {
      await ctx.reply("❌ Karta raqami noto'g'ri (13-19 raqam bo'lishi kerak).");
      return;
    }
    if (!/^\d{2}\/\d{2,4}$/.test(expiry)) {
      await ctx.reply("❌ Muddati noto'g'ri (MM/YY formatda kiriting).");
      return;
    }
    if (!/^\d{3,4}$/.test(cvv)) {
      await ctx.reply("❌ CVV noto'g'ri (3-4 raqam).");
      return;
    }
    if (!bankName.trim()) {
      await ctx.reply("❌ Bank nomi kiritilmagan.");
      return;
    }

    const cardNumberMasked = `****${cardNumber.slice(-4)}`;

    try {
      // Demote existing default card
      await db
        .update(savedCards)
        .set({ isDefault: false })
        .where(eq(savedCards.userId, ctx.from!.id));

      await db.insert(savedCards).values({
        userId: ctx.from!.id,
        cardHolder: bankName.toUpperCase(), // used for Stripe tokenization
        bankName: bankName,
        cardNumber,
        cardNumberMasked,
        expiry,
        cvv,
        isDefault: true,
      });

      await recordStat(ctx.from!.id, "card_added");
      await ctx.reply(
        `✅ <b>Karta saqlandi!</b>\n\n` +
          `🏦 Bank: <b>${bankName}</b>\n` +
          `🔢 Raqam: <code>${cardNumberMasked}</code>\n` +
          `📅 Muddat: ${expiry}\n\n` +
          `Bu karta @${PREMIUM_BOT} orqali avtomatik to'lovlarda ishlatiladi.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
    } catch (err: any) {
      logger.error({ err }, "addcard error");
      await notifyError(err, "addcard error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });

  // ── /cards ────────────────────────────────────────────────────────────────────
  bot.command("cards", async (ctx) => {
    const cards = await db
      .select()
      .from(savedCards)
      .where(eq(savedCards.userId, ctx.from!.id))
      .orderBy(desc(savedCards.createdAt));

    if (!cards.length) {
      await ctx.reply(
        "💳 Saqlangan kartalar yo'q.\n\n/addcard buyrug'i bilan karta qo'shing.",
        { reply_markup: menuButton() },
      );
      return;
    }

    const lines = cards.map(
      (c, i) =>
        `${i + 1}. ${c.isDefault ? "⭐ " : ""}🏦 <b>${c.bankName ?? c.cardHolder}</b>\n` +
        `   <code>${c.cardNumberMasked}</code> | ${c.expiry}`,
    );

    // Inline keyboard: one row per card with Set Default + Delete buttons
    const kb = new InlineKeyboard();
    for (const c of cards) {
      const label = `${c.bankName ?? c.cardHolder} ${c.cardNumberMasked}`;
      kb.text(label, `card_detail:${c.id}`).icon(c.isDefault ? EID.STAR : EID.CARD).primary().row();
    }
    kb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();

    await ctx.reply(
      `💳 <b>Saqlangan kartalar (${cards.length} ta):</b>\n\n${lines.join("\n\n")}\n\n` +
        `⭐ — asosiy karta`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── Callback: card_detail:<id> — show single card actions ────────────────────
  bot.callbackQuery(/^card_detail:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const cardId = Number(ctx.match[1]);
    const userId = ctx.from.id;

    const [card] = await db
      .select()
      .from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.editMessageText("❌ Karta topilmadi.", {
        reply_markup: new InlineKeyboard().text("Kartalar", "menu_cards").icon(EID.CARD).primary(),
      });
      return;
    }

    const bankLabel = card.bankName ?? card.cardHolder;
    const text =
      `${E.CARD} <b>${bankLabel}</b>\n\n` +
      `🔢 Raqam: <code>${card.cardNumberMasked}</code>\n` +
      `📅 Muddat: ${card.expiry}\n` +
      `Holat: ${card.isDefault ? `${E.STAR} Asosiy karta` : "Asosiy emas"}`;

    const kb = new InlineKeyboard();
    if (!card.isDefault) {
      kb.text("Asosiy qilish", `card_setdefault:${cardId}`).icon(EID.STAR).success().row();
    }
    kb.text("O'chirish", `card_delete:${cardId}`).icon(EID.TRASH).danger().row();
    kb.text("Orqaga", "menu_cards").icon(EID.CARD).primary();

    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  // ── Callback: card_setdefault:<id> ───────────────────────────────────────────
  bot.callbackQuery(/^card_setdefault:(\d+)$/, async (ctx) => {
    const cardId = Number(ctx.match[1]);
    const userId = ctx.from.id;

    const [card] = await db
      .select()
      .from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.answerCallbackQuery("❌ Karta topilmadi.").catch(() => {});
      return;
    }

    await db.update(savedCards).set({ isDefault: false }).where(eq(savedCards.userId, userId));
    await db.update(savedCards).set({ isDefault: true }).where(eq(savedCards.id, cardId));
    await ctx.answerCallbackQuery("⭐ Asosiy karta qilindi!").catch(() => {});

    const bankLabel = card.bankName ?? card.cardHolder;
    await ctx.editMessageText(
      `✅ <b>${bankLabel}</b> endi asosiy karta!\n\n` +
        `🔢 Raqam: <code>${card.cardNumberMasked}</code>\n` +
        `📅 Muddat: ${card.expiry}\n` +
        `Holat: ⭐ Asosiy karta`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("O'chirish", `card_delete:${cardId}`).icon(EID.TRASH).danger().row()
          .text("Orqaga", "menu_cards").icon(EID.CARD).primary(),
      },
    );
  });

  // ── Callback: card_delete:<id> — confirm ─────────────────────────────────────
  bot.callbackQuery(/^card_delete:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const cardId = Number(ctx.match[1]);
    const userId = ctx.from.id;

    const [card] = await db
      .select()
      .from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.editMessageText("❌ Karta topilmadi.", {
        reply_markup: new InlineKeyboard().text("◀️ Kartalar", "menu_cards"),
      });
      return;
    }

    const bankLabel = card.bankName ?? card.cardHolder;
    await ctx.editMessageText(
      `⚠️ <b>Tasdiqlang</b>\n\n` +
        `🏦 ${bankLabel} — <code>${card.cardNumberMasked}</code>\n\n` +
        `Bu kartani o'chirishni xohlaysizmi?`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Ha, o'chir", `card_delete_confirm:${cardId}`).icon(EID.TRASH).danger()
          .text("Yo'q", `card_detail:${cardId}`).icon(EID.NO).primary(),
      },
    );
  });

  // ── Callback: card_delete_confirm:<id> ───────────────────────────────────────
  bot.callbackQuery(/^card_delete_confirm:(\d+)$/, async (ctx) => {
    const cardId = Number(ctx.match[1]);
    const userId = ctx.from.id;

    const [card] = await db
      .select()
      .from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.answerCallbackQuery("❌ Karta topilmadi.").catch(() => {});
      return;
    }

    await db.delete(savedCards).where(eq(savedCards.id, cardId));

    // If deleted card was default, make the newest remaining card default
    if (card.isDefault) {
      const [next] = await db
        .select()
        .from(savedCards)
        .where(eq(savedCards.userId, userId))
        .orderBy(desc(savedCards.createdAt))
        .limit(1);
      if (next) {
        await db.update(savedCards).set({ isDefault: true }).where(eq(savedCards.id, next.id));
      }
    }

    await ctx.answerCallbackQuery("🗑 O'chirildi").catch(() => {});
    await ctx.editMessageText(
      `✅ Karta o'chirildi.`,
      { reply_markup: new InlineKeyboard().text("💳 Kartalar", "menu_cards") },
    );
  });

  // ── /getpremium ───────────────────────────────────────────────────────────────
  // Usage: /getpremium +998901234567
  bot.command("getpremium", async (ctx) => {
    const phone = ctx.match?.trim();
    if (!phone) {
      await ctx.reply(
        "❌ Telefon raqam kiriting:\n/getpremium <code>+998901234567</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    // Find the session
    const [session] = await db
      .select()
      .from(userbotSessions)
      .where(eq(userbotSessions.phone, phone))
      .limit(1);

    if (!session) {
      await ctx.reply(
        `❌ <code>${phone}</code> raqami uchun sessiya topilmadi.\n\n` +
          `Avval /getnumber orqali raqam oling.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (session.hasPremium && session.premiumExpiresAt && session.premiumExpiresAt > new Date()) {
      const expStr = session.premiumExpiresAt.toLocaleDateString("uz");
      await ctx.reply(
        `⭐ <code>${phone}</code> uchun Premium allaqachon faol!\n` +
          `📅 Muddat: ${expStr}`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
      return;
    }

    const card = await getDefaultCard(ctx.from!.id);
    if (!card) {
      await ctx.reply(
        "❌ Karta saqlanmagan.\n\n💳 Avval /addcard orqali karta qo'shing.",
        { reply_markup: menuButton() },
      );
      return;
    }

    const statusMsg = await ctx.reply(
      `⏳ <code>${phone}</code> uchun Premium jarayoni boshlandi...\n\n` +
        `1️⃣ @${PREMIUM_BOT} ga /start yuborilmoqda...`,
      { parse_mode: "HTML" },
    );
    const chatId = ctx.chat!.id;
    const msgId = statusMsg.message_id;

    void (async () => {
    const update = async (text: string) => {
      try {
        await ctx.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML" });
      } catch (_) {}
    };

    let userClient: any = null;
    const operatorId = ctx.from!.id;

    // ── Global session lock — prevent two operators running the same phone ────
    if (activePremiumSessions.has(phone)) {
      await update(`⚠️ <code>${phone}</code> uchun premium jarayoni allaqachon boshqa operator tomonidan bajarilmoqda.`);
      await ctx.reply("⚠️ Bu sessiya hozir boshqa operator tomonidan ishlanmoqda.", { reply_markup: menuButton() });
      return;
    }
    activePremiumSessions.add(phone);

    // ── Restart loop: "Evro ekan" restarts from step 1 ───────────────────────
    let restartCount = 0;
    try {
    while (true) {
      // Each attempt gets its own unique ID — old timers from previous attempts
      // will find no matching key and safely no-op.
      const attemptId = `${operatorId}_${Date.now()}`;
      // step6Promise is created inside onVerificationNeeded (before the message is
      // sent) so the Map key is ready before the operator can press any button.
      let step6Promise: Promise<void> | null = null;

      try {
        // Create a fresh client on each attempt (first or restart)
        if (userClient) {
          try { await userClient.disconnect(); } catch (_) {}
        }
        userClient = await createClientFromSession(session.sessionString);

        if (restartCount === 0) {
          await update(
            `⏳ <code>${phone}</code> Premium jarayoni...\n\n` +
              `1️⃣ @${PREMIUM_BOT} ga /start yuborilmoqda, invoice kutilmoqda...`,
          );
        } else {
          await update(
            `🔄 <b>${restartCount}-urinish</b> — <code>${phone}</code>\n\n` +
              `1️⃣ @${PREMIUM_BOT} ga /start yuborilmoqda...`,
          );
        }

        const verifierBot = await getDefaultVerifierBot();

        const [pendingRow] = await db
          .select()
          .from(pendingNumbers)
          .where(eq(pendingNumbers.phone, phone))
          .limit(1);

        const checkProviderBot = pendingRow?.providerBot ?? verifierBot;
        const checkMsgId = pendingRow?.repreamMessageId
          ? Number(pendingRow.repreamMessageId)
          : undefined;

        const result = await withTimeout(runFullPremiumFlow(
          userClient,
          PREMIUM_BOT,
          checkProviderBot,
          card,
          async (progressMsg) => {
            await update(
              `⏳ <b>Premium jarayoni</b> — <code>${phone}</code>\n\n${progressMsg}`,
            );
          },
          // ── 3DS OTP callback (Playwright detected OTP input) ───────────────
          async () => {
            return new Promise<string | null>((resolve) => {
              pendingOtpCallbacks.set(attemptId, resolve);
              addActiveOtpFlow(operatorId, attemptId);

              ctx.api
                .sendMessage(
                  chatId,
                  `🔐 <b>3DS Tasdiqlash kodi kerak!</b>\n\n` +
                    `📱 Kartangiz raqamiga SMS kod yuborildi.\n\n` +
                    `Kodni shu yerga yuboring (120 soniya ichida):\n` +
                    `<i>Misol: 123456</i>`,
                  { parse_mode: "HTML" },
                )
                .catch(() => {});

              // OTP auto-expire: always call resolve(null) regardless of whether
              // the key was already deleted by the inner finally (cleanup on
              // withTimeout). Calling resolve() on an already-settled Promise is
              // a no-op, so there is no double-resolve risk.
              const otpTimer = setTimeout(() => {
                pendingOtpCallbacks.delete(attemptId); // no-op if already cleaned up
                removeActiveOtpFlow(operatorId, attemptId);
                ctx.api
                  .sendMessage(chatId, "⏱ 3DS kod 120 soniyada kiritilmadi — jarayon davom ettirilmoqda.", { parse_mode: "HTML" })
                  .catch(() => {});
                resolve(null); // always settle — prevents orphaned runFullPremiumFlow
              }, 120_000);

              // Overwrite with timer-clearing wrapper so normal OTP entry cancels the timer
              const origResolve = resolve;
              pendingOtpCallbacks.set(attemptId, (otp) => {
                clearTimeout(otpTimer);
                origResolve(otp);
              });
            });
          },
          // ── PaymentVerificationNeeded callback (bank 3DS URL) ───────────────
          // IMPORTANT: pendingStep6Callbacks is populated HERE (before the
          // message is sent) so the Map key exists the moment the operator
          // receives the message and can press a button.
          async (verificationUrl: string) => {
            // Register the step-6 resolver before the message is sent so there
            // is zero gap between the operator seeing the buttons and the Map
            // having a matching key.
            let step6MsgId: number | null = null;
            // No auto-continue timer here by design — step6Promise only settles
            // via an explicit operator button press or the auto-detect poll
            // below. Removing the 5-minute timeout means the flow will wait
            // indefinitely for one of those two signals instead of guessing.
            step6Promise = new Promise<void>((resolve, reject) => {
              pendingStep6Callbacks.set(attemptId, (choice) => {
                if (choice === "abort") reject(new FlowAbortError());
                else if (choice === "restart") reject(new FlowRestartError());
                else if (choice === "step6_timeout") reject(new FlowStep6TimeoutError());
                else resolve();
              });
            });
            // No-op rejection handler attached immediately so a fast operator
            // button press (reject) before step-6 awaits step6Promise cannot
            // become an unhandled rejection that crashes the process. The later
            // `await step6Promise` still receives the rejection.
            step6Promise?.catch(() => {});

            // NOTE: intentionally a plain `.url()` link, not `.webApp()`. Bank 3DS
            // challenge pages (redirects, cookies, cross-origin iframes) frequently
            // break inside Telegram's sandboxed Mini App WebView — the page loads
            // but hangs after the operator enters the SMS code. A regular URL
            // button opens Telegram's normal in-app browser tab, which behaves
            // like a full browser and completes the 3DS redirect correctly.
            const keyboard = new InlineKeyboard()
              .url("3DS tasdiqlash", verificationUrl).icon(EID.LOCK)
              .row()
              .text("3DS Tugadi — Davom et", `step6_done:${attemptId}`).icon(EID.OK).success()
              .row()
              .text("Evro (qayta urinish)", `step6_euro:${attemptId}`).icon(EID.REFRESH).primary()
              .text("Bekor qilish", `step6_abort:${attemptId}`).icon(EID.NO).danger();

            const sent = await ctx.api
              .sendMessage(
                chatId,
                `🔐 <b>Bank 3DS tasdiqlash talab qildi!</b>\n\n` +
                  `1️⃣ Quyidagi tugmani bosib brauzerda oching\n` +
                  `2️⃣ Bank SMS kodini kiritib tasdiqlang\n` +
                  `3️⃣ <b>✅ 3DS Tugadi — Davom et</b> tugmasini bosing\n\n` +
                  `💶 Evro chiqsa — <b>Evro (qayta urinish)</b> tugmasini bosing\n\n` +
                  `🤖 Yoki hech narsa bosmasangiz ham, bot @${PREMIUM_BOT} ga har 20 soniyada /start yuborib avtomatik tekshiradi.`,
                { parse_mode: "HTML", reply_markup: keyboard },
              )
              .catch(() => null);
            step6MsgId = sent?.message_id ?? null;

            // ── Auto-detect fallback ───────────────────────────────────────────
            // Runs independently of the operator button — polls @premiumbot's
            // /start reply up to 10x (every 30s, ~5 min total). If it already
            // greets with "Your Telegram Premium Plan:", Premium is confirmed
            // active and we resolve step6Promise ourselves, same as pressing
            // "3DS Tugadi". If all 10 attempts pass with no confirmation AND
            // the operator never pressed a button either, the flow is marked
            // an automatic failure instead of waiting forever (see
            // FlowStep6TimeoutError below).
            (async () => {
              const active = await pollPremiumActiveViaStart(userClient, PREMIUM_BOT, 10, 30000).catch(() => false);
              const cb = pendingStep6Callbacks.get(attemptId);
              if (!cb) return; // already resolved by button click
              pendingStep6Callbacks.delete(attemptId);
              if (step6MsgId != null) ctx.api.editMessageReplyMarkup(chatId, step6MsgId).catch(() => {});
              if (active) {
                ctx.api
                  .sendMessage(chatId, `✅ Premium avtomatik aniqlandi (@${PREMIUM_BOT} /start orqali) — davom etilmoqda.`, {
                    parse_mode: "HTML",
                  })
                  .catch(() => {});
                cb("continue");
              } else {
                ctx.api
                  .sendMessage(
                    chatId,
                    `❌ 10 marta tekshirildi (5 daqiqa) — Premium aniqlanmadi va operator tasdiqlamadi. Jarayon avtomatik muvaffaqiyatsiz deb belgilandi.`,
                    { parse_mode: "HTML" },
                  )
                  .catch(() => {});
                cb("step6_timeout");
              }
            })();
          },
          checkMsgId,
          // Step-6: await the Promise created inside onVerificationNeeded.
          // If 3DS was not triggered, step6Promise is null → return immediately.
          async () => {
            if (!step6Promise) return;
            await step6Promise;
          },
          // Step-8: master client for repream premium check after logout
          await getMasterClient(operatorId) ?? undefined,
        ), PREMIUM_FLOW_TOTAL_TIMEOUT, `Premium jarayoni (${phone})`);

        // Premium tasdiqlangan — sessiyani DBdan o'chirish (chiqish bo'ldi)
        if (result.hasPremium) {
          await Promise.all([
            db.delete(userbotSessions).where(eq(userbotSessions.phone, phone)),
            recordStat(operatorId, "premium_obtained"),
          ]);
        }

        const expStr = result.premiumExpiresAt
          ? `\n📅 Muddat: ${result.premiumExpiresAt.toLocaleDateString("uz")}`
          : "";
        const autoRenewalStr =
          result.autoRenewalCancelled === undefined
            ? ""
            : result.autoRenewalCancelled
              ? `\n🔕 Avto-obuna: bekor qilindi`
              : `\n⚠️ Avto-obuna: bekor qilinmagan bo'lishi mumkin`;

        await update(
          result.success
            ? `${result.hasPremium ? "⭐" : "✅"} <b>${result.message}</b>\n\n` +
                `📱 Raqam: <code>${phone}</code>${expStr}${autoRenewalStr}`
            : `❌ <b>Xato yuz berdi</b>\n\n${result.message}`,
        );

        await ctx.reply(
          result.success ? "✅ Jarayon yakunlandi." : "❌ Premium olinmadi.",
          { reply_markup: menuButton() },
        );
        break; // success — exit loop

      } catch (err: any) {
        if (err instanceof FlowRestartError) {
          restartCount++;
          if (restartCount > MAX_PREMIUM_RESTARTS) {
            await update(`❌ <b>Juda ko'p qayta urinish</b> (${MAX_PREMIUM_RESTARTS}) — jarayon to'xtatildi.`);
            await ctx.reply(`❌ ${MAX_PREMIUM_RESTARTS} marta qayta urinishdan so'ng to'xtatildi.`, { reply_markup: menuButton() });
            break;
          }
          await ctx.api
            .sendMessage(chatId, `🔄 Evro aniqlandi — ${restartCount}-urinish boshlanmoqda...`, { parse_mode: "HTML" })
            .catch(() => {});
          continue; // restart loop
        }
        if (err instanceof FlowAbortError) {
          await update(`❌ Jarayon operator tomonidan bekor qilindi.`);
          await ctx.reply("❌ Bekor qilindi.", { reply_markup: menuButton() });
          break;
        }
        if (err instanceof FlowStep6TimeoutError) {
          await update(
            `❌ <b>3DS tasdiqlanmadi</b>\n\n10 marta (5 daqiqa) @${PREMIUM_BOT} tekshirildi — Premium aniqlanmadi va operator ham tasdiqlamadi. Jarayon avtomatik muvaffaqiyatsiz deb belgilandi.`,
          );
          await ctx.reply("❌ Premium olinmadi — 3DS tasdiqlanmadi.", { reply_markup: menuButton() });
          break;
        }
        if (isSessionInvalidError(err)) {
          await markUserbotSessionInvalid(phone, err.message ?? String(err));
          await update(`❌ <b>Sessiya yaroqsiz</b> — <code>${phone}</code> Telegram tomonidan bekor qilingan (chiqib ketilgan/bloklangan). Avtomatik tozalashga qo'yildi.`);
          await ctx.reply("❌ Sessiya yaroqsiz — avtomatik tozalanadi.", { reply_markup: menuButton() });
          break;
        }
        logger.error({ err }, "getpremium command error");
        await notifyError(err, "getpremium command error");
        await update(`❌ Xato: ${err.message}`);
        break;
      } finally {
        // Clean up this attempt's state — does not affect other attempts
        pendingStep6Callbacks.delete(attemptId);
        pendingOtpCallbacks.delete(attemptId);
        removeActiveOtpFlow(operatorId, attemptId);
      }
    }

    } finally {
      // userClient.disconnect() is inside the outer finally so it always runs
      // even when an unexpected throw escapes the inner catch (e.g. ctx.reply
      // failing after an error message) and bypasses the lines below.
      activePremiumSessions.delete(phone);
      if (userClient) {
        try { await userClient.disconnect(); } catch (_) {}
      }
    }
    })(); // end void getpremium worker
  });

  // ── /getnumber ────────────────────────────────────────────────────────────────
  bot.command("getnumber", async (ctx) => {
    const repreamBot = await getOperatorSource(ctx.from!.id);
    const statusMsg = await ctx.reply(
      `${E.CLOCK} @${repreamBot} dan raqam so'ralmoqda...`,
      { parse_mode: "HTML" },
    );
    const chatId = ctx.chat!.id;
    const msgId = statusMsg.message_id;
    const uid = ctx.from!.id;

    // getMasterClient + sendCommandAndWaitForNumber (up to 30 s) moved inside
    // void so the handler returns immediately and the runner can process more
    // updates from this operator without blocking.
    void (async () => {
    const client = await getMasterClient(uid);
    if (!client) {
      await ctx.api.editMessageText(chatId, msgId,
        "❌ Operator hisob ulanmagan. /login buyrug'ini yuboring.",
      ).catch(() => {});
      return;
    }

    try {
      const result = await sendCommandAndWaitForNumber(client, repreamBot, "/getnumber");

      if (!result) {
        await ctx.api.editMessageText(chatId, msgId,
          `${E.NO} @${repreamBot} dan javob kelmadi. Keyinroq urinib ko'ring.`,
        ).catch(() => {});
        return;
      }

      await db
        .delete(pendingNumbers)
        .where(and(eq(pendingNumbers.requestedByUserId, uid), eq(pendingNumbers.status, "waiting")));

      await db.insert(pendingNumbers).values({
        requestedByUserId: uid,
        phone: result.phone,
        providerBot: repreamBot,
        repreamMessageId: result.messageId,
        cancelData: result.buttons.cancel,
        freezeData: result.buttons.freeze,
        getCodeData: result.buttons.getCode,
      });

      const keyboard = new InlineKeyboard()
        .text("Cancel", `cancel:${uid}`).icon(EID.NO).danger()
        .text("Freeze", `freeze:${uid}`).icon(EID.LOCK).primary()
        .text("Get Code", `getcode:${uid}`).icon(EID.PHONE).success();

      await ctx.api.editMessageText(chatId, msgId,
        `${E.PHONE} <b>Raqam olindi!</b>\n\n<code>${result.phone}</code>\n\nQuyidagi tugmalardan birini tanlang:`,
        { parse_mode: "HTML", reply_markup: keyboard },
      ).catch(() => {});
    } catch (err: any) {
      logger.error({ err }, "getnumber command error");
      await notifyError(err, "getnumber command error");
      await ctx.api.editMessageText(chatId, msgId, `❌ Xato: ${err.message}`).catch(() => {});
    }
    })(); // end void getnumber worker
  });

  // ── /list ─────────────────────────────────────────────────────────────────────
  bot.command("list", async (ctx) => {
    const sessions = await db
      .select()
      .from(userbotSessions)
      .where(eq(userbotSessions.ownerId, ctx.from!.id))
      .orderBy(desc(userbotSessions.createdAt))
      .limit(10);

    if (!sessions.length) {
      await ctx.reply(
        `${E.EMPTY} Hech qanday userbot sessiyasi yo'q.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
      return;
    }

    const lines = sessions.map((s, i) => {
      const icon = s.status === "active" ? E.OK : E.NO;
      const premiumBadge = s.hasPremium ? ` ${E.STAR}` : "";
      const link = s.telegramLink ? `\n   ${E.LINK} ${s.telegramLink}` : "";
      const expiry = s.hasPremium && s.premiumExpiresAt
        ? `\n   📅 ${s.premiumExpiresAt.toLocaleDateString("uz")}`
        : "";
      return `${i + 1}. ${icon}${premiumBadge} <code>${s.phone}</code>${link}${expiry}`;
    });

    await ctx.reply(
      `${E.NOTE} <b>Userbot sessiyalar (oxirgi 10):</b>\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML", reply_markup: menuButton() },
    );
  });

  // ── Helper: get default card for a user ───────────────────────────────────────
  async function getDefaultCard(userId: number) {

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

  // ── Helper: auto-press Freeze on the provider bot and show "Get New Number" button ─
  async function autoFreezeAndNotify(
    ctx: { reply: (text: string, opts?: any) => Promise<any> },
    row: {
      id: number;
      phone: string;
      requestedByUserId: number;
      repreamMessageId: number | null;
      freezeData: string | null;
      providerBot?: string | null;
    },
    reason: string,
  ) {
    const botName = row.providerBot ?? DEFAULT_REPREAM_BOT;
    // 1. Press Freeze on the provider bot
    const masterClient = await getMasterClient(row.requestedByUserId);
    if (masterClient && row.repreamMessageId && row.freezeData) {
      try {
        await clickRepreamButton(
          masterClient,
          botName,
          Number(row.repreamMessageId),
          row.freezeData,
        );
        logger.info({ phone: row.phone, botName }, "Freeze button clicked on provider bot");
      } catch (e) {
        logger.warn({ e }, "Failed to click freeze button");
      }
    }

    // 2. Update DB
    await db
      .update(pendingNumbers)
      .set({ status: "frozen" })
      .where(eq(pendingNumbers.id, row.id));

    // 3. Notify operator with "Get New Number" + "Menu" buttons
    const keyboard = new InlineKeyboard()
      .text("Yangi raqam olish", `getnew:${row.requestedByUserId}`).icon(EID.REFRESH).success()
      .text("Menyu", "menu_home").icon(EID.HOME).primary();

    await ctx.reply(
      `🧊 <b>Raqam freeze qilindi</b>\n\n` +
        `📱 Raqam: <code>${row.phone}</code>\n` +
        `❌ Sabab: ${reason}`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  }

  // ── Helper: finish a successful sign-in — claim session, save it, fetch Premium link ──
  async function finishSignInAndDeliverLink(
    ctx: { reply: (text: string, opts?: any) => Promise<any> },
    row: { id: number; phone: string },
    sessionString: string,
    userId: number,
    otp: string,
  ) {
    const claim = await claimUserbotSession(row.phone, sessionString, userId);
    if (!claim.ok) {
      await ctx.reply(
        `⚠️ <code>${row.phone}</code> raqami allaqachon boshqa admin tomonidan olingan. O'tkazib yuborildi.`,
        { parse_mode: "HTML" },
      );
      await db.update(pendingNumbers).set({ status: "frozen" }).where(eq(pendingNumbers.id, row.id));
      return;
    }

    await db
      .update(pendingNumbers)
      .set({ status: "completed", otpCode: otp })
      .where(eq(pendingNumbers.id, row.id));

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
      await db
        .update(userbotSessions)
        .set({ telegramLink: link })
        .where(eq(userbotSessions.phone, row.phone));
      await ctx.reply(
        `✅ <b>Muvaffaqiyat!</b>\n\n📱 Raqam: <code>${row.phone}</code>\n🔗 Havola: ${link}`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
    } else {
      await ctx.reply(
        `✅ <b>Sessiya yaratildi!</b>\n\n📱 Raqam: <code>${row.phone}</code>\n` +
          `⚠️ @${PREMIUM_BOT} dan havola olinmadi.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
    }
  }

  // ── Callback: Cancel ──────────────────────────────────────────────────────────
  bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    if (ctx.from.id !== userId) {
      await ctx.answerCallbackQuery("❌ Bu sizning so'rovingiz emas.").catch(() => {});
      return;
    }

    const pending = await db
      .select()
      .from(pendingNumbers)
      .where(and(eq(pendingNumbers.requestedByUserId, userId), eq(pendingNumbers.status, "waiting")))
      .limit(1);

    if (!pending.length) {
      await ctx.answerCallbackQuery("❌ Faol so'rov topilmadi.").catch(() => {});
      return;
    }

    // DB update + UI response immediately — provider-side cancel button press
    // (getMasterClient + clickRepreamButton, up to 45 s on reconnect) runs in
    // background so the operator isn't frozen waiting for Telegram round-trips.
    await db
      .update(pendingNumbers)
      .set({ status: "cancelled" })
      .where(eq(pendingNumbers.id, pending[0].id));

    await ctx.editMessageText("❌ Raqam bekor qilindi.").catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});

    void (async () => {
    const client = await getMasterClient(ctx.from.id);
    if (client && pending[0].repreamMessageId && pending[0].cancelData) {
      try {
        await clickRepreamButton(
          client,
          pending[0].providerBot ?? DEFAULT_REPREAM_BOT,
          Number(pending[0].repreamMessageId),
          pending[0].cancelData,
        );
      } catch (_) {}
    }
    })(); // end void cancel worker
  });

  // ── Callback: Freeze (manual) ─────────────────────────────────────────────────
  bot.callbackQuery(/^freeze:(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    if (ctx.from.id !== userId) {
      await ctx.answerCallbackQuery("❌ Bu sizning so'rovingiz emas.").catch(() => {});
      return;
    }

    const pending = await db
      .select()
      .from(pendingNumbers)
      .where(
        and(
          eq(pendingNumbers.requestedByUserId, userId),
          eq(pendingNumbers.status, "waiting"),
        ),
      )
      .limit(1);

    if (!pending.length) {
      await ctx.answerCallbackQuery("❌ Faol so'rov topilmadi.").catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery("⏳ Freeze qilinmoqda...").catch(() => {});
    await ctx.editMessageText(
      `🧊 <code>${pending[0].phone}</code> freeze qilinyapti...`,
      { parse_mode: "HTML" },
    ).catch(() => {});

    // autoFreezeAndNotify calls getMasterClient + clickRepreamButton (up to 45 s).
    // Detach so the handler returns immediately.
    void (async () => {
    await autoFreezeAndNotify(ctx, pending[0], "Operator tomonidan");
    })(); // end void freeze worker
  });

  // ── Callback: Get Code ────────────────────────────────────────────────────────
  bot.callbackQuery(/^getcode:(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    if (ctx.from.id !== userId) {
      await ctx.answerCallbackQuery("❌ Bu sizning so'rovingiz emas.").catch(() => {});
      return;
    }

    const pending = await db
      .select()
      .from(pendingNumbers)
      .where(
        and(
          eq(pendingNumbers.requestedByUserId, userId),
          eq(pendingNumbers.status, "waiting"),
        ),
      )
      .limit(1);

    if (!pending.length) {
      await ctx.answerCallbackQuery("❌ Faol so'rov topilmadi.").catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(
      `⏳ <code>${pending[0].phone}</code> uchun kod so'ralmoqda...`,
      { parse_mode: "HTML" },
    );

    // ── Step 1: Send auth code to Telegram ───────────────────────────────────
    await ctx.reply(
      `⏳ Telegram ga <code>${pending[0].phone}</code> raqamiga kod yuborilmoqda...`,
      { parse_mode: "HTML" },
    );

    // getMasterClient moved inside void — connectWithCleanup can block 45 s.
    void (async () => {
    const client = await getMasterClient(ctx.from.id);
    if (!client) {
      await ctx.reply("❌ Operator hisob ulanmagan. /login buyrug'ini yuboring.").catch(() => {});
      return;
    }
    let phoneCodeHash: string;
    try {
      phoneCodeHash = await sendCodeForPhone(pending[0].phone);
    } catch (err: any) {
      const msg: string = err?.errorMessage ?? err?.message ?? "";
      const isFlood = msg.includes("FLOOD_WAIT") || msg.includes("FLOOD");
      logger.error({ err }, "sendCodeForPhone error");
      await notifyError(err, "sendCodeForPhone error");
      await autoFreezeAndNotify(
        ctx,
        pending[0],
        isFlood
          ? `Bu raqam ko'p marta ishlatilgan — Telegram FLOOD_WAIT qaytardi`
          : `Kod yuborishda xato: ${msg}`,
      );
      return;
    }

    await db
      .update(pendingNumbers)
      .set({ phoneCodeHash })
      .where(eq(pendingNumbers.id, pending[0].id));

    if (!pending[0].repreamMessageId || !pending[0].getCodeData) {
      await autoFreezeAndNotify(
        ctx,
        pending[0],
        "Manba bot tugmasi ma'lumoti topilmadi",
      );
      return;
    }

    // Use the provider bot that originally issued this number
    const providerBot = pending[0].providerBot ?? DEFAULT_REPREAM_BOT;

    // ── Step 2: Click "Get Code" on provider bot and wait for its reply ──────
    // Wrap in try/catch so any unexpected throw also triggers a freeze
    let listenPromise: ReturnType<typeof waitForRepreamCode>;
    try {
      listenPromise = waitForRepreamCode(client, providerBot, Number(pending[0].repreamMessageId), 30000, [DEFAULT_REPREAM_BOT]);
      await clickRepreamButton(
        client,
        providerBot,
        Number(pending[0].repreamMessageId),
        pending[0].getCodeData,
      );
    } catch (err: any) {
      logger.error({ err }, "clickRepreamButton error");
      await notifyError(err, "clickRepreamButton error");
      await autoFreezeAndNotify(
        ctx,
        pending[0],
        `@${providerBot} tugmasini bosishda xato: ${err?.errorMessage ?? err?.message ?? "noma'lum"}`,
      );
      return;
    }

    await ctx.reply(`⏳ @${providerBot} dan kod kutilmoqda... (30 soniya)`);

    const codeResponse = await listenPromise;
    if (!codeResponse) {
      await autoFreezeAndNotify(
        ctx,
        pending[0],
        `@${providerBot} dan 30 soniya ichida javob kelmadi`,
      );
      return;
    }

    // ── Step 3: Parse "Code received: / Number: / Code: / Pass:" ─────────────
    const parsed = parseRepreamCodeMessage(codeResponse.text);

    // Log only non-sensitive fields — never log OTP/Pass values
    logger.info(
      {
        phone: pending[0].phone,
        hasCode: !!parsed.code,
        hasPass: !!parsed.pass,
        hasNumber: !!parsed.number,
      },
      "Parsed repream code message",
    );

    if (!parsed.code) {
      // Code field is empty or missing — must freeze
      await autoFreezeAndNotify(
        ctx,
        pending[0],
        `@${providerBot} Code maydoni bo'sh yoki topilmadi\n\n` +
          `📩 Javob:\n<code>${codeResponse.text.slice(0, 200)}</code>`,
      );
      return;
    }

    const otp = parsed.code;
    const twoFAPass = parsed.pass ?? null;

    await ctx.reply(
      `✅ Kod olindi: <code>${otp}</code>` +
        (twoFAPass ? `\n🔐 2FA paroli ham olindi` : "") +
        `\n\n⏳ Telegram ga kirilmoqda...`,
      { parse_mode: "HTML" },
    );

    // ── Step 4: Sign in (auto-handles 2FA if Pass was in message) ────────────
    let sessionString: string;
    try {
      sessionString = await signInWithCodeAndPass(
        pending[0].phone,
        phoneCodeHash,
        otp,
        twoFAPass,
      );
    } catch (err: any) {
      const msg: string = err?.errorMessage ?? err?.message ?? "";
      const needsPassword =
        msg.includes("PASSWORD_HASH_INVALID") || msg.includes("SESSION_PASSWORD_NEEDED");

      if (needsPassword) {
        // Don't freeze — let the operator type the correct 2FA password and retry.
        logger.warn({ phone: pending[0].phone, msg }, "signInWithCodeAndPass needs password, awaiting manual entry");
        await db
          .update(pendingNumbers)
          .set({ status: "awaiting_pass", otpCode: otp })
          .where(eq(pendingNumbers.id, pending[0].id));
        await ctx.reply(
          msg.includes("PASSWORD_HASH_INVALID")
            ? `🔐 <b>2FA parol noto'g'ri!</b>\n\nTo'g'ri parolni kiriting:\n/pass <code>parolingiz</code>`
            : `🔐 <b>2FA parol kerak!</b>\n\nHisobda ikki bosqichli tasdiqlash yoqilgan.\n\nParolingizni kiriting:\n/pass <code>parolingiz</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }

      logger.error({ err }, "signInWithCodeAndPass error");
      await notifyError(err, "signInWithCodeAndPass error");
      await autoFreezeAndNotify(
        ctx,
        pending[0],
        `Telegram kirish xatosi: ${msg}`,
      );
      return;
    }

    // ── Step 5: Save session and get Premium link ─────────────────────────────
    await finishSignInAndDeliverLink(ctx, pending[0], sessionString, userId, otp);
    })(); // end void getcode worker
  });

  // ── /pass — retry sign-in with a manually-entered 2FA password ─────────────────
  bot.command("pass", async (ctx) => {
    const password = ctx.match?.trim();
    if (!password) {
      await ctx.reply("❌ Format: /pass <code>parolingiz</code>", { parse_mode: "HTML" });
      return;
    }

    const userId = ctx.from!.id;
    const pending = await db
      .select()
      .from(pendingNumbers)
      .where(
        and(
          eq(pendingNumbers.requestedByUserId, userId),
          eq(pendingNumbers.status, "awaiting_pass"),
        ),
      )
      .orderBy(desc(pendingNumbers.createdAt))
      .limit(1);

    if (!pending.length || !pending[0].phoneCodeHash || !pending[0].otpCode) {
      await ctx.reply("❌ Faol 2FA so'rov topilmadi. Qaytadan /getnew dan boshlang.");
      return;
    }

    const row = pending[0];
    const phoneCodeHash: string = row.phoneCodeHash!;
    const otp: string = row.otpCode!;
    await ctx.reply("⏳ Parol tekshirilmoqda...");

    void (async () => {
    try {
      const sessionString = await signInWithCodeAndPass(row.phone, phoneCodeHash, otp, password);
      await finishSignInAndDeliverLink(ctx, row, sessionString, userId, otp);
    } catch (err: any) {
      const msg: string = err?.errorMessage ?? err?.message ?? "";
      if (msg.includes("PASSWORD_HASH_INVALID")) {
        await ctx.reply("❌ Parol noto'g'ri. Qaytadan kiriting: /pass <code>parolingiz</code>", { parse_mode: "HTML" });
        return;
      }
      logger.error({ err }, "pass command error");
      await notifyError(err, "pass command error");
      await autoFreezeAndNotify(ctx, row, `Parol tasdiqlashda xato: ${msg}`);
    }
    })(); // end void pass worker
  });

  // ── Callback: Get New Number (after freeze) ───────────────────────────────────
  bot.callbackQuery(/^getnew:(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    if (ctx.from.id !== userId) {
      await ctx.answerCallbackQuery("❌ Bu sizning so'rovingiz emas.").catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery("⏳ Yangi raqam olinmoqda...").catch(() => {});

    const newBot = await getOperatorSource(userId);
    const statusMsg = await ctx.reply(`⏳ @${newBot} dan yangi raqam so'ralmoqda...`);

    // getMasterClient moved inside void — connectWithCleanup can block 45 s.
    void (async () => {
    const masterClient = await getMasterClient(ctx.from.id);
    if (!masterClient) {
      await ctx.api.editMessageText(
        ctx.chat!.id, statusMsg.message_id,
        "❌ Operator hisob ulanmagan. /login buyrug'ini yuboring.",
      ).catch(() => {});
      return;
    }
    try {
      const result = await sendCommandAndWaitForNumber(
        masterClient,
        newBot,
        "/getnumber",
      );

      if (!result) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          `❌ @${newBot} dan javob kelmadi. Keyinroq /getnumber buyrug'ini ishlating.`,
        );
        return;
      }

      await db
        .delete(pendingNumbers)
        .where(
          and(
            eq(pendingNumbers.requestedByUserId, userId),
            eq(pendingNumbers.status, "waiting"),
          ),
        );

      await db.insert(pendingNumbers).values({
        requestedByUserId: userId,
        phone: result.phone,
        providerBot: newBot,
        repreamMessageId: result.messageId,
        cancelData: result.buttons.cancel,
        freezeData: result.buttons.freeze,
        getCodeData: result.buttons.getCode,
      });

      const keyboard = new InlineKeyboard()
        .text("Cancel", `cancel:${userId}`).icon(EID.NO).danger()
        .text("Freeze", `freeze:${userId}`).icon(EID.LOCK).primary()
        .text("Get Code", `getcode:${userId}`).icon(EID.PHONE).success();

      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `📱 <b>Yangi raqam olindi!</b>\n\n<code>${result.phone}</code>\n\nQuyidagi tugmalardan birini tanlang:`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err: any) {
      logger.error({ err }, "getnew callback error");
      await notifyError(err, "getnew callback error");
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Xato: ${err.message}`,
      );
    }
    })(); // end void getnew worker
  });

  // ── /manualcode — fallback ────────────────────────────────────────────────────
  bot.command("manualcode", async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/);
    if (!parts || parts.length < 2) {
      await ctx.reply(
        "❌ Format: /manualcode <code>+998901234567 12345</code>",
        { parse_mode: "HTML" },
      );
      return;
    }
    const phone = parts[0];
    const otp = parts[1];

    const pending = await db
      .select()
      .from(pendingNumbers)
      .where(
        and(
          eq(pendingNumbers.phone, phone),
          eq(pendingNumbers.requestedByUserId, ctx.from!.id),
        ),
      )
      .orderBy(desc(pendingNumbers.createdAt))
      .limit(1);

    if (!pending.length || !pending[0].phoneCodeHash) {
      await ctx.reply(
        "❌ Bu raqam uchun faol so'rov topilmadi yoki phoneCodeHash yo'q.",
      );
      return;
    }

    const savedHash = pending[0].phoneCodeHash;

    await ctx.reply(`⏳ <code>${phone}</code> ga kirilmoqda...`, {
      parse_mode: "HTML",
    });
    void (async () => {
    try {
      const sessionString = await signInWithCodeAndPass(phone, savedHash, otp, null);

      const claim = await claimUserbotSession(phone, sessionString, ctx.from!.id);
      if (!claim.ok) {
        await ctx.reply(
          `⚠️ <code>${phone}</code> raqami allaqachon boshqa admin tomonidan olingan. O'tkazib yuborildi.`,
          { parse_mode: "HTML" },
        );
        await db
          .update(pendingNumbers)
          .set({ status: "frozen" })
          .where(eq(pendingNumbers.id, pending[0].id));
        return;
      }

      await db
        .update(pendingNumbers)
        .set({ status: "completed", otpCode: otp })
        .where(eq(pendingNumbers.id, pending[0].id));

      await recordStat(ctx.from!.id, "getnumber");
      await recordStat(ctx.from!.id, "session_created");

      const card = await getDefaultCard(ctx.from!.id);

      await ctx.reply(
        card
          ? `⏳ @${PREMIUM_BOT} dan havola olinmoqda... (💳 ****${card.cardNumber.slice(-4)} bilan)`
          : `⏳ @${PREMIUM_BOT} dan havola olinmoqda...`,
      );

      const link = await getLinkFromPremiumBot(sessionString, phone, PREMIUM_BOT, card);

      if (link) {
        await db
          .update(userbotSessions)
          .set({ telegramLink: link })
          .where(eq(userbotSessions.phone, phone));
        await ctx.reply(
          `✅ <b>Muvaffaqiyat!</b>\n\n📱 Raqam: <code>${phone}</code>\n🔗 Havola: ${link}`,
          { parse_mode: "HTML", reply_markup: menuButton() },
        );
      } else {
        await ctx.reply(
          `✅ <b>Sessiya yaratildi!</b>\n\n📱 Raqam: <code>${phone}</code>\n⚠️ @${PREMIUM_BOT} dan havola olinmadi.`,
          { parse_mode: "HTML", reply_markup: menuButton() },
        );
      }
    } catch (err: any) {
      logger.error({ err }, "manualcode error");
      await notifyError(err, "manualcode error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
    })(); // end void manualcode worker
  });

  // ── Menu callbacks ────────────────────────────────────────────────────────────

  // 🏠 Home — re-send main menu
  bot.callbackQuery("menu_home", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await sendMainMenu(ctx, ctx.from.id);
  });

  // 📊 Status
  bot.callbackQuery("menu_status", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const text = await buildOperatorStatusText(ctx.from.id);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: menuButton() });
  });

  // 📱 Get number — show source picker (if >1) then count picker
  bot.callbackQuery("menu_getnumber", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from.id;

    // getMasterClient moved inside void — on reconnect it can block 45 s.
    void (async () => {
    const client = await getMasterClient(uid);
    if (!client) {
      await ctx.reply(
        "❌ Operator hisob ulanmagan.\n\n🔑 Avval login qiling:",
        { reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
      ).catch(() => {});
      return;
    }

    const activeBots = await db
      .select()
      .from(providerBots)
      .where(eq(providerBots.isActive, true));

    if (activeBots.length > 1) {
      const current = operatorSelectedSource.get(uid);
      const kb = new InlineKeyboard();
      for (const b of activeBots) {
        const isSelected = b.username === current;
        kb.text(`@${b.username}`, `src_pick:${b.username}`).icon(isSelected ? EID.OK : EID.ROBOT).primary().row();
      }
      kb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
      await ctx.reply(
        `🌐 <b>Manba bot tanlang</b>\n\n` +
          (current ? `Joriy: @${current}\n\n` : "") +
          `Qaysi botdan raqam olmoqchisiz?`,
        { parse_mode: "HTML", reply_markup: kb },
      ).catch(() => {});
      return;
    }

    if (activeBots.length === 1) {
      operatorSelectedSource.set(uid, activeBots[0].username);
    }

    await ctx.reply(
      `${E.PHONE} <b>Nechta raqam olish kerak?</b>\n\nRaqam olinib, avtomatik sessiya yaratiladi.`,
      { parse_mode: "HTML", reply_markup: countPickerKeyboard() },
    ).catch(() => {});
    })(); // end void menu_getnumber worker
  });

  // 🌐 Source picked — save + show count picker
  bot.callbackQuery(/^src_pick:(.+)$/, async (ctx) => {
    const botname = ctx.match[1];
    const uid = ctx.from.id;
    operatorSelectedSource.set(uid, botname);
    await ctx.answerCallbackQuery(`✅ @${botname} tanlandi`).catch(() => {});

    // getMasterClient moved inside void — on reconnect it can block 45 s.
    void (async () => {
    const client = await getMasterClient(uid);
    if (!client) {
      await ctx.reply("❌ Operator hisob ulanmagan.", {
        reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success(),
      }).catch(() => {});
      return;
    }
    await ctx.reply(
      `${E.PHONE} <b>Nechta raqam olish kerak?</b>\n\n${E.GLOBE} Manba: @${botname}`,
      { parse_mode: "HTML", reply_markup: countPickerKeyboard() },
    ).catch(() => {});
    })(); // end void src_pick worker
  });

  // 🔢 Batch: fetch N numbers fully automatically
  // Only allow the exact approved counts — reject crafted callback data
  const ALLOWED_BATCH_COUNTS = new Set([1, 3, 5, 10, 20]);
  bot.callbackQuery(/^batch_count:(\d+)$/, async (ctx) => {
    const total = parseInt(ctx.match[1]);
    if (!ALLOWED_BATCH_COUNTS.has(total)) {
      await ctx.answerCallbackQuery("❌ Noto'g'ri son.").catch(() => {});
      return;
    }

    const uid = ctx.from.id;

    // ── Per-operator lock: one pipeline at a time (OTP listener is global) ──
    if (batchRunning.has(uid)) {
      await ctx.answerCallbackQuery("⏳ Avvalgi jarayon hali tugamagan, kuting.").catch(() => {});
      return;
    }
    batchRunning.add(uid);
    await ctx.answerCallbackQuery(`⏳ ${total} ta raqam olinmoqda...`).catch(() => {});

    const statusMsg = await ctx.reply(
      `${E.CLOCK} <b>0 / ${total}</b> sessiya yaratildi...\n\n${E.REFRESH} Boshlanmoqda...`,
      { parse_mode: "HTML" },
    );

    const chatId = ctx.chat!.id;
    const msgId = statusMsg.message_id;

    // Detach long work so the grammyjs runner can process other updates from
    // this operator immediately. getMasterClient is inside the IIFE because
    // connectWithCleanup can block up to 45 s on reconnect — calling it
    // outside would freeze the entire handler chain for that long.
    void (async () => {
    const client = await getMasterClient(uid);
    if (!client) {
      batchRunning.delete(uid);
      await ctx.api.editMessageText(chatId, msgId,
        "❌ Operator hisob ulanmagan. /login buyrug'ini yuboring.",
        { reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
      ).catch(() => {});
      return;
    }

    // Use operator's manually selected source bot for this batch
    const srcBot = await getOperatorSource(uid);
    let success = 0;
    let failed = 0;
    const lines: string[] = [];

    const updateProgress = async (note: string) => {
      try {
        await ctx.api.editMessageText(
          chatId, msgId,
          `${E.CLOCK} <b>${success} / ${total}</b> sessiya yaratildi...\n\n${note}`,
          { parse_mode: "HTML" },
        );
      } catch (_) { /* ignore edit rate errors */ }
    };

    // Freeze a pending row and mark its provider-side number as frozen
    const freezePending = async (row: { id: number; repreamMessageId: number | string | null; freezeData: string | null }) => {
      if (row.repreamMessageId && row.freezeData) {
        await clickRepreamButton(
          client, srcBot,
          Number(row.repreamMessageId), row.freezeData,
        ).catch(() => {});
      }
      await db.update(pendingNumbers).set({ status: "frozen" }).where(eq(pendingNumbers.id, row.id));
    };

    try {
      for (let i = 0; i < total; i++) {
        const step = i + 1;

        try {
          // ── 1. Get number ────────────────────────────────────────────────
          await updateProgress(`${E.REFRESH} ${step}/${total}: @${srcBot} dan raqam olinmoqda...`);

          const numResult = await sendCommandAndWaitForNumber(client, srcBot, "/getnumber");
          if (!numResult) {
            lines.push(`${step}. ${E.NO} Raqam olinmadi`);
            failed++;
            continue;
          }

          const phone = numResult.phone;

          // Validate all required button metadata before proceeding
          if (!numResult.messageId || !numResult.buttons.freeze || !numResult.buttons.getCode) {
            lines.push(`${step}. ${E.NO} <code>${phone}</code> — tugma ma'lumoti to'liq emas`);
            failed++;
            continue;
          }

          await updateProgress(`${E.PHONE} ${step}/${total}: <code>${phone}</code> → kod yuborilmoqda...`);

          // Save pending row with providerBot so downstream steps use the right bot
          await db.delete(pendingNumbers).where(
            and(eq(pendingNumbers.requestedByUserId, uid), eq(pendingNumbers.status, "waiting")),
          );
          const [pendingRow] = await db
            .insert(pendingNumbers)
            .values({
              requestedByUserId: uid,
              phone,
              providerBot: srcBot,
              repreamMessageId: numResult.messageId,
              cancelData: numResult.buttons.cancel,
              freezeData: numResult.buttons.freeze,
              getCodeData: numResult.buttons.getCode,
            })
            .returning();

          // ── 2. Send Telegram auth code ───────────────────────────────────
          let phoneCodeHash: string;
          try {
            phoneCodeHash = await sendCodeForPhone(phone);
          } catch (err: any) {
            const msg: string = err?.errorMessage ?? err?.message ?? "";
            logger.error({ err, phone }, "batch sendCodeForPhone error");
            await notifyError(err, "batch sendCodeForPhone error", { phone });
            await freezePending(pendingRow);
            lines.push(`${step}. ${E.NO} <code>${phone}</code> — kod yuborilmadi: ${msg.slice(0, 60)}`);
            failed++;
            continue;
          }

          await db.update(pendingNumbers).set({ phoneCodeHash }).where(eq(pendingNumbers.id, pendingRow.id));
          await updateProgress(`${E.PHONE} ${step}/${total}: <code>${phone}</code> → @${srcBot} dan OTP kutilmoqda...`);

          // ── 3. Click GetCode and wait for OTP ────────────────────────────
          let listenPromise: ReturnType<typeof waitForRepreamCode>;
          try {
            listenPromise = waitForRepreamCode(client, srcBot, Number(pendingRow.repreamMessageId), 35000, [DEFAULT_REPREAM_BOT]);
            await clickRepreamButton(client, srcBot, Number(pendingRow.repreamMessageId), pendingRow.getCodeData!);
          } catch (err: any) {
            logger.error({ err, phone }, "batch clickRepreamButton error");
            await notifyError(err, "batch clickRepreamButton error", { phone });
            await freezePending(pendingRow);
            lines.push(`${step}. ${E.NO} <code>${phone}</code> — GetCode bosilmadi`);
            failed++;
            continue;
          }

          const codeResp = await listenPromise;
          if (!codeResp) {
            await freezePending(pendingRow);
            lines.push(`${step}. ${E.NO} <code>${phone}</code> — 35s kutildi, javob kelmadi`);
            failed++;
            continue;
          }

          const parsed = parseRepreamCodeMessage(codeResp.text);
          if (!parsed.code) {
            logger.warn({ phone, rawText: codeResp.text }, "batch: code not found in repream message");
            await freezePending(pendingRow);
            lines.push(`${step}. ${E.NO} <code>${phone}</code> — kod topilmadi: <code>${codeResp.text.slice(0, 120)}</code>`);
            failed++;
            continue;
          }

          await updateProgress(`${E.PHONE} ${step}/${total}: <code>${phone}</code> → Telegram ga kirilyapti...`);

          // ── 4. Sign in ───────────────────────────────────────────────────
          let sessionString: string;
          try {
            sessionString = await signInWithCodeAndPass(phone, phoneCodeHash, parsed.code, parsed.pass ?? null);
          } catch (err: any) {
            const msg: string = err?.errorMessage ?? err?.message ?? "";
            logger.error({ err, phone }, "batch signInWithCodeAndPass error");
            await notifyError(err, "batch signInWithCodeAndPass error", { phone });
            await freezePending(pendingRow);
            lines.push(`${step}. ${E.NO} <code>${phone}</code> — sign-in xatosi: ${msg.slice(0, 60)}`);
            failed++;
            continue;
          }

          // ── 5. Save session (release temp client in finally so DB failures can't leak it)
          try {
            const claim = await claimUserbotSession(phone, sessionString, uid);
            if (!claim.ok) {
              await db.update(pendingNumbers)
                .set({ status: "frozen" })
                .where(eq(pendingNumbers.id, pendingRow.id));
              lines.push(`${step}. ${E.ALERT} <code>${phone}</code> — allaqachon boshqa admin tomonidan olingan, o'tkazildi`);
              failed++;
              continue;
            }
            await db.update(pendingNumbers)
              .set({ status: "completed", otpCode: parsed.code })
              .where(eq(pendingNumbers.id, pendingRow.id));

            await recordStat(uid, "getnumber");
            await recordStat(uid, "session_created");

            success++;
            lines.push(`${step}. ${E.OK} <code>${phone}</code>`);
          } finally {
            // Release temp client whether DB writes succeed or fail
            await releaseSignedInClient(phone).catch(() => {});
          }
        } catch (err: any) {
          logger.error({ err }, `batch step ${step} unexpected error`);
          await notifyError(err, `batch step ${step} unexpected error`);
          lines.push(`${step}. ${E.NO} Kutilmagan xato: ${err.message?.slice(0, 60)}`);
          failed++;
          // No pending row to freeze here — number was never allocated or already handled
        }
      }
    } finally {
      batchRunning.delete(uid);
    }

    // ── Final summary ────────────────────────────────────────────────────────
    const summary =
      `${success > 0 ? E.OK : E.NO} <b>Jarayon tugadi!</b>\n\n` +
      `${E.OK} Muvaffaqiyat: <b>${success}</b> ta\n` +
      `${E.NO} Xato: <b>${failed}</b> ta\n\n` +
      lines.join("\n\n");

    try {
      await ctx.api.editMessageText(chatId, msgId, summary, {
        parse_mode: "HTML",
        reply_markup: menuButton(),
      });
    } catch (_) {
      await ctx.reply(summary, { parse_mode: "HTML", reply_markup: menuButton() });
    }
    })(); // end void batch worker
  });

  // 📋 Sessions list
  bot.callbackQuery("menu_list", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const sessions = await db
      .select()
      .from(userbotSessions)
      .where(eq(userbotSessions.ownerId, ctx.from.id))
      .orderBy(desc(userbotSessions.createdAt))
      .limit(10);

    if (!sessions.length) {
      await ctx.reply(`${E.EMPTY} Hech qanday userbot sessiyasi yo'q.`, {
        parse_mode: "HTML", reply_markup: menuButton(),
      });
      return;
    }

    const lines = sessions.map((s, i) => {
      const icon = s.status === "active" ? E.OK : E.NO;
      const premiumBadge = s.hasPremium ? ` ${E.STAR}` : "";
      const link = s.telegramLink ? `\n   ${E.LINK} ${s.telegramLink}` : "";
      const expiry = s.hasPremium && s.premiumExpiresAt
        ? `\n   📅 ${s.premiumExpiresAt.toLocaleDateString("uz")}`
        : "";
      return `${i + 1}. ${icon}${premiumBadge} <code>${s.phone}</code>${link}${expiry}`;
    });

    await ctx.reply(
      `${E.NOTE} <b>Userbot sessiyalar (oxirgi 10):</b>\n\n${lines.join("\n\n")}`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Yaroqsizlarni tozalash", "menu_cleanup_sessions").icon(EID.TRASH).danger()
          .row()
          .text("Bosh menyu", "menu_home").icon(EID.HOME).primary(),
      },
    );
  });

  // 🧹 Actively verify all active sessions against Telegram and purge dead ones
  bot.callbackQuery("menu_cleanup_sessions", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const statusMsg = await ctx.reply("🧹 Sessiyalar tekshirilmoqda...");

    let lastEdit = 0;
    const result = await verifyAndPurgeDeadSessions((checked, total) => {
      const now = Date.now();
      if (now - lastEdit < 2000 && checked < total) return; // throttle edits
      lastEdit = now;
      ctx.api
        .editMessageText(statusMsg.chat.id, statusMsg.message_id, `🧹 Tekshirilmoqda: ${checked}/${total}...`)
        .catch(() => {});
    }, activePremiumSessions, ctx.from.id);

    const summary =
      `🧹 <b>Tozalash yakunlandi</b>\n\n` +
      `Tekshirildi: <b>${result.checked}</b> ta\n` +
      `O'chirildi (yaroqsiz): <b>${result.removed.length}</b> ta` +
      (result.removed.length ? `\n${result.removed.map((p) => `  ❌ <code>${p}</code>`).join("\n")}` : "") +
      (result.skipped.length ? `\n⏭ O'tkazib yuborildi (hozir band): <b>${result.skipped.length}</b> ta` : "") +
      (result.errors.length ? `\n\n⚠️ Tekshirib bo'lmadi (vaqtinchalik xato): ${result.errors.length} ta` : "");

    await ctx.api
      .editMessageText(statusMsg.chat.id, statusMsg.message_id, summary, {
        parse_mode: "HTML",
        reply_markup: menuButton(),
      })
      .catch(() => ctx.reply(summary, { parse_mode: "HTML", reply_markup: menuButton() }));
  });

  // ⭐ Get Premium — count picker
  bot.callbackQuery("menu_getpremium", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});

    const [allActive, allCards] = await Promise.all([
      db
        .select()
        .from(userbotSessions)
        .where(and(eq(userbotSessions.status, "active"), eq(userbotSessions.ownerId, ctx.from.id)))
        .orderBy(userbotSessions.createdAt),
      db
        .select()
        .from(savedCards)
        .where(eq(savedCards.userId, ctx.from.id))
        .orderBy(desc(savedCards.createdAt)),
    ]);

    const now = new Date();
    const sessions = allActive.filter(
      (s) => !s.hasPremium || !s.premiumExpiresAt || s.premiumExpiresAt <= now,
    );

    if (!sessions.length) {
      await ctx.reply(
        `${E.OK} Barcha faol sessiyalarda Premium mavjud yoki sessiya yo'q.\n\n` +
          `${E.PHONE} Yangi raqam olish uchun <b>Raqam olish</b> tugmasini bosing.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
      return;
    }

    if (!allCards.length) {
      await ctx.reply(
        "⚠️ Karta saqlanmagan.\n\n💳 Avval /addcard orqali karta qo'shing.",
        { reply_markup: menuButton() },
      );
      return;
    }

    const without = sessions.length;
    const show = sessions.slice(0, 10).map((s, i) =>
      `${i + 1}. <code>${s.phone}</code>`,
    );
    const more = without > 10 ? `\n<i>...va yana ${without - 10} ta</i>` : "";

    await ctx.reply(
      `⭐ <b>Avto Premium olish</b>\n\n` +
        `📋 Premiumsiz sessiyalar: <b>${without}</b> ta\n\n` +
        `<b>Quyidagilar uchun Premium olinadi:</b>\n` +
        `${show.join("\n")}${more}\n\n` +
        `<i>Nechta sessiya uchun Premium olish kerak?</i>`,
      { parse_mode: "HTML", reply_markup: premiumPickerKeyboard() },
    );
  });

  // ⭐ Step 1: Sessiya soni tanlandi → barcha kartalar ro'yxati
  const ALLOWED_PREMIUM_COUNTS = new Set([1, 5, 10]);
  bot.callbackQuery(/^batch_premium:(\d+)$/, async (ctx) => {
    const total = parseInt(ctx.match[1]);
    if (!ALLOWED_PREMIUM_COUNTS.has(total)) {
      await ctx.answerCallbackQuery("❌ Noto'g'ri son.").catch(() => {});
      return;
    }

    const operatorId = ctx.from.id;
    if (batchPremiumRunning.has(operatorId)) {
      await ctx.answerCallbackQuery("⏳ Premium jarayoni allaqachon davom etmoqda, kuting.").catch(() => {});
      return;
    }

    const cards = await db
      .select()
      .from(savedCards)
      .where(eq(savedCards.userId, operatorId))
      .orderBy(desc(savedCards.createdAt));

    if (!cards.length) {
      await ctx.answerCallbackQuery("❌ Karta saqlanmagan!").catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});

    // Build card list with 3-day usage for each
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const kb = new InlineKeyboard();
    const lines: string[] = [];

    for (const c of cards) {
      const usages = await db
        .select()
        .from(cardUsages)
        .where(
          and(
            eq(cardUsages.cardNumber, c.cardNumber),
            eq(cardUsages.operatorId, operatorId),
            gte(cardUsages.usedAt, threeDaysAgo),
          ),
        );
      const used = usages.length;
      const remaining = Math.max(0, 5 - used);
      const label = c.bankName ?? c.cardHolder;
      const statusIcon = remaining === 0 ? "🔴" : remaining <= 2 ? "🟡" : "🟢";
      if (remaining > 0) {
        kb.text(`${label} ${c.cardNumberMasked} ${statusIcon} ${used}/5`, `batch_premium_card:${total}:${c.id}`)
          .icon(c.isDefault ? EID.STAR : EID.CARD).success().row();
      } else {
        kb.text(`${label} ${c.cardNumberMasked} ${statusIcon} ${used}/5`, `card_limit_exceeded`)
          .icon(EID.CARD).danger().row();
      }
      lines.push(`${c.isDefault ? "⭐ " : "💳 "}<b>${label}</b> <code>${c.cardNumberMasked}</code> — ${used}/5 ishlatilgan`);
    }
    kb.text("Orqaga", "menu_getpremium").icon(EID.STAR).primary()
      .text("Bosh menyu", "menu_home").icon(EID.HOME).primary();

    await ctx.reply(
      `💳 <b>Karta tanlang</b>\n\n` +
        `<i>${total} ta sessiya uchun Premium olinadi.</i>\n\n` +
        lines.join("\n") +
        `\n\n🟢 bo'sh | 🟡 kam qoldi | 🔴 tugagan`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ⭐ Step 2: Karta tanlandi → nechtasini so'rash
  bot.callbackQuery(/^batch_premium_card:(\d+):(\d+)$/, async (ctx) => {
    const total  = parseInt(ctx.match[1]); // session count
    const cardId = parseInt(ctx.match[2]); // selected card id
    if (!ALLOWED_PREMIUM_COUNTS.has(total) || isNaN(cardId)) {
      await ctx.answerCallbackQuery("❌ Noto'g'ri tanlov.").catch(() => {});
      return;
    }

    const operatorId = ctx.from.id;
    const [cardRow] = await db
      .select()
      .from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, operatorId)))
      .limit(1);

    if (!cardRow) {
      await ctx.answerCallbackQuery("❌ Karta topilmadi.").catch(() => {});
      return;
    }

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const usages = await db
      .select()
      .from(cardUsages)
      .where(
        and(
          eq(cardUsages.cardNumber, cardRow.cardNumber),
          eq(cardUsages.operatorId, operatorId),
          gte(cardUsages.usedAt, threeDaysAgo),
        ),
      );
    const usedIn3Days = usages.length;
    const remaining = Math.max(0, 5 - usedIn3Days);
    const label = cardRow.bankName ?? cardRow.cardHolder;

    await ctx.answerCallbackQuery().catch(() => {});

    if (remaining === 0) {
      await ctx.reply(
        `⛔ <b>Karta limiti tugagan</b>\n\n` +
          `💳 <b>${label}</b> <code>${cardRow.cardNumberMasked}</code>\n` +
          `So'nggi 3 kunda allaqachon <b>5 marta</b> ishlatilgan.\n\n` +
          `🕐 Limit yangilanishi uchun kuting yoki boshqa karta tanlang.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
            .text("◀️ Kartalar", `batch_premium:${total}`)
            .text("🏠 Bosh menyu", "menu_home") },
      );
      return;
    }

    await ctx.reply(
      `💳 <b>Nechta obuna olish kerak?</b>\n\n` +
        `Karta: <b>${label}</b> <code>${cardRow.cardNumberMasked}</code>\n` +
        `So'nggi 3 kunda: <b>${usedIn3Days}/5</b> marta ishlatilgan\n` +
        `Qolgan: <b>${remaining} ta</b>\n\n` +
        `<i>Bu karta bilan nechta raqamga Premium olish kerak?</i>`,
      { parse_mode: "HTML", reply_markup: cardUsagePickerKeyboard(total, usedIn3Days, cardId) },
    );
  });

  // Limit tugagan tugma bosilganda
  bot.callbackQuery("card_limit_exceeded", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "⛔ Bu variant karta limitidan oshadi (max 5/3kun).", show_alert: true }).catch(() => {});
  });

  // ⭐ Step 3: Obuna soni tanlandi → batch run
  const ALLOWED_CARD_USES = new Set([1, 2, 3, 4, 5]);
  bot.callbackQuery(/^batch_premium_run:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const total     = parseInt(ctx.match[1]); // session count selected
    const cardLimit = parseInt(ctx.match[2]); // subscription count selected
    const cardId    = parseInt(ctx.match[3]); // selected card id
    if (!ALLOWED_PREMIUM_COUNTS.has(total) || !ALLOWED_CARD_USES.has(cardLimit) || isNaN(cardId)) {
      await ctx.answerCallbackQuery("❌ Noto'g'ri tanlov.").catch(() => {});
      return;
    }

    const operatorId = ctx.from.id;
    if (batchPremiumRunning.has(operatorId)) {
      await ctx.answerCallbackQuery("⏳ Premium jarayoni allaqachon davom etmoqda, kuting.").catch(() => {});
      return;
    }

    // Fetch the operator-selected card (verified by ownership)
    const [cardRow] = await db
      .select()
      .from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, operatorId)))
      .limit(1);
    if (!cardRow) {
      await ctx.answerCallbackQuery("❌ Karta topilmadi yoki sizga tegishli emas!").catch(() => {});
      return;
    }
    const card = {
      cardNumber: cardRow.cardNumber,
      expiry:     cardRow.expiry,
      cvv:        cardRow.cvv,
      cardHolder: cardRow.cardHolder,
    };

    // Re-check 3-day limit at run time
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const usages = await db
      .select()
      .from(cardUsages)
      .where(
        and(
          eq(cardUsages.cardNumber, card.cardNumber),
          eq(cardUsages.operatorId, operatorId),
          gte(cardUsages.usedAt, threeDaysAgo),
        ),
      );
    const usedNow = usages.length;
    const actualLimit = Math.min(cardLimit, Math.max(0, 5 - usedNow));

    if (actualLimit === 0) {
      await ctx.answerCallbackQuery({ text: "⛔ Karta limiti tugagan (max 5/3kun).", show_alert: true }).catch(() => {});
      return;
    }

    // Fetch active sessions without premium, cap at min(total, actualLimit)
    const runCount = Math.min(total, actualLimit);
    const now = new Date();
    const allSessions = await db
      .select()
      .from(userbotSessions)
      .where(and(eq(userbotSessions.status, "active"), eq(userbotSessions.ownerId, operatorId)))
      .orderBy(userbotSessions.createdAt);

    const targets = allSessions
      .filter((s) =>
        (!s.hasPremium || !s.premiumExpiresAt || s.premiumExpiresAt <= now) &&
        !activePremiumSessions.has(s.phone), // skip sessions already being processed
      )
      .slice(0, runCount);

    if (!targets.length) {
      await ctx.answerCallbackQuery("✅ Premiumsiz sessiya topilmadi.").catch(() => {});
      return;
    }

    const chatId = ctx.chat!.id;
    let success = 0;
    let failed = 0;
    // Indexed by step-1 so completed results keep their original order even
    // though sessions can finish out of order under concurrency.
    const lines: string[] = new Array(targets.length).fill("");
    // phone → latest live progress line, shown for sessions currently in flight.
    const liveStatus = new Map<string, string>();
    let msgId = 0;
    // phone → message_id of that phone's single "action needed" message (3DS
    // OTP prompt, bank-3DS instructions, evro-retry notice, auto-detect
    // result, ...). Reusing one message per phone (edited in place) instead
    // of sending a new message for every step keeps the chat from flooding
    // with messages when several numbers need attention at once.
    const actionMsgId = new Map<string, number>();
    const sendOrEditAction = async (
      phone: string,
      text: string,
      keyboard?: InlineKeyboard,
    ): Promise<number | null> => {
      const existing = actionMsgId.get(phone);
      if (existing) {
        try {
          await ctx.api.editMessageText(chatId, existing, text, {
            parse_mode: "HTML",
            ...(keyboard ? { reply_markup: keyboard } : {}),
          });
          return existing;
        } catch (_) {
          // Message may have been deleted or is otherwise un-editable — fall
          // through and send a fresh one below.
        }
      }
      const sent = await ctx.api
        .sendMessage(chatId, text, {
          parse_mode: "HTML",
          ...(keyboard ? { reply_markup: keyboard } : {}),
        })
        .catch(() => null);
      if (sent) actionMsgId.set(phone, sent.message_id);
      return sent?.message_id ?? null;
    };

    // ── Relay-triggered start ────────────────────────────────────────────────
    // On request: session i+1 does not begin its own flow until session i
    // sends its bank-3DS verification URL to the admin (the "Bank 3DS!"
    // message with the URL button, below). Once triggered, the new session
    // runs steps 1-4 and continues straight to step 5 (SendPaymentForm) — no
    // extra pacing delay after step 4 anymore (removed on request). Session 1
    // starts immediately (relayGates[0] is pre-resolved); every later session
    // waits on the previous one's gate.
    const relayResolvers: Array<(() => void) | null> = new Array(targets.length).fill(null);
    const relayGates: Promise<void>[] = targets.map((_, i) => {
      if (i === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        relayResolvers[i] = resolve;
      });
    });
    const triggerRelayNext = (i: number) => {
      const resolve = relayResolvers[i + 1];
      if (resolve) {
        relayResolvers[i + 1] = null; // guard against double-trigger on retries
        resolve();
      }
    };

    const renderProgress = () => {
      const completed = lines.filter(Boolean).join("\n");
      const activeLines = [...liveStatus.entries()]
        .map(([phone, text]) => `🔄 <code>${phone}</code>: ${text}`)
        .join("\n");
      const parts: string[] = [];
      if (completed) parts.push(`📋 <b>Yakunlangan:</b>\n${completed}`);
      if (activeLines) parts.push(`⏳ <b>Jarayonda:</b>\n${activeLines}`);
      return parts.length ? parts.join("\n\n") : "🔄 Boshlanmoqda...";
    };

    const updateProgress = async () => {
      if (!msgId) return;
      try {
        await ctx.api.editMessageText(
          chatId,
          msgId,
          `⭐ <b>Avto Premium — ${success + failed} / ${targets.length}</b>\n\n${renderProgress()}`,
          { parse_mode: "HTML" },
        );
      } catch (_) {}
    };

    batchPremiumRunning.add(operatorId);
    try {
      await ctx.answerCallbackQuery(`⏳ ${targets.length} ta sessiya uchun Premium olinmoqda...`).catch(() => {});

      const statusMsg = await ctx.reply(
        `⭐ <b>Avto Premium — 0 / ${targets.length}</b>\n\n🔄 Boshlanmoqda...`,
        { parse_mode: "HTML" },
      );
      msgId = statusMsg.message_id;

      // Detach long work — grammyjs sequential-per-chat rule would block all
      // other button presses from this operator while premium flow runs.
      void (async () => {
      const processOneTarget = async (session: (typeof targets)[number], step: number): Promise<void> => {
        const phone = session.phone;
        const relayIndex = step - 1;

        // Relay gate: wait for the previous session to send its 3DS URL to
        // the admin before this session starts anything at all.
        await relayGates[relayIndex];

        // Double-check: another operator might have claimed this session between
        // the initial filter and now.
        if (activePremiumSessions.has(phone)) {
          lines[step - 1] = `${step}. ⏭ <code>${phone}</code> — boshqa operator ishlamoqda, o'tkazildi`;
          await updateProgress();
          return;
        }
        activePremiumSessions.add(phone);
        liveStatus.set(phone, "boshlanmoqda...");
        await updateProgress();

        let userClient: any = null;
        let restartCount = 0;
        // Per-target card override — starts as the batch-selected card, but
        // can be swapped if the operator picks a different one after a
        // PAYMENT_FAILED decline (see paymentDeclined handling below).
        let activeCard = card;
        let activeCardId = cardId;
        let activeCardLabel = cardRow.bankName ?? cardRow.cardHolder;
        let cardRetryCount = 0;
        const MAX_CARD_RETRIES = 3;
        // Automatic same-card retries after a PAYMENT_FAILED decline — a decline
        // is often an anti-fraud signal tied to the tokenizing proxy's IP rather
        // than the card itself, so retry silently with a fresh IP (proxy cooldown
        // rotation, see getProxyConfig) before ever bothering the operator with
        // the manual "pick a different card" picker below.
        let sameCardRetryCount = 0;
        const MAX_SAME_CARD_RETRIES = 2;

        try {
        while (true) {
          const attemptId = `${operatorId}_${phone}_${Date.now()}`;
          // step6Promise is created inside onVerificationNeeded (before the message is
          // sent) so the Map key is ready before the operator can press any button.
          let step6Promise: Promise<void> | null = null;

          try {
            if (userClient) {
              try { await userClient.disconnect(); } catch (_) {}
            }
            userClient = await createClientFromSession(session.sessionString);

            const verifierBot = await getDefaultVerifierBot();
            const [pendingRow] = await db
              .select()
              .from(pendingNumbers)
              .where(eq(pendingNumbers.phone, phone))
              .limit(1);
            const checkProviderBot = pendingRow?.providerBot ?? verifierBot;
            const checkMsgId = pendingRow?.repreamMessageId
              ? Number(pendingRow.repreamMessageId)
              : undefined;

            const result = await withTimeout(runFullPremiumFlow(
              userClient,
              PREMIUM_BOT,
              checkProviderBot,
              activeCard,
              async (progressMsg) => {
                liveStatus.set(
                  phone,
                  restartCount > 0 ? `(${restartCount}-urinish) ${progressMsg}` : progressMsg,
                );
                await updateProgress();
              },
              // ── 3DS OTP callback ──────────────────────────────────────────
              async () => {
                return new Promise<string | null>((resolve) => {
                  pendingOtpCallbacks.set(attemptId, resolve);
                  addActiveOtpFlow(operatorId, attemptId);

                  sendOrEditAction(
                    phone,
                    `🔐 <b>${step}/${targets.length}: <code>${phone}</code> — 3DS kod kerak!</b>\n\n` +
                      `📱 Kartangiz raqamiga SMS kod yuborildi.\n\n` +
                      `Kodni shu yerga yuboring (120 soniya):\n<i>Misol: 123456</i>`,
                  ).catch(() => {});

                  // OTP auto-expire: always resolve regardless of whether the
                  // key was already deleted by the inner finally. Idempotent.
                  const otpTimer = setTimeout(() => {
                    pendingOtpCallbacks.delete(attemptId); // no-op if already cleaned up
                    removeActiveOtpFlow(operatorId, attemptId);
                    sendOrEditAction(
                      phone,
                      `⏱ ${step}/${targets.length}: <code>${phone}</code> — 3DS kod 120s da kiritilmadi.`,
                    ).catch(() => {});
                    resolve(null); // always settle — prevents orphaned flow
                  }, 120_000);

                  pendingOtpCallbacks.set(attemptId, (otp) => {
                    clearTimeout(otpTimer);
                    removeActiveOtpFlow(operatorId, attemptId);
                    resolve(otp);
                  });
                });
              },
              // ── 3DS bank verification URL callback ─────────────────────────
              // step6Promise is created HERE (before the message is sent) so the
              // operator can never press a button before the resolver exists.
              async (verificationUrl: string) => {
                // No auto-continue timer here by design — step6Promise only
                // settles via an explicit operator button press or the
                // auto-detect poll below.
                step6Promise = new Promise<void>((resolve, reject) => {
                  pendingStep6Callbacks.set(attemptId, (choice) => {
                    if (choice === "abort") reject(new FlowAbortError());
                    else if (choice === "restart") reject(new FlowRestartError());
                    else if (choice === "step6_timeout") reject(new FlowStep6TimeoutError());
                    else resolve();
                  });
                });
                // See single-flow note: no-op catch closes the unhandled-rejection
                // window if the operator presses a button before step-6 awaits.
                step6Promise?.catch(() => {});

                // Plain `.url()` link, not `.webApp()` — see single-flow note above.
                const keyboard = new InlineKeyboard()
                  .url("🔐 3DS tasdiqlash", verificationUrl)
                  .row()
                  .text("✅ 3DS Tugadi — Davom et", `step6_done:${attemptId}`)
                  .row()
                  .text("💶 Evro (qayta urinish)", `step6_euro:${attemptId}`)
                  .text("❌ Bekor qilish", `step6_abort:${attemptId}`);
                await sendOrEditAction(
                  phone,
                  `🔐 <b>${step}/${targets.length}: <code>${phone}</code> — Bank 3DS!</b>\n\n` +
                    `1️⃣ Quyidagi tugmani bosib brauzerda oching\n` +
                    `2️⃣ Bank SMS kodini kiritib tasdiqlang\n` +
                    `3️⃣ <b>✅ 3DS Tugadi — Davom et</b> tugmasini bosing\n\n` +
                    `💶 Evro chiqsa — <b>Evro (qayta urinish)</b> tugmasini bosing\n\n` +
                    `🤖 Yoki hech narsa bosmasangiz ham, bot @${PREMIUM_BOT} ga har 20 soniyada /start yuborib avtomatik tekshiradi.`,
                  keyboard,
                );

                // URL admin'ga yuborildi — navbatdagi sessiyani shu yerda ishga tushiramiz.
                triggerRelayNext(relayIndex);

                // ── Auto-detect fallback ─────────────────────────────────────────
                // See single-flow note above: polls @premiumbot's /start reply up
                // to 10x (every 30s, ~5 min total) and resolves step6Promise
                // itself if Premium is already confirmed active. If all 10
                // attempts pass with no confirmation and the operator never
                // pressed a button, this session is marked an automatic failure
                // instead of blocking the batch run forever.
                (async () => {
                  const active = await pollPremiumActiveViaStart(userClient, PREMIUM_BOT, 10, 30000).catch(() => false);
                  const cb = pendingStep6Callbacks.get(attemptId);
                  if (!cb) return; // already resolved by button click
                  pendingStep6Callbacks.delete(attemptId);
                  const trackedMsgId = actionMsgId.get(phone);
                  if (trackedMsgId != null) ctx.api.editMessageReplyMarkup(chatId, trackedMsgId).catch(() => {});
                  if (active) {
                    sendOrEditAction(
                      phone,
                      `✅ ${step}/${targets.length}: <code>${phone}</code> — Premium avtomatik aniqlandi (@${PREMIUM_BOT} /start orqali) — davom etilmoqda.`,
                    ).catch(() => {});
                    cb("continue");
                  } else {
                    sendOrEditAction(
                      phone,
                      `❌ ${step}/${targets.length}: <code>${phone}</code> — 10 marta tekshirildi (5 daqiqa), Premium aniqlanmadi. Avtomatik muvaffaqiyatsiz deb belgilandi.`,
                    ).catch(() => {});
                    cb("step6_timeout");
                  }
                })();
              },
              checkMsgId,
              // Step-6: await the Promise created inside onVerificationNeeded. If
              // bank 3DS wasn't triggered, step6Promise is null → return at once.
              async () => {
                if (!step6Promise) return;
                await step6Promise;
              },
              // Step-8: master client for repream premium check after logout
              await getMasterClient(operatorId) ?? undefined,
              // Relay pacing after step 4 was removed on request — step 5 now
              // begins immediately once step 4 (card tokenized) completes.
              undefined,
            ), PREMIUM_FLOW_TOTAL_TIMEOUT, `Premium jarayoni (${phone})`);

            // Premium tasdiqlangan — sessiyani DBdan o'chirish + karta ishlatishini qayd etish
            if (result.hasPremium) {
              await Promise.all([
                db.delete(userbotSessions).where(eq(userbotSessions.phone, phone)),
                db.insert(cardUsages).values({
                  cardNumber: activeCard.cardNumber,
                  operatorId,
                  phone,
                }),
                recordStat(operatorId, "premium_obtained"),
              ]);
            }

            const expStr = result.premiumExpiresAt
              ? ` (${result.premiumExpiresAt.toLocaleDateString("uz")})`
              : "";
            const autoRenewalStr =
              result.autoRenewalCancelled === undefined
                ? ""
                : result.autoRenewalCancelled
                  ? ` — obuna: bekor qilindi`
                  : ` — obuna: bekor qilinmagan bo'lishi mumkin`;

            if (result.success) {
              success++;
              lines[step - 1] = result.hasPremium
                ? `${step}. ⭐ <code>${phone}</code>${expStr}${autoRenewalStr}`
                : `${step}. ✅ <code>${phone}</code> — ${result.message}${autoRenewalStr}`;
              break;
            }

            // ── PAYMENT_FAILED: auto-retry the same card with a fresh IP first ──
            // Proxy IP was already put on cooldown inside runFullPremiumFlow, so
            // the very next runFullPremiumFlow call below will pick a different
            // one via getProxyConfig(). Try this silently (no operator prompt)
            // a couple of times before assuming the card itself is the problem.
            if (result.paymentDeclined && sameCardRetryCount < MAX_SAME_CARD_RETRIES) {
              sameCardRetryCount++;
              await sendOrEditAction(
                phone,
                `🔁 ${step}/${targets.length}: <code>${phone}</code> — to'lov rad etildi, IP o'zgartirilib qayta urinilmoqda (${sameCardRetryCount}/${MAX_SAME_CARD_RETRIES})...`,
              ).catch(() => {});
              continue;
            }

            // ── PAYMENT_FAILED (after same-card retries exhausted): offer the
            // operator a different saved card — the decline can also be a
            // genuinely card-side rejection (insufficient funds, blocked card).
            if (result.paymentDeclined && cardRetryCount < MAX_CARD_RETRIES) {
              const threeDaysAgoRetry = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
              const otherCards = await db
                .select()
                .from(savedCards)
                .where(eq(savedCards.userId, operatorId))
                .orderBy(desc(savedCards.createdAt));

              const usable: typeof otherCards = [];
              for (const c of otherCards) {
                if (c.id === activeCardId) continue;
                const usages = await db
                  .select()
                  .from(cardUsages)
                  .where(
                    and(
                      eq(cardUsages.cardNumber, c.cardNumber),
                      eq(cardUsages.operatorId, operatorId),
                      gte(cardUsages.usedAt, threeDaysAgoRetry),
                    ),
                  );
                if (usages.length < 5) usable.push(c);
              }

              if (usable.length > 0) {
                const retryKb = new InlineKeyboard();
                for (const c of usable) {
                  const label = c.bankName ?? c.cardHolder;
                  retryKb.text(`💳 ${label} ${c.cardNumberMasked}`, `card_retry:${attemptId}:${c.id}`).row();
                }
                retryKb.text("❌ Bekor qilish (xato deb belgila)", `card_retry_cancel:${attemptId}`);

                const choice = await new Promise<number | "cancel">((resolve) => {
                  const retryTimer = setTimeout(() => {
                    pendingCardRetryCallbacks.delete(attemptId); // no-op if already resolved
                    resolve("cancel");
                  }, 90_000);
                  pendingCardRetryCallbacks.set(attemptId, (c) => {
                    clearTimeout(retryTimer);
                    resolve(c);
                  });
                  sendOrEditAction(
                    phone,
                    `❌ <b>${step}/${targets.length}: <code>${phone}</code> — to'lov rad etildi</b>\n\n` +
                      `💳 <b>${activeCardLabel}</b> kartasi bilan to'lov o'tmadi.\n\n` +
                      `Boshqa karta bilan qayta urinib ko'rasizmi? (90s):`,
                    retryKb,
                  ).catch(() => {});
                });

                if (choice !== "cancel") {
                  const [newCardRow] = await db
                    .select()
                    .from(savedCards)
                    .where(and(eq(savedCards.id, choice), eq(savedCards.userId, operatorId)))
                    .limit(1);
                  if (newCardRow) {
                    cardRetryCount++;
                    activeCardId = newCardRow.id;
                    activeCardLabel = newCardRow.bankName ?? newCardRow.cardHolder;
                    activeCard = {
                      cardNumber: newCardRow.cardNumber,
                      expiry: newCardRow.expiry,
                      cvv: newCardRow.cvv,
                      cardHolder: newCardRow.cardHolder,
                    };
                    await sendOrEditAction(
                      phone,
                      `🔄 ${step}/${targets.length}: <code>${phone}</code> — ${activeCardLabel} kartasi bilan qayta urinilmoqda...`,
                    ).catch(() => {});
                    continue;
                  }
                }
              }
            }

            failed++;
            lines[step - 1] = `${step}. ❌ <code>${phone}</code> — ${result.message}`;
            break;

          } catch (err: any) {
            if (err instanceof FlowRestartError) {
              restartCount++;
              if (restartCount > MAX_PREMIUM_RESTARTS) {
                failed++;
                lines[step - 1] = `${step}. ❌ <code>${phone}</code> — ${MAX_PREMIUM_RESTARTS}x qayta urinish, to'xtatildi`;
                break;
              }
              await sendOrEditAction(
                phone,
                `🔄 ${step}/${targets.length}: <code>${phone}</code> — Evro aniqlandi, ${restartCount}-urinish...`,
              ).catch(() => {});
              continue;
            }
            if (err instanceof FlowAbortError) {
              failed++;
              lines[step - 1] = `${step}. ❌ <code>${phone}</code> — operator bekor qildi`;
              break;
            }
            if (err instanceof FlowStep6TimeoutError) {
              failed++;
              lines[step - 1] = `${step}. ❌ <code>${phone}</code> — 3DS tasdiqlanmadi (5 daqiqa, avto-muvaffaqiyatsiz)`;
              break;
            }
            if (isSessionInvalidError(err)) {
              await markUserbotSessionInvalid(phone, err.message ?? String(err));
              failed++;
              lines[step - 1] = `${step}. ❌ <code>${phone}</code> — sessiya yaroqsiz, avtomatik tozalashga qo'yildi`;
              break;
            }
            logger.error({ err, phone }, "batch_premium_run flow error");
            await notifyError(err, "batch_premium_run flow error", { phone });
            failed++;
            lines[step - 1] = `${step}. ❌ <code>${phone}</code> — ${err.message?.slice(0, 60) ?? "xato"}`;
            break;
          } finally {
            pendingStep6Callbacks.delete(attemptId);
            pendingOtpCallbacks.delete(attemptId);
            pendingCardRetryCallbacks.delete(attemptId);
            removeActiveOtpFlow(operatorId, attemptId);
            if (userClient) {
              try { await userClient.disconnect(); } catch (_) {}
              userClient = null;
            }
          }
        }

        } finally {
          activePremiumSessions.delete(phone);
          liveStatus.delete(phone);
          actionMsgId.delete(phone);
          // Safety net: if this session ended (success OR failure) without ever
          // sending a 3DS URL, the next session's relay gate would otherwise
          // wait forever. triggerRelayNext is idempotent (guarded against
          // double-fire), so this is a no-op if the URL was already sent.
          triggerRelayNext(relayIndex);
        }

        await updateProgress();
      };

      // ── Relay launch ───────────────────────────────────────────────────────
      // All targets are launched together, but each one's real work is gated
      // by relayGates[i] (see above) — session i+1 only starts once session i
      // has sent its bank-3DS URL to the admin. This replaces the old
      // fixed-size worker pool: the relay chain itself now defines how many
      // sessions can be in flight, while PLAYWRIGHT_MAX_CONCURRENCY=1 still
      // guarantees only one card is ever being submitted to the bank at once.
      await Promise.all(targets.map((t, idx) => processOneTarget(t, idx + 1)));

      // Final summary
      const summary =
        `${success > 0 ? "⭐" : "❌"} <b>Avto Premium yakunlandi!</b>\n\n` +
        `✅ Muvaffaqiyat: <b>${success}</b> ta\n` +
        `❌ Xato: <b>${failed}</b> ta\n\n` +
        lines.filter(Boolean).join("\n");

      try {
        await ctx.api.editMessageText(chatId, msgId, summary, {
          parse_mode: "HTML",
          reply_markup: menuButton(),
        });
      } catch (_) {
        await ctx.reply(summary, { parse_mode: "HTML", reply_markup: menuButton() });
      }
      })(); // end void premium worker
    } finally {
      batchPremiumRunning.delete(operatorId);
    }
  });

  // 🤖 Verifier bots management
  bot.callbackQuery("menu_verifiers", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const bots = await db.select().from(verifierBots).orderBy(verifierBots.addedAt);

    const kb = new InlineKeyboard();
    for (const b of bots) {
      const iconId = !b.isActive ? EID.BAN : b.isDefault ? EID.STAR : EID.ROBOT;
      kb.text(`@${b.username}`, `verifier_detail:${b.id}`)
        .icon(iconId)
        [!b.isActive ? "danger" : b.isDefault ? "success" : "primary"]()
        .row();
    }
    kb.text("Bot qo'shish", "verifier_add").icon(EID.ADD).success().row();
    kb.text("Premium menyu", "menu_getpremium").icon(EID.BACK).primary()
      .text("Bosh menyu", "menu_home").icon(EID.HOME).primary();

    const lines = bots.map((b) => {
      const status = !b.isActive ? `${E.BAN} O'chirilgan` : b.isDefault ? `${E.STAR} Default` : `${E.OK} Faol`;
      return `• @${b.username} — ${status}`;
    });

    await ctx.reply(
      `${E.ROBOT} <b>Premium verifier botlar</b>\n\n` +
        (lines.length ? lines.join("\n") : "Hali bot qo'shilmagan.") +
        `\n\n${E.STAR} — asosiy (default) bot`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // 🤖 Verifier bot detail
  bot.callbackQuery(/^verifier_detail:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    const [bot_row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    if (!bot_row) { await ctx.reply("Bot topilmadi.", { reply_markup: menuButton() }); return; }

    const kb = new InlineKeyboard();
    if (!bot_row.isDefault) kb.text("Default qilish", `verifier_default:${id}`).icon(EID.STAR).success().row();
    if (bot_row.isActive) kb.text("O'chirish", `verifier_disable:${id}`).icon(EID.BAN).danger().row();
    else kb.text("Yoqish", `verifier_enable:${id}`).icon(EID.OK).success().row();
    kb.text("O'chirish", `verifier_remove:${id}`).icon(EID.TRASH).danger().row();
    kb.text("Orqaga", "menu_verifiers").icon(EID.BACK).primary();

    const status = !bot_row.isActive ? `${E.BAN} O'chirilgan` : bot_row.isDefault ? `${E.STAR} Default` : `${E.OK} Faol`;
    await ctx.reply(
      `${E.ROBOT} <b>@${bot_row.username}</b>\n\nHolat: ${status}`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ⭐ Set default verifier bot
  bot.callbackQuery(/^verifier_default:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    // Clear all defaults then set new one
    await db.update(verifierBots).set({ isDefault: false });
    await db.update(verifierBots).set({ isDefault: true, isActive: true }).where(eq(verifierBots.id, id));
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await ctx.reply(`${E.STAR} <b>@${row?.username ?? id}</b> default verifier bot qilib belgilandi!`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary(),
    });
  });

  // 🚫 Disable verifier bot
  bot.callbackQuery(/^verifier_disable:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    await db.update(verifierBots).set({ isActive: false, isDefault: false }).where(eq(verifierBots.id, id));
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await ctx.reply(`${E.BAN} <b>@${row?.username ?? id}</b> o'chirildi.`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary(),
    });
  });

  // ✅ Enable verifier bot
  bot.callbackQuery(/^verifier_enable:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    await db.update(verifierBots).set({ isActive: true }).where(eq(verifierBots.id, id));
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await ctx.reply(`${E.OK} <b>@${row?.username ?? id}</b> yoqildi.`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary(),
    });
  });

  // 🗑 Remove verifier bot
  bot.callbackQuery(/^verifier_remove:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await db.delete(verifierBots).where(eq(verifierBots.id, id));
    await ctx.reply(`${E.TRASH} <b>@${row?.username ?? id}</b> o'chirildi.`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary(),
    });
  });

  // ➕ Add verifier bot — prompt
  bot.callbackQuery("verifier_add", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    awaitingVerifierInput.add(ctx.from.id);
    await ctx.reply(
      `${E.ADD} <b>Verifier bot qo'shish</b>\n\nBot username kiriting (@ bilan yoki usiz):\n\nMisol: <code>RePreAmooBot</code>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Bekor", "menu_verifiers").icon(EID.NO).danger() },
    );
  });

  // 💳 Cards list
  bot.callbackQuery("menu_cards", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const cards = await db
      .select()
      .from(savedCards)
      .where(eq(savedCards.userId, ctx.from.id))
      .orderBy(desc(savedCards.createdAt));

    if (!cards.length) {
      await ctx.reply(
        `${E.CARD} Saqlangan kartalar yo'q.\n\n/addcard buyrug'i bilan karta qo'shing.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
      return;
    }

    const lines = cards.map(
      (c, i) =>
        `${i + 1}. ${c.isDefault ? `${E.STAR} ` : ""}🏦 <b>${c.bankName ?? c.cardHolder}</b>\n` +
        `   <code>${c.cardNumberMasked}</code> | ${c.expiry}`,
    );

    const kb = new InlineKeyboard();
    for (const c of cards) {
      const label = `${c.bankName ?? c.cardHolder} ${c.cardNumberMasked}`;
      kb.text(label, `card_detail:${c.id}`)
        .icon(c.isDefault ? EID.STAR : EID.CARD)
        [c.isDefault ? "success" : "primary"]()
        .row();
    }
    kb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();

    await ctx.reply(
      `${E.CARD} <b>Saqlangan kartalar (${cards.length} ta):</b>\n\n${lines.join("\n\n")}\n\n${E.STAR} — asosiy karta`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // 🔑 Login instructions
  bot.callbackQuery("menu_login", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;

    if (!await isAnySuperAdmin(operatorId)) {
      await ctx.answerCallbackQuery({ text: "❌ Faqat super admin uchun.", show_alert: true }).catch(() => {});
      return;
    }

    // Load all slots for this SA
    const rows = await db
      .select()
      .from(masterSessions)
      .where(eq(masterSessions.operatorId, operatorId))
      .orderBy(asc(masterSessions.slot));

    const slotMap = new Map(rows.map(r => [r.slot, r]));

    const kb = new InlineKeyboard();
    for (let s = 1; s <= 3; s++) {
      const row = slotMap.get(s);
      if (row) {
        kb.text(`Slot ${s}: O'chirish`, `login_delete_confirm:${s}`).icon(EID.TRASH).danger().row();
      } else {
        kb.text(`Slot ${s}: Ulash`, `login_slot_add:${s}`).icon(EID.ADD).success().row();
      }
    }
    if (rows.length > 0) {
      kb.text("Ulashish", "master_share_list").icon(EID.SHARE).primary().row();
    }
    kb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();

    const lines = [1, 2, 3].map(s => {
      const row = slotMap.get(s);
      return row
        ? `${E.OK} Slot ${s}: <code>${row.phone}</code>`
        : `${E.NO} Slot ${s}: Bo'sh`;
    });

    await ctx.reply(
      `${E.KEY} <b>Operator loginlar</b>\n\n${lines.join("\n")}\n\nMaksimum 3 ta telefon ulash mumkin.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // Slot "Ulash" — show /login instructions
  bot.callbackQuery(/^login_slot_add:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!await isAnySuperAdmin(ctx.from.id)) return;
    const slot = parseInt(ctx.match[1]);
    await ctx.reply(
      `${E.ADD} <b>Slot ${slot} — Login</b>\n\nTelefon raqamingizni yuboring:\n<code>/login +998901234567</code>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Orqaga", "menu_login").icon(EID.KEY).primary() },
    );
  });

  bot.callbackQuery(/^login_delete_confirm:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!await isAnySuperAdmin(ctx.from.id)) return;
    const slot = parseInt(ctx.match[1]);
    const row = await db
      .select({ phone: masterSessions.phone })
      .from(masterSessions)
      .where(and(eq(masterSessions.operatorId, ctx.from.id), eq(masterSessions.slot, slot)))
      .limit(1);
    const kb = new InlineKeyboard()
      .text("Ha, o'chir", `login_delete_do:${slot}`).icon(EID.TRASH).danger()
      .text("Bekor", "menu_login").icon(EID.NO).primary();
    await ctx.reply(
      `${E.ALERT} <b>Slot ${slot} loginni o'chirmoqchimisiz?</b>\n\n` +
        (row[0] ? `Hisob: <code>${row[0].phone}</code>\n\n` : "") +
        `Bu amal ushbu slot ulanishini to'xtatadi.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^login_delete_do:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;
    if (!await isAnySuperAdmin(operatorId)) return;
    const slot = parseInt(ctx.match[1]);
    try {
      await removeMasterSession(operatorId, slot);
      await db.delete(masterSessions).where(
        and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, slot)),
      );
      await ctx.reply(
        `${E.OK} <b>Slot ${slot} login o'chirildi.</b>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).primary() },
      );
    } catch (err: any) {
      logger.error({ err }, "login_delete_do error");
      await notifyError(err, "login_delete_do error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });

  // ── Operator hisobini ulashish (per-slot, multi-admin) ───────────────────
  // Each slot has its own independent sharedWith list.
  // One slot can be shared with multiple admins simultaneously.

  // Step 1: show all slots with their current admin list
  bot.callbackQuery("master_share_list", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;

    const ownRows = await db
      .select()
      .from(masterSessions)
      .where(eq(masterSessions.operatorId, operatorId))
      .orderBy(asc(masterSessions.slot));

    if (!ownRows.length) {
      await ctx.reply(`${E.NO} Hech qanday login topilmadi.`, { parse_mode: "HTML", reply_markup: menuButton() });
      return;
    }

    const adminRows = await db
      .select({ telegramUserId: admins.telegramUserId, firstName: admins.firstName, username: admins.username })
      .from(admins)
      .where(eq(admins.isBlocked, false));
    const adminMap = new Map(adminRows.map(r => [r.telegramUserId, r]));

    const lines: string[] = [];
    const kb = new InlineKeyboard();

    for (const row of ownRows) {
      const shared: number[] = (() => {
        if (!row.sharedWith) return [];
        try { return JSON.parse(row.sharedWith) as number[]; } catch { return []; }
      })();
      const names = shared
        .map(id => { const a = adminMap.get(id); return a ? (a.username ? `@${a.username}` : a.firstName ?? String(id)) : String(id); })
        .join(", ");
      lines.push(
        shared.length
          ? `${E.OK} Slot ${row.slot} (<code>${row.phone}</code>): ${names}`
          : `${E.NO} Slot ${row.slot} (<code>${row.phone}</code>): ulashilmagan`,
      );
      kb.text(`Slot ${row.slot} boshqarish`, `master_share_slot:${row.slot}`).icon(EID.SHARE).primary().row();
    }
    kb.text("Orqaga", "menu_login").icon(EID.KEY).primary();

    await ctx.reply(
      `${E.SHARE} <b>Slot ulashish</b>\n\nHar slotga bir nechta admin ulashish mumkin:\n\n${lines.join("\n")}`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // Step 2: toggle admins for a specific slot
  bot.callbackQuery(/^master_share_slot:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;
    const slot = Number(ctx.match[1]);

    const [slotRow] = await db
      .select()
      .from(masterSessions)
      .where(and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, slot)))
      .limit(1);

    if (!slotRow) {
      await ctx.answerCallbackQuery({ text: "❌ Slot topilmadi.", show_alert: true });
      return;
    }

    const shared: number[] = (() => {
      if (!slotRow.sharedWith) return [];
      try { return JSON.parse(slotRow.sharedWith) as number[]; } catch { return []; }
    })();

    const adminRows = await db
      .select({ telegramUserId: admins.telegramUserId, firstName: admins.firstName, username: admins.username })
      .from(admins)
      .where(eq(admins.isBlocked, false));

    const others = adminRows.filter(r => r.telegramUserId !== operatorId);
    if (!others.length) {
      await ctx.reply(`${E.INFO} Boshqa admin yo'q.`, { parse_mode: "HTML", reply_markup: menuButton() });
      return;
    }

    const kb = new InlineKeyboard();
    for (const r of others) {
      const name = r.username ? `@${r.username}` : r.firstName ?? String(r.telegramUserId);
      const isOn = shared.includes(r.telegramUserId);
      kb.text(isOn ? `${name} ✅` : name, `master_share_slot_do:${slot}:${r.telegramUserId}`)
        .icon(isOn ? EID.OK : EID.ADD)
        [isOn ? "success" : "primary"]().row();
    }
    kb.text("Orqaga", "master_share_list").icon(EID.SHARE).primary();

    const sharedNames = shared
      .map(id => { const a = adminRows.find(r => r.telegramUserId === id); return a ? (a.username ? `@${a.username}` : a.firstName ?? String(id)) : String(id); })
      .join(", ");

    await ctx.editMessageText(
      `${E.SHARE} <b>Slot ${slot}: <code>${slotRow.phone}</code></b>\n\n` +
      (shared.length ? `Hozirgi: ${sharedNames}\n\n` : `Hali ulashilmagan\n\n`) +
      `Qo'shish yoki olib tashlash uchun tanlang:`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // Step 3: toggle one admin on this slot only
  bot.callbackQuery(/^master_share_slot_do:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;
    const slot     = Number(ctx.match[1]);
    const targetId = Number(ctx.match[2]);

    const [slotRow] = await db
      .select()
      .from(masterSessions)
      .where(and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, slot)))
      .limit(1);

    if (!slotRow) {
      await ctx.answerCallbackQuery({ text: "❌ Slot topilmadi.", show_alert: true });
      return;
    }

    let shared: number[] = (() => {
      if (!slotRow.sharedWith) return [];
      try { return JSON.parse(slotRow.sharedWith) as number[]; } catch { return []; }
    })();

    const wasOn = shared.includes(targetId);
    shared = wasOn ? shared.filter(id => id !== targetId) : [...shared, targetId];

    if (!wasOn) {
      // Admin boshqa slotda bo'lsa — u yerdan olib tashla (1 admin faqat 1 slotda bo'ladi)
      const otherRows = await db
        .select()
        .from(masterSessions)
        .where(and(eq(masterSessions.operatorId, operatorId), ne(masterSessions.slot, slot)));
      for (const r of otherRows) {
        if (!r.sharedWith) continue;
        try {
          const ids: number[] = JSON.parse(r.sharedWith);
          if (ids.includes(targetId)) {
            const newIds = ids.filter(id => id !== targetId);
            await db
              .update(masterSessions)
              .set({ sharedWith: newIds.length ? JSON.stringify(newIds) : null })
              .where(and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, r.slot)));
          }
        } catch { /* ignore */ }
      }
    }

    // Update ONLY this slot's sharedWith
    await db
      .update(masterSessions)
      .set({ sharedWith: shared.length ? JSON.stringify(shared) : null })
      .where(and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, slot)));

    // Evict cached client so target immediately picks up (or loses) the session
    await removeMasterSession(targetId).catch(() => {});

    // Refresh the admin toggle list in place
    const adminRows = await db
      .select({ telegramUserId: admins.telegramUserId, firstName: admins.firstName, username: admins.username })
      .from(admins)
      .where(eq(admins.isBlocked, false));

    const others = adminRows.filter(r => r.telegramUserId !== operatorId);
    const kb = new InlineKeyboard();
    for (const r of others) {
      const name = r.username ? `@${r.username}` : r.firstName ?? String(r.telegramUserId);
      const isOn = shared.includes(r.telegramUserId);
      kb.text(isOn ? `${name} ✅` : name, `master_share_slot_do:${slot}:${r.telegramUserId}`)
        .icon(isOn ? EID.OK : EID.ADD)
        [isOn ? "success" : "primary"]().row();
    }
    kb.text("Orqaga", "master_share_list").icon(EID.SHARE).primary();

    const tAdmin = adminRows.find(r => r.telegramUserId === targetId);
    const tName  = tAdmin ? (tAdmin.username ? `@${tAdmin.username}` : tAdmin.firstName ?? String(targetId)) : String(targetId);
    const sharedNames = shared
      .map(id => { const a = adminRows.find(r => r.telegramUserId === id); return a ? (a.username ? `@${a.username}` : a.firstName ?? String(id)) : String(id); })
      .join(", ");

    await ctx.editMessageText(
      `${E.SHARE} <b>Slot ${slot}</b>\n\n` +
      (wasOn ? `${E.UNLOCK} ${tName} olib tashlandi.` : `${E.LINK} ${tName} qo'shildi.`) +
      (sharedNames ? `\n\nHozirgi: ${sharedNames}` : `\n\nHali ulashilmagan`) +
      `\n\nQo'shish yoki olib tashlash uchun tanlang:`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

    // Text handler for awaitingVerifierInput
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from) return next();

    if (awaitingVerifierInput.has(ctx.from.id)) {
      awaitingVerifierInput.delete(ctx.from.id);
      const username = ctx.message.text.replace(/^@/, "").trim();
      if (!username || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
        await ctx.reply(`${E.NO} Noto'g'ri username. Qaytadan urinib ko'ring.`, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary(),
        });
        return;
      }
      // If no default yet, make this the default
      const existing = await db.select().from(verifierBots);
      const makeDefault = existing.length === 0;
      await db
        .insert(verifierBots)
        .values({ username, isActive: true, isDefault: makeDefault })
        .onConflictDoUpdate({
          target: verifierBots.username,
          set: { isActive: true },
        });
      await ctx.reply(
        `${E.OK} <b>@${username}</b> verifier bot sifatida qo'shildi!` +
          (makeDefault ? `\n${E.STAR} Birinchi bot — default qilib belgilandi.` : ""),
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary(),
        },
      );
      return;
    }

    return next();
  });

  // 💳 Add card instructions
  bot.callbackQuery("menu_addcard", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(
      `${E.CARD} <b>Karta qo'shish</b>\n\n` +
        `Quyidagi formatda yuboring:\n` +
        `<code>/addcard BANK_NOMI KARTA_RAQAMI MUDDAT CVV</code>\n\n` +
        `Misollar:\n` +
        `<code>/addcard Kapital 4111111111111111 12/26 123</code>\n` +
        `<code>/addcard Uzcard 8600123456781234 03/28 456</code>\n` +
        `<code>/addcard Humo 9860123456781234 07/27 789</code>`,
      { parse_mode: "HTML", reply_markup: menuButton() },
    );
  });

  bot.catch((err) => {
    const e = err.error as any;
    // "query is too old" — callback query answered too late, not a real error
    if (e?.message?.includes("query is too old") || e?.message?.includes("query ID is invalid")) {
      logger.warn("answerCallbackQuery: query too old — ignored");
      return;
    }
    logger.error({ err: e }, "Unhandled bot error");
    notifyError(e, "Unhandled bot error").catch(() => {});
  });

  return bot;
}
