/**
 * Bot orchestrator — creates and wires up the Grammy bot.
 *
 * Handler modules live in ./handlers/*.ts.
 * Shared state (Maps, Sets, keyboards, helpers) is in ./handlers/shared.ts.
 *
 * Handlers registered here (at bot.ts level):
 *  - /start, /menu, /status — basic navigation
 *  - menu_home, menu_status — callback equivalents
 *  - OTP intercept text middleware (must run before other text handlers)
 *  - Operator-only middleware (after /start and /menu which self-check)
 */
import { Bot } from "grammy";
import { db } from "@workspace/db";
import { admins } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { E } from "../lib/emoji.js";
import {
  ensureSuperAdminSeeded,
  registerSuperAdminCommands,
} from "./super-admin.js";
import { setOnProxyExhausted } from "./premium.js";
import { initNotify, notifyError } from "./notify.js";

// ── Shared state & helpers ─────────────────────────────────────────────────────
import {
  isOperator,
  pendingOtpCallbacks,
  activeOtpFlow,
  removeActiveOtpFlow,
  sendMainMenu,
  buildOperatorStatusText,
  startCallbackMapCleanup,
  menuButton,
} from "./handlers/shared.js";

// ── Handler modules ────────────────────────────────────────────────────────────
import { registerLoginHandlers } from "./handlers/login.js";
import { registerCardsHandlers } from "./handlers/cards.js";
import { registerSessionHandlers } from "./handlers/sessions.js";
import { registerBatchHandlers } from "./handlers/batch.js";
import { registerPremiumHandlers } from "./handlers/premium.js";
import { registerVerifierHandlers } from "./handlers/verifiers.js";

