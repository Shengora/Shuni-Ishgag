/**
 * Premium handlers:
 * /getpremium command (single phone)
 * + menu_getpremium, batch_premium, batch_premium_card, card_limit_exceeded, batch_premium_run
 * + step6_euro / step6_done / step6_abort (3DS resolution)
 * + card_retry / card_retry_cancel (payment-failed card swap)
 */
import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import { userbotSessions, savedCards, cardUsages, pendingNumbers } from "@workspace/db";
import { eq, and, desc, gte } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { E, EID } from "../../lib/emoji.js";
import { recordStat } from "../super-admin.js";
import {
  getMasterClient,
  createClientFromSession,
  isSessionInvalidError,
  markUserbotSessionInvalid,
} from "../client.js";
import {
  runFullPremiumFlow,
  FlowRestartError,
  FlowAbortError,
  FlowStep6TimeoutError,
  pollPremiumActiveViaStart,
} from "../premium.js";
import { withTimeout } from "../../lib/timeout.js";
import { notifyError } from "../notify.js";
import {
  isOperator,
  batchPremiumRunning,
  activePremiumSessions,
  pendingOtpCallbacks,
  activeOtpFlow,
  pendingStep6Callbacks,
  pendingCardRetryCallbacks,
  addActiveOtpFlow,
  removeActiveOtpFlow,
  trackOtpTs,
  clearOtpTs,
  trackS6Ts,
  clearS6Ts,
  trackCrTs,
  clearCrTs,
  getDefaultVerifierBot,
  getDefaultCard,
  PREMIUM_BOT,
  MAX_PREMIUM_RESTARTS,
  PREMIUM_FLOW_TOTAL_TIMEOUT,
  ALLOWED_PREMIUM_COUNTS,
  ALLOWED_CARD_USES,
  menuButton,
  premiumPickerKeyboard,
  cardUsagePickerKeyboard,
} from "./shared.js";

export function registerPremiumHandlers(bot: Bot): void {

  // ── step6_euro / step6_done / step6_abort (3DS button callbacks) ─────────
  // Registered first so they run before the operator-only middleware.

  bot.callbackQuery(/^step6_euro:(.+)$/, async (ctx) => {
    const flowId = ctx.match[1];
    const resolve = pendingStep6Callbacks.get(flowId);
    if (resolve) {
      pendingStep6Callbacks.delete(flowId);
      clearS6Ts(flowId);
      resolve("restart");
    }
    ctx.answerCallbackQuery(resolve ? "🔄 Qaytadan boshlanmoqda..." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.callbackQuery(/^step6_done:(.+)$/, async (ctx) => {
    const flowId = ctx.match[1];
    const resolve = pendingStep6Callbacks.get(flowId);
    if (resolve) {
      pendingStep6Callbacks.delete(flowId);
      clearS6Ts(flowId);
      resolve("continue");
    }
    ctx.answerCallbackQuery(resolve ? "✅ Davom etilmoqda..." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.callbackQuery(/^step6_abort:(.+)$/, async (ctx) => {
    const flowId = ctx.match[1];
    const resolve = pendingStep6Callbacks.get(flowId);
    if (resolve) {
      pendingStep6Callbacks.delete(flowId);
      clearS6Ts(flowId);
      resolve("abort");
    }
    ctx.answerCallbackQuery(resolve ? "❌ Bekor qilindi." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // ── card_retry / card_retry_cancel ────────────────────────────────────────
  bot.callbackQuery(/^card_retry:(.+):(\d+)$/, async (ctx) => {
    const attemptId = ctx.match[1];
    const cardId = Number(ctx.match[2]);
    const resolve = pendingCardRetryCallbacks.get(attemptId);
    if (resolve) {
      pendingCardRetryCallbacks.delete(attemptId);
      clearCrTs(attemptId);
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
      clearCrTs(attemptId);
      resolve("cancel");
    }
    ctx.answerCallbackQuery(resolve ? "❌ Bekor qilindi." : "⚠️ Bu so'rov allaqachon tugagan.").catch(() => {});
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // ── card_limit_exceeded (disabled button) ─────────────────────────────────
  bot.callbackQuery("card_limit_exceeded", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "⛔ Bu variant karta limitidan oshadi (max 5/3kun).", show_alert: true }).catch(() => {});
  });

  // ── /getpremium — single phone premium flow ───────────────────────────────
  bot.command("getpremium", async (ctx) => {
    const operatorId = ctx.from!.id;
    if (!await isOperator(operatorId)) return;

    const phone = ctx.match?.trim();
    if (!phone) {
      await ctx.reply("❌ Format: /getpremium <code>+998901234567</code>", { parse_mode: "HTML" });
      return;
    }

    const card = await getDefaultCard(operatorId);
    if (!card) {
      await ctx.reply(
        "⚠️ Asosiy karta saqlanmagan.\n\n💳 Avval /addcard orqali karta qo'shing.",
        { reply_markup: menuButton() },
      );
      return;
    }

    const [session] = await db
      .select()
      .from(userbotSessions)
      .where(and(eq(userbotSessions.phone, phone), eq(userbotSessions.ownerId, operatorId)))
      .limit(1);

    if (!session) {
      await ctx.reply(
        `❌ <code>${phone}</code> raqami sessiyangizda topilmadi.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
      return;
    }

    if (activePremiumSessions.has(phone)) {
      await ctx.reply(
        `⚠️ <code>${phone}</code> raqami uchun premium jarayon allaqachon ketmoqda.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
      return;
    }

    activePremiumSessions.add(phone);
    const chatId = ctx.chat!.id;

    const sentMsg = await ctx.reply(
      `⏳ <b><code>${phone}</code></b> uchun premium jarayon boshlanmoqda...`,
      { parse_mode: "HTML" },
    );
    const update = (text: string) =>
      ctx.api.editMessageText(chatId, sentMsg.message_id, text, { parse_mode: "HTML" }).catch(() => {});

    void (async () => {
      let userClient: any = null;

      try {
        let restartCount = 0;
        while (true) {
          const attemptId = `${operatorId}_${phone}_${Date.now()}`;
          let step6Promise: Promise<void> | null = null;
          let step6MsgId: number | null = null;

          try {
            if (userClient) { try { await userClient.disconnect(); } catch (_) {} }
            userClient = await createClientFromSession(session.sessionString);

            const verifierBot = await getDefaultVerifierBot();
            const [pendingRow] = await db.select().from(pendingNumbers)
              .where(eq(pendingNumbers.phone, phone)).limit(1);
            const checkProviderBot = pendingRow?.providerBot ?? verifierBot;
            const checkMsgId = pendingRow?.repreamMessageId ? Number(pendingRow.repreamMessageId) : undefined;

            const result = await withTimeout(runFullPremiumFlow(
              userClient,
              PREMIUM_BOT,
              checkProviderBot,
              card,
              async (progressMsg) => { await update(`⏳ <b><code>${phone}</code></b>\n\n${progressMsg}`); },
              // OTP callback
              async () => {
                return new Promise<string | null>((resolve) => {
                  const otpTimer = setTimeout(() => {
                    pendingOtpCallbacks.delete(attemptId);
                    clearOtpTs(attemptId);
                    removeActiveOtpFlow(operatorId, attemptId);
                    ctx.reply(`⏱ <code>${phone}</code> — 3DS kod 120s da kiritilmadi.`, { parse_mode: "HTML" }).catch(() => {});
                    resolve(null);
                  }, 120_000);

                  pendingOtpCallbacks.set(attemptId, (otp) => {
                    clearTimeout(otpTimer);
                    pendingOtpCallbacks.delete(attemptId);
                    clearOtpTs(attemptId);
                    removeActiveOtpFlow(operatorId, attemptId);
                    resolve(otp);
                  });
                  trackOtpTs(attemptId);
                  addActiveOtpFlow(operatorId, attemptId);

                  ctx.reply(
                    `🔐 <b><code>${phone}</code> — 3DS kod kerak!</b>\n\n📱 Kartangiz raqamiga SMS kod yuborildi.\n\nKodni shu yerga yuboring (120 soniya):\n<i>Misol: 123456</i>`,
                    { parse_mode: "HTML" },
                  ).catch(() => {});
                });
              },
              // Step6 / bank 3DS callback
              async (verificationUrl: string) => {
                step6Promise = new Promise<void>((resolve, reject) => {
                  pendingStep6Callbacks.set(attemptId, (choice) => {
                    pendingStep6Callbacks.delete(attemptId);
                    clearS6Ts(attemptId);
                    if (choice === "abort") reject(new FlowAbortError());
                    else if (choice === "restart") reject(new FlowRestartError());
                    else if (choice === "step6_timeout") reject(new FlowStep6TimeoutError());
                    else resolve();
                  });
                  trackS6Ts(attemptId);
                });
                step6Promise?.catch(() => {});

                const keyboard = new InlineKeyboard()
                  .url("3DS tasdiqlash", verificationUrl).icon(EID.LOCK)
                  .row()
                  .text("3DS Tugadi — Davom et", `step6_done:${attemptId}`).icon(EID.OK).success()
                  .row()
                  .text("Evro (qayta urinish)", `step6_euro:${attemptId}`).icon(EID.REFRESH).primary()
                  .text("Bekor qilish", `step6_abort:${attemptId}`).icon(EID.NO).danger();

                const sent = await ctx.api.sendMessage(
                  chatId,
                  `🔐 <b>Bank 3DS tasdiqlash talab qildi!</b>\n\n` +
                    `1️⃣ Quyidagi tugmani bosib brauzerda oching\n` +
                    `2️⃣ Bank SMS kodini kiritib tasdiqlang\n` +
                    `3️⃣ <b>✅ 3DS Tugadi — Davom et</b> tugmasini bosing\n\n` +
                    `💶 Evro chiqsa — <b>Evro (qayta urinish)</b> tugmasini bosing\n\n` +
                    `🤖 Yoki hech narsa bosmasangiz ham, bot @${PREMIUM_BOT} ga har 20 soniyada /start yuborib avtomatik tekshiradi.`,
                  { parse_mode: "HTML", reply_markup: keyboard },
                ).catch(() => null);
                step6MsgId = sent?.message_id ?? null;

                // Auto-detect fallback
                (async () => {
                  const active = await pollPremiumActiveViaStart(userClient, PREMIUM_BOT, 10, 30000).catch(() => false);
                  const cb = pendingStep6Callbacks.get(attemptId);
                  if (!cb) return;
                  pendingStep6Callbacks.delete(attemptId);
                  clearS6Ts(attemptId);
                  if (step6MsgId != null) ctx.api.editMessageReplyMarkup(chatId, step6MsgId).catch(() => {});
                  if (active) {
                    ctx.api.sendMessage(chatId, `✅ Premium avtomatik aniqlandi (@${PREMIUM_BOT} /start orqali) — davom etilmoqda.`, { parse_mode: "HTML" }).catch(() => {});
                    cb("continue");
                  } else {
                    ctx.api.sendMessage(chatId, `❌ 10 marta tekshirildi (5 daqiqa) — Premium aniqlanmadi va operator tasdiqlamadi. Jarayon avtomatik muvaffaqiyatsiz deb belgilandi.`, { parse_mode: "HTML" }).catch(() => {});
                    cb("step6_timeout");
                  }
                })();
              },
              checkMsgId,
              async () => { if (!step6Promise) return; await step6Promise; },
              await getMasterClient(operatorId) ?? undefined,
            ), PREMIUM_FLOW_TOTAL_TIMEOUT, `Premium jarayoni (${phone})`);

            if (result.hasPremium) {
              await Promise.all([
                db.delete(userbotSessions).where(eq(userbotSessions.phone, phone)),
                recordStat(operatorId, "premium_obtained"),
              ]);
            }

            const expStr = result.premiumExpiresAt ? `\n📅 Muddat: ${result.premiumExpiresAt.toLocaleDateString("uz")}` : "";
            const autoRenewalStr = result.autoRenewalCancelled === undefined ? ""
              : result.autoRenewalCancelled ? `\n🔕 Avto-obuna: bekor qilindi`
              : `\n⚠️ Avto-obuna: bekor qilinmagan bo'lishi mumkin`;

            await update(
              result.success
                ? `${result.hasPremium ? "⭐" : "✅"} <b>${result.message}</b>\n\n📱 Raqam: <code>${phone}</code>${expStr}${autoRenewalStr}`
                : `❌ <b>Xato yuz berdi</b>\n\n${result.message}`,
            );
            await ctx.reply(
              result.success ? "✅ Jarayon yakunlandi." : "❌ Premium olinmadi.",
              { reply_markup: menuButton() },
            );
            break;

          } catch (err: any) {
            if (err instanceof FlowRestartError) {
              restartCount++;
              if (restartCount > MAX_PREMIUM_RESTARTS) {
                await update(`❌ <b>Juda ko'p qayta urinish</b> (${MAX_PREMIUM_RESTARTS}) — jarayon to'xtatildi.`);
                await ctx.reply(`❌ ${MAX_PREMIUM_RESTARTS} marta qayta urinishdan so'ng to'xtatildi.`, { reply_markup: menuButton() });
                break;
              }
              await ctx.api.sendMessage(chatId, `🔄 Evro aniqlandi — ${restartCount}-urinish boshlanmoqda...`, { parse_mode: "HTML" }).catch(() => {});
              continue;
            }
            if (err instanceof FlowAbortError) {
              await update(`❌ Jarayon operator tomonidan bekor qilindi.`);
              await ctx.reply("❌ Bekor qilindi.", { reply_markup: menuButton() });
              break;
            }
            if (err instanceof FlowStep6TimeoutError) {
              await update(`❌ <b>3DS tasdiqlanmadi</b>\n\n10 marta (5 daqiqa) @${PREMIUM_BOT} tekshirildi — Premium aniqlanmadi va operator ham tasdiqlamadi.`);
              await ctx.reply("❌ Premium olinmadi — 3DS tasdiqlanmadi.", { reply_markup: menuButton() });
              break;
            }
            if (isSessionInvalidError(err)) {
              await markUserbotSessionInvalid(phone, err.message ?? String(err));
              await update(`❌ <b>Sessiya yaroqsiz</b> — <code>${phone}</code> Telegram tomonidan bekor qilingan.`);
              await ctx.reply("❌ Sessiya yaroqsiz — avtomatik tozalanadi.", { reply_markup: menuButton() });
              break;
            }
            logger.error({ err }, "getpremium command error");
            await notifyError(err, "getpremium command error");
            const safeErrMsg = (err.message || String(err)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            await update(`❌ Xato: ${safeErrMsg}`);
            break;
          } finally {
            pendingStep6Callbacks.delete(attemptId);
            clearS6Ts(attemptId);
            pendingOtpCallbacks.delete(attemptId);
            clearOtpTs(attemptId);
            removeActiveOtpFlow(operatorId, attemptId);
          }
        }
      } finally {
        activePremiumSessions.delete(phone);
        if (userClient) { try { await userClient.disconnect(); } catch (_) {} }
      }
    })();
  });

  // ── menu_getpremium — count picker for batch premium ──────────────────────
  bot.callbackQuery("menu_getpremium", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});

    const [allActive, allCards] = await Promise.all([
      db.select().from(userbotSessions)
        .where(and(eq(userbotSessions.status, "active"), eq(userbotSessions.ownerId, ctx.from.id)))
        .orderBy(userbotSessions.createdAt),
      db.select().from(savedCards).where(eq(savedCards.userId, ctx.from.id)).orderBy(desc(savedCards.createdAt)),
    ]);

    const now = new Date();
    const sessions = allActive.filter((s) => !s.hasPremium || !s.premiumExpiresAt || s.premiumExpiresAt <= now);

    if (!sessions.length) {
      await ctx.reply(
        `${E.OK} Barcha faol sessiyalarda Premium mavjud yoki sessiya yo'q.\n\n${E.PHONE} Yangi raqam olish uchun <b>Raqam olish</b> tugmasini bosing.`,
        { parse_mode: "HTML", reply_markup: menuButton() },
      );
      return;
    }

    if (!allCards.length) {
      await ctx.reply("⚠️ Karta saqlanmagan.\n\n💳 Avval /addcard orqali karta qo'shing.", { reply_markup: menuButton() });
      return;
    }

    const without = sessions.length;
    const show = sessions.slice(0, 10).map((s, i) => `${i + 1}. <code>${s.phone}</code>`);
    const more = without > 10 ? `\n<i>...va yana ${without - 10} ta</i>` : "";

    await ctx.reply(
      `⭐ <b>Avto Premium olish</b>\n\n📋 Premiumsiz sessiyalar: <b>${without}</b> ta\n\n<b>Quyidagilar uchun Premium olinadi:</b>\n${show.join("\n")}${more}\n\n<i>Nechta sessiya uchun Premium olish kerak?</i>`,
      { parse_mode: "HTML", reply_markup: premiumPickerKeyboard() },
    );
  });

  // ── batch_premium:N — show card list ──────────────────────────────────────
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

    const cards = await db.select().from(savedCards)
      .where(eq(savedCards.userId, operatorId)).orderBy(desc(savedCards.createdAt));

    if (!cards.length) {
      await ctx.answerCallbackQuery("❌ Karta saqlanmagan!").catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const kb = new InlineKeyboard();
    const lines: string[] = [];

    for (const c of cards) {
      const usages = await db.select().from(cardUsages).where(
        and(eq(cardUsages.cardNumber, c.cardNumber), eq(cardUsages.operatorId, operatorId), gte(cardUsages.usedAt, threeDaysAgo)),
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
      `💳 <b>Karta tanlang</b>\n\n<i>${total} ta sessiya uchun Premium olinadi.</i>\n\n${lines.join("\n")}\n\n🟢 bo'sh | 🟡 kam qoldi | 🔴 tugagan`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── batch_premium_card:N:cardId — show usage picker ───────────────────────
  bot.callbackQuery(/^batch_premium_card:(\d+):(\d+)$/, async (ctx) => {
    const total  = parseInt(ctx.match[1]);
    const cardId = parseInt(ctx.match[2]);
    if (!ALLOWED_PREMIUM_COUNTS.has(total) || isNaN(cardId)) {
      await ctx.answerCallbackQuery("❌ Noto'g'ri tanlov.").catch(() => {});
      return;
    }

    const operatorId = ctx.from.id;
    const [cardRow] = await db.select().from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, operatorId))).limit(1);

    if (!cardRow) {
      await ctx.answerCallbackQuery("❌ Karta topilmadi.").catch(() => {});
      return;
    }

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const usages = await db.select().from(cardUsages).where(
      and(eq(cardUsages.cardNumber, cardRow.cardNumber), eq(cardUsages.operatorId, operatorId), gte(cardUsages.usedAt, threeDaysAgo)),
    );
    const usedIn3Days = usages.length;
    const remaining = Math.max(0, 5 - usedIn3Days);
    const label = cardRow.bankName ?? cardRow.cardHolder;

    await ctx.answerCallbackQuery().catch(() => {});

    if (remaining === 0) {
      await ctx.reply(
        `⛔ <b>Karta limiti tugagan</b>\n\n💳 <b>${label}</b> <code>${cardRow.cardNumberMasked}</code>\nSo'nggi 3 kunda allaqachon <b>5 marta</b> ishlatilgan.\n\n🕐 Limit yangilanishi uchun kuting yoki boshqa karta tanlang.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Kartalar", `batch_premium:${total}`).text("🏠 Bosh menyu", "menu_home") },
      );
      return;
    }

    await ctx.reply(
      `💳 <b>Nechta obuna olish kerak?</b>\n\nKarta: <b>${label}</b> <code>${cardRow.cardNumberMasked}</code>\nSo'nggi 3 kunda: <b>${usedIn3Days}/5</b> marta ishlatilgan\nQolgan: <b>${remaining} ta</b>\n\n<i>Bu karta bilan nechta raqamga Premium olish kerak?</i>`,
      { parse_mode: "HTML", reply_markup: cardUsagePickerKeyboard(total, usedIn3Days, cardId) },
    );
  });

  // ── batch_premium_run:N:uses:cardId — run the batch ───────────────────────
  bot.callbackQuery(/^batch_premium_run:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const total     = parseInt(ctx.match[1]);
    const cardLimit = parseInt(ctx.match[2]);
    const cardId    = parseInt(ctx.match[3]);
    if (!ALLOWED_PREMIUM_COUNTS.has(total) || !ALLOWED_CARD_USES.has(cardLimit) || isNaN(cardId)) {
      await ctx.answerCallbackQuery("❌ Noto'g'ri tanlov.").catch(() => {});
      return;
    }

    const operatorId = ctx.from.id;
    if (batchPremiumRunning.has(operatorId)) {
      await ctx.answerCallbackQuery("⏳ Premium jarayoni allaqachon davom etmoqda, kuting.").catch(() => {});
      return;
    }

    const [cardRow] = await db.select().from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, operatorId))).limit(1);
    if (!cardRow) {
      await ctx.answerCallbackQuery("❌ Karta topilmadi yoki sizga tegishli emas!").catch(() => {});
      return;
    }
    const card = { cardNumber: cardRow.cardNumber, expiry: cardRow.expiry, cvv: cardRow.cvv, cardHolder: cardRow.cardHolder };

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const usages = await db.select().from(cardUsages).where(
      and(eq(cardUsages.cardNumber, card.cardNumber), eq(cardUsages.operatorId, operatorId), gte(cardUsages.usedAt, threeDaysAgo)),
    );
    const usedNow = usages.length;
    const actualLimit = Math.min(cardLimit, Math.max(0, 5 - usedNow));

    if (actualLimit === 0) {
      await ctx.answerCallbackQuery({ text: "⛔ Karta limiti tugagan (max 5/3kun).", show_alert: true }).catch(() => {});
      return;
    }

    const now = new Date();
    const allSessions = await db.select().from(userbotSessions)
      .where(and(eq(userbotSessions.status, "active"), eq(userbotSessions.ownerId, operatorId)))
      .orderBy(userbotSessions.createdAt);

    const availableSessions = allSessions
      .filter((s) => (!s.hasPremium || !s.premiumExpiresAt || s.premiumExpiresAt <= now) && !activePremiumSessions.has(s.phone));

    if (!availableSessions.length) {
      await ctx.answerCallbackQuery("✅ Premiumsiz sessiya topilmadi.").catch(() => {});
      return;
    }

    const actualTotal = Math.min(total, availableSessions.length);
    if (total > availableSessions.length) {
      await ctx.answerCallbackQuery({
        text: `⚠️ Mantiqiy xato: Siz ${total} ta so'radingiz, lekin atigi ${availableSessions.length} ta premiumsiz sessiya mavjud. Shular uchungina olinadi.`,
        show_alert: true
      }).catch(() => {});
    } else {
      await ctx.answerCallbackQuery(`⏳ ${actualTotal} ta sessiya uchun Premium olinmoqda...`).catch(() => {});
    }

    const runCount = Math.min(actualTotal, actualLimit);
    const targets = availableSessions.slice(0, runCount);
    const remainingToRun = actualTotal - runCount;

    const chatId = ctx.chat!.id;
    let success = 0;
    let failed = 0;
    const lines: string[] = new Array(targets.length).fill("");
    const liveStatus = new Map<string, string>();
    let msgId = 0;
    const actionMsgId = new Map<string, number>();

    const sendOrEditAction = async (phone: string, text: string, keyboard?: InlineKeyboard): Promise<number | null> => {
      const existing = actionMsgId.get(phone);
      if (existing) {
        try {
          await ctx.api.editMessageText(chatId, existing, text, { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) });
          return existing;
        } catch (_) {}
      }
      const sent = await ctx.api.sendMessage(chatId, text, { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) }).catch(() => null);
      if (sent) actionMsgId.set(phone, sent.message_id);
      return sent?.message_id ?? null;
    };

    // Relay gates: session i+1 starts only after session i sends its 3DS URL
    const relayResolvers: Array<(() => void) | null> = new Array(targets.length).fill(null);
    const relayGates: Promise<void>[] = targets.map((_, i) => {
      if (i === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { relayResolvers[i] = resolve; });
    });
    const triggerRelayNext = (i: number) => {
      const resolve = relayResolvers[i + 1];
      if (resolve) { relayResolvers[i + 1] = null; resolve(); }
    };

    const renderProgress = () => {
      const completed = lines.filter(Boolean).join("\n");
      const activeLines = [...liveStatus.entries()].map(([p, t]) => `🔄 <code>${p}</code>: ${t}`).join("\n");
      const parts: string[] = [];
      if (completed) parts.push(`📋 <b>Yakunlangan:</b>\n${completed}`);
      if (activeLines) parts.push(`⏳ <b>Jarayonda:</b>\n${activeLines}`);
      return parts.length ? parts.join("\n\n") : "🔄 Boshlanmoqda...";
    };

    const updateProgress = async () => {
      if (!msgId) return;
      try {
        await ctx.api.editMessageText(chatId, msgId, `⭐ <b>Avto Premium — ${success + failed} / ${targets.length}</b>\n\n${renderProgress()}`, { parse_mode: "HTML" });
      } catch (_) {}
    };

    batchPremiumRunning.add(operatorId);

    try {
      const statusMsg = await ctx.reply(`⭐ <b>Avto Premium — 0 / ${targets.length}</b>\n\n🔄 Boshlanmoqda...`, { parse_mode: "HTML" });
      msgId = statusMsg.message_id;

      void (async () => {
        const processOneTarget = async (session: (typeof targets)[number], step: number): Promise<void> => {
          const phone = session.phone;
          const relayIndex = step - 1;

          await relayGates[relayIndex];

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
          let activeCard = card;
          let activeCardId = cardId;
          let activeCardLabel = cardRow.bankName ?? cardRow.cardHolder;
          let cardRetryCount = 0;
          const MAX_CARD_RETRIES = 3;
          let sameCardRetryCount = 0;
          const MAX_SAME_CARD_RETRIES = 2;

          try {
            while (true) {
              const attemptId = `${operatorId}_${phone}_${Date.now()}`;
              let step6Promise: Promise<void> | null = null;

              try {
                if (userClient) { try { await userClient.disconnect(); } catch (_) {} }
                userClient = await createClientFromSession(session.sessionString);

                const verifierBot = await getDefaultVerifierBot();
                const [pendingRow] = await db.select().from(pendingNumbers).where(eq(pendingNumbers.phone, phone)).limit(1);
                const checkProviderBot = pendingRow?.providerBot ?? verifierBot;
                const checkMsgId = pendingRow?.repreamMessageId ? Number(pendingRow.repreamMessageId) : undefined;

                const result = await withTimeout(runFullPremiumFlow(
                  userClient,
                  PREMIUM_BOT,
                  checkProviderBot,
                  activeCard,
                  async (progressMsg) => {
                    liveStatus.set(phone, restartCount > 0 ? `(${restartCount}-urinish) ${progressMsg}` : progressMsg);
                    await updateProgress();
                  },
                  // OTP callback
                  async () => {
                    return new Promise<string | null>((resolve) => {
                      const otpTimer = setTimeout(() => {
                        pendingOtpCallbacks.delete(attemptId);
                        clearOtpTs(attemptId);
                        removeActiveOtpFlow(operatorId, attemptId);
                        sendOrEditAction(phone, `⏱ ${step}/${targets.length}: <code>${phone}</code> — 3DS kod 120s da kiritilmadi.`).catch(() => {});
                        resolve(null);
                      }, 120_000);

                      pendingOtpCallbacks.set(attemptId, (otp) => {
                        clearTimeout(otpTimer);
                        pendingOtpCallbacks.delete(attemptId);
                        clearOtpTs(attemptId);
                        removeActiveOtpFlow(operatorId, attemptId);
                        resolve(otp);
                      });
                      trackOtpTs(attemptId);
                      addActiveOtpFlow(operatorId, attemptId);

                      sendOrEditAction(
                        phone,
                        `🔐 <b>${step}/${targets.length}: <code>${phone}</code> — 3DS kod kerak!</b>\n\n📱 Kartangiz raqamiga SMS kod yuborildi.\n\nKodni shu yerga yuboring (120 soniya):\n<i>Misol: 123456</i>`,
                      ).catch(() => {});
                    });
                  },
                  // Step6 / bank 3DS callback
                  async (verificationUrl: string) => {
                    step6Promise = new Promise<void>((resolve, reject) => {
                      pendingStep6Callbacks.set(attemptId, (choice) => {
                        pendingStep6Callbacks.delete(attemptId);
                        clearS6Ts(attemptId);
                        if (choice === "abort") reject(new FlowAbortError());
                        else if (choice === "restart") reject(new FlowRestartError());
                        else if (choice === "step6_timeout") reject(new FlowStep6TimeoutError());
                        else resolve();
                      });
                      trackS6Ts(attemptId);
                    });
                    step6Promise?.catch(() => {});

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

                    triggerRelayNext(relayIndex);

                    (async () => {
                      const active = await pollPremiumActiveViaStart(userClient, PREMIUM_BOT, 10, 30000).catch(() => false);
                      const cb = pendingStep6Callbacks.get(attemptId);
                      if (!cb) return;
                      pendingStep6Callbacks.delete(attemptId);
                      clearS6Ts(attemptId);
                      const trackedMsgId = actionMsgId.get(phone);
                      if (trackedMsgId != null) ctx.api.editMessageReplyMarkup(chatId, trackedMsgId).catch(() => {});
                      if (active) {
                        sendOrEditAction(phone, `✅ ${step}/${targets.length}: <code>${phone}</code> — Premium avtomatik aniqlandi (@${PREMIUM_BOT} /start orqali) — davom etilmoqda.`).catch(() => {});
                        cb("continue");
                      } else {
                        sendOrEditAction(phone, `❌ ${step}/${targets.length}: <code>${phone}</code> — 10 marta tekshirildi (5 daqiqa), Premium aniqlanmadi. Avtomatik muvaffaqiyatsiz deb belgilandi.`).catch(() => {});
                        cb("step6_timeout");
                      }
                    })();
                  },
                  checkMsgId,
                  async () => { if (!step6Promise) return; await step6Promise; },
                  await getMasterClient(operatorId) ?? undefined,
                  undefined,
                ), PREMIUM_FLOW_TOTAL_TIMEOUT, `Premium jarayoni (${phone})`);

                if (result.hasPremium) {
                  await Promise.all([
                    db.delete(userbotSessions).where(eq(userbotSessions.phone, phone)),
                    db.insert(cardUsages).values({ cardNumber: activeCard.cardNumber, operatorId, phone }),
                    recordStat(operatorId, "premium_obtained"),
                  ]);
                }

                const expStr = result.premiumExpiresAt ? ` (${result.premiumExpiresAt.toLocaleDateString("uz")})` : "";
                const autoRenewalStr = result.autoRenewalCancelled === undefined ? ""
                  : result.autoRenewalCancelled ? ` — obuna: bekor qilindi`
                  : ` — obuna: bekor qilinmagan bo'lishi mumkin`;

                if (result.success) {
                  success++;
                  lines[step - 1] = result.hasPremium
                    ? `${step}. ⭐ <code>${phone}</code>${expStr}${autoRenewalStr}`
                    : `${step}. ✅ <code>${phone}</code> — ${result.message}${autoRenewalStr}`;
                  break;
                }

                // Same-card retry (fresh IP)
                if (result.paymentDeclined && sameCardRetryCount < MAX_SAME_CARD_RETRIES) {
                  sameCardRetryCount++;
                  await sendOrEditAction(phone, `🔁 ${step}/${targets.length}: <code>${phone}</code> — to'lov rad etildi, IP o'zgartirilib qayta urinilmoqda (${sameCardRetryCount}/${MAX_SAME_CARD_RETRIES})...`).catch(() => {});
                  continue;
                }

                // Offer another card after exhausted same-card retries
                if (result.paymentDeclined && cardRetryCount < MAX_CARD_RETRIES) {
                  const threeDaysAgoRetry = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
                  const otherCards = await db.select().from(savedCards).where(eq(savedCards.userId, operatorId)).orderBy(desc(savedCards.createdAt));

                  const usable: typeof otherCards = [];
                  for (const c of otherCards) {
                    if (c.id === activeCardId) continue;
                    const cu = await db.select().from(cardUsages).where(
                      and(eq(cardUsages.cardNumber, c.cardNumber), eq(cardUsages.operatorId, operatorId), gte(cardUsages.usedAt, threeDaysAgoRetry)),
                    );
                    if (cu.length < 5) usable.push(c);
                  }

                  if (usable.length > 0) {
                    const retryKb = new InlineKeyboard();
                    for (const c of usable) {
                      const lbl = c.bankName ?? c.cardHolder;
                      retryKb.text(`💳 ${lbl} ${c.cardNumberMasked}`, `card_retry:${attemptId}:${c.id}`).row();
                    }
                    retryKb.text("❌ Bekor qilish (xato deb belgila)", `card_retry_cancel:${attemptId}`);

                    const choice = await new Promise<number | "cancel">((resolve) => {
                      const retryTimer = setTimeout(() => {
                        pendingCardRetryCallbacks.delete(attemptId);
                        clearCrTs(attemptId);
                        resolve("cancel");
                      }, 90_000);
                      pendingCardRetryCallbacks.set(attemptId, (c) => {
                        clearTimeout(retryTimer);
                        pendingCardRetryCallbacks.delete(attemptId);
                        clearCrTs(attemptId);
                        resolve(c);
                      });
                      trackCrTs(attemptId);
                      sendOrEditAction(
                        phone,
                        `❌ <b>${step}/${targets.length}: <code>${phone}</code> — to'lov rad etildi</b>\n\n💳 <b>${activeCardLabel}</b> kartasi bilan to'lov o'tmadi.\n\nBoshqa karta bilan qayta urinib ko'rasizmi? (90s):`,
                        retryKb,
                      ).catch(() => {});
                    });

                    if (choice !== "cancel") {
                      const [newCardRow] = await db.select().from(savedCards)
                        .where(and(eq(savedCards.id, choice as number), eq(savedCards.userId, operatorId))).limit(1);
                      if (newCardRow) {
                        cardRetryCount++;
                        sameCardRetryCount = 0;
                        activeCardId = newCardRow.id;
                        activeCardLabel = newCardRow.bankName ?? newCardRow.cardHolder;
                        activeCard = { cardNumber: newCardRow.cardNumber, expiry: newCardRow.expiry, cvv: newCardRow.cvv, cardHolder: newCardRow.cardHolder };
                        await sendOrEditAction(phone, `🔄 ${step}/${targets.length}: <code>${phone}</code> — ${activeCardLabel} kartasi bilan qayta urinilmoqda...`).catch(() => {});
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
                  await sendOrEditAction(phone, `🔄 ${step}/${targets.length}: <code>${phone}</code> — Evro aniqlandi, ${restartCount}-urinish...`).catch(() => {});
                  continue;
                }
                if (err instanceof FlowAbortError) { failed++; lines[step - 1] = `${step}. ❌ <code>${phone}</code> — operator bekor qildi`; break; }
                if (err instanceof FlowStep6TimeoutError) { failed++; lines[step - 1] = `${step}. ❌ <code>${phone}</code> — 3DS tasdiqlanmadi (5 daqiqa, avto-muvaffaqiyatsiz)`; break; }
                if (isSessionInvalidError(err)) {
                  await markUserbotSessionInvalid(phone, err.message ?? String(err));
                  failed++;
                  lines[step - 1] = `${step}. ❌ <code>${phone}</code> — sessiya yaroqsiz, avtomatik tozalashga qo'yildi`;
                  break;
                }
                logger.error({ err, phone }, "batch_premium_run flow error");
                await notifyError(err, "batch_premium_run flow error", { phone });
                failed++;
                const safeErrMsg = (err.message || String(err)).slice(0, 60).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                lines[step - 1] = `${step}. ❌ <code>${phone}</code> — ${safeErrMsg}`;
                break;
              } finally {
                pendingStep6Callbacks.delete(attemptId);
                clearS6Ts(attemptId);
                pendingOtpCallbacks.delete(attemptId);
                clearOtpTs(attemptId);
                pendingCardRetryCallbacks.delete(attemptId);
                clearCrTs(attemptId);
                removeActiveOtpFlow(operatorId, attemptId);
                if (userClient) { try { await userClient.disconnect(); } catch (_) {} userClient = null; }
              }
            }
          } finally {
            activePremiumSessions.delete(phone);
            liveStatus.delete(phone);
            actionMsgId.delete(phone);
            triggerRelayNext(relayIndex);
          }

          await updateProgress();
        };

        await Promise.all(targets.map((t, idx) => processOneTarget(t, idx + 1)));

        const summary =
          `${success > 0 ? "⭐" : "❌"} <b>Avto Premium yakunlandi!</b>\n\n✅ Muvaffaqiyat: <b>${success}</b> ta\n❌ Xato: <b>${failed}</b> ta\n\n${lines.filter(Boolean).join("\n")}`;

        const finishKb = new InlineKeyboard();
        if (remainingToRun > 0) {
          finishKb
            .text(`Boshqa karta bilan yana ${remainingToRun} tasini olish`, `batch_premium:${remainingToRun}`).row()
            .text("❌ Qolganini bekor qilish", "menu_home").row();
        } else {
          finishKb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
        }

        try {
          await ctx.api.editMessageText(chatId, msgId, summary, { parse_mode: "HTML", reply_markup: finishKb });
        } catch (_) {
          await ctx.reply(summary, { parse_mode: "HTML", reply_markup: finishKb });
        }
      })();
    } finally {
      batchPremiumRunning.delete(operatorId);
    }
  });
}