export function createBot() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN env var is required");

  // Seed super admin on startup
  ensureSuperAdminSeeded().catch((err) =>
    logger.error({ err }, "ensureSuperAdminSeeded failed"),
  );

  // Start the TTL safety-net cleanup for pending callback Maps
  startCallbackMapCleanup();

  const bot = new Bot(BOT_TOKEN);

  // ── Error notification → super admin ──────────────────────────────────────
  {
    const saId = Number(process.env.SUPER_ADMIN_ID);
    if (saId) {
      initNotify(async (msg) => {
        await bot.api.sendMessage(saId, msg, { parse_mode: "HTML" });
      });
    }
  }

  // ── Proxy exhaustion notification → super admin ───────────────────────────
  {
    const rawSA = process.env.SUPER_ADMIN_ID ?? "";
    const saIds = rawSA.split(",").map((s) => Number(s.trim())).filter(Boolean);
    setOnProxyExhausted(async (reason) => {
      const msg = reason === "cooldown"
        ? `⚠️ <b>Proksi IP lar vaqtincha blokda!</b>\n\n` +
          `IP lar mavjud, lekin hozir hammasi cooldownda (30 daqiqa).\n` +
          `Webshare API ga o'tildi.\n\n` +
          `🧹 Tez hal qilish:\n` +
          `/superadmin → 🌐 Proksi IP → 🧹 Cooldownlarni tozalash\n\n` +
          `💡 Cooldown sababi: Smart Glocal tokenizatsiya sahifasida karta rad etildi (proxy muammosi). Bank tomonidan rad etilgan to'lovlar proxy ga ta'sir qilmaydi.`
        : `⚠️ <b>Proksi IP lar limitga yetdi!</b>\n\n` +
          `Barcha IP larning ishlatilish soni <b>maksimumga</b> yetdi — Webshare API ga o'tildi.\n\n` +
          `🔄 Davom ettirish uchun:\n` +
          `/superadmin → 🌐 Proksi IP → 🔄 Hammasini qayta boshlash`;
      for (const id of saIds) {
        await bot.api.sendMessage(id, msg, { parse_mode: "HTML" }).catch(() => {});
      }
    });
  }

  // ── Register super admin commands (before middleware so SA commands always work)
  registerSuperAdminCommands(bot);

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    if (!(await isOperator(ctx.from.id))) {
      await ctx.reply("❌ Bu bot faqat operatorlar uchun.");
      return;
    }
    await sendMainMenu(ctx, ctx.from.id);
  });

  // ── /menu ──────────────────────────────────────────────────────────────────
  bot.command("menu", async (ctx) => {
    if (!ctx.from || !(await isOperator(ctx.from.id))) return;
    await sendMainMenu(ctx, ctx.from.id);
  });

  // ── /status ────────────────────────────────────────────────────────────────
  bot.command("status", async (ctx) => {
    if (!ctx.from || !(await isOperator(ctx.from.id))) return;
    const text = await buildOperatorStatusText(ctx.from.id);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: menuButton() });
  });

  // ── Operator-only middleware ───────────────────────────────────────────────
  // All commands/callbacks below this line require operator access.
  // Login commands are SA-only and guarded in their own handlers.
  const profileUpdateCache = new Map<number, number>();
  const PROFILE_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !(await isOperator(userId))) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery("❌ Ruxsat yo'q.").catch(() => {});
      else if (ctx.message) await ctx.reply("❌ Bu bot faqat operatorlar uchun.");
      return;
    }
    // Keep firstName/username fresh — throttle database updates to avoid high DB load
    const from = ctx.from!;
    const now = Date.now();
    const lastUpdate = profileUpdateCache.get(userId) || 0;

    if (now - lastUpdate > PROFILE_UPDATE_INTERVAL_MS) {
      profileUpdateCache.set(userId, now);
      db.update(admins)
        .set({ username: from.username ?? null, firstName: from.first_name ?? null })
        .where(eq(admins.telegramUserId, userId))
        .catch(() => {});
    }
    return next();
  });

  // ── 3DS OTP intercept ──────────────────────────────────────────────────────
  // Must run BEFORE other text handlers so an OTP code isn't mistaken for a
  // command or phone number. Only intercepts if this operator has a pending
  // OTP request AND the message looks like a 4-8 digit code.
  bot.on("message:text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const pending = activeOtpFlow.get(userId);
    if (!pending || pending.length === 0) return next();
    const flowId = pending[0]; // oldest pending flow (FIFO)
    const resolve = pendingOtpCallbacks.get(flowId);
    if (!resolve) {
      // Stale entry (flow crashed/expired) — clean up and fall through
      removeActiveOtpFlow(userId, flowId);
      return next();
    }
    const text = ctx.message.text.trim();
    if (!/^\d{4,8}$/.test(text)) return next(); // not a code — pass through
    // Consume the OTP: remove both Maps, resolve the waiting promise
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

  // ── menu_home ──────────────────────────────────────────────────────────────
  bot.callbackQuery("menu_home", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await sendMainMenu(ctx, ctx.from.id);
  });

  // ── menu_status ────────────────────────────────────────────────────────────
  bot.callbackQuery("menu_status", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const text = await buildOperatorStatusText(ctx.from.id);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: menuButton() });
  });

  // ── Register all feature handler modules ──────────────────────────────────
  registerPremiumHandlers(bot);   // step6_*/card_retry_* must be registered early
  registerLoginHandlers(bot);
  registerCardsHandlers(bot);
  registerSessionHandlers(bot);
  registerBatchHandlers(bot);
  registerVerifierHandlers(bot);  // verifier text handler registered last (after OTP handler)

  // ── Error handler ──────────────────────────────────────────────────────────
  bot.catch((err) => {
    const e = err.error as any;
    if (e?.message?.includes("query is too old") || e?.message?.includes("query ID is invalid")) {
      logger.warn("answerCallbackQuery: query too old — ignored");
      return;
    }
    logger.error({ err: e }, "Unhandled bot error");
    notifyError(e, "Unhandled bot error").catch(() => {});
  });

  return bot;
}
