/**
 * Session/number handlers: /getnumber, /list, /pass, /manualcode
 * + cancel, freeze, getcode, getnew callbacks
 *
 * Deduplication: /getnumber and getnew: share the same doGetNumber() helper.
 */
import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import { pendingNumbers, userbotSessions } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { E, EID } from "../../lib/emoji.js";
import { recordStat } from "../super-admin.js";
import {
  getMasterClient,
  sendCommandAndWaitForNumber,
  clickRepreamButton,
  sendCodeForPhone,
  waitForRepreamCode,
  parseRepreamCodeMessage,
  signInWithCodeAndPass,
  verifyAndPurgeDeadSessions,
} from "../client.js";
import { notifyError } from "../notify.js";
import {
  isOperator,
  activePremiumSessions,
  getOperatorSource,
  autoFreezeAndNotify,
  finishSignInAndDeliverLink,
  claimUserbotSession,
  getDefaultCard,
  PREMIUM_BOT,
  DEFAULT_REPREAM_BOT,
  menuButton,
} from "./shared.js";

// ── Shared helper: fetch one number from provider and show Cancel/Freeze/GetCode ──
// Used by both /getnumber command and getnew: callback.
async function doGetNumber(
  uid: number,
  api: { editMessageText: (chatId: number, msgId: number, text: string, opts?: any) => Promise<any> },
  chatId: number,
  msgId: number,
): Promise<void> {
  const repreamBot = await getOperatorSource(uid);
  const client = await getMasterClient(uid);
  if (!client) {
    await api.editMessageText(chatId, msgId, "❌ Operator hisob ulanmagan. /login buyrug'ini yuboring.").catch(() => {});
    return;
  }

  try {
    const result = await sendCommandAndWaitForNumber(client, repreamBot, "/getnumber");

    if (!result) {
      await api.editMessageText(
        chatId, msgId,
        `${E.NO} @${repreamBot} dan javob kelmadi. Keyinroq urinib ko'ring.`,
      ).catch(() => {});
      return;
    }

    await db.delete(pendingNumbers).where(and(eq(pendingNumbers.requestedByUserId, uid), eq(pendingNumbers.status, "waiting")));

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

    await api.editMessageText(
      chatId, msgId,
      `${E.PHONE} <b>Raqam olindi!</b>\n\n<code>${result.phone}</code>\n\nQuyidagi tugmalardan birini tanlang:`,
      { parse_mode: "HTML", reply_markup: keyboard },
    ).catch(() => {});
  } catch (err: any) {
    logger.error({ err }, "doGetNumber error");
    await notifyError(err, "doGetNumber error");
    await api.editMessageText(chatId, msgId, `❌ Xato: ${err.message}`).catch(() => {});
  }
}

export function registerSessionHandlers(bot: Bot): void {

  // ── /getnumber command ────────────────────────────────────────────────────
  bot.command("getnumber", async (ctx) => {
    const uid = ctx.from!.id;
    if (!await isOperator(uid)) return;

    const repreamBot = await getOperatorSource(uid);
    const statusMsg = await ctx.reply(
      `${E.CLOCK} @${repreamBot} dan raqam so'ralmoqda...`,
      { parse_mode: "HTML" },
    );
    const chatId = ctx.chat!.id;
    const msgId = statusMsg.message_id;

    void (async () => {
      await doGetNumber(uid, ctx.api, chatId, msgId);
    })();
  });

  // ── /list command ─────────────────────────────────────────────────────────
  bot.command("list", async (ctx) => {
    const uid = ctx.from!.id;
    if (!await isOperator(uid)) return;

    const sessions = await db
      .select()
      .from(userbotSessions)
      .where(eq(userbotSessions.ownerId, uid))
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

  // ── /pass — manual 2FA password retry ────────────────────────────────────
  bot.command("pass", async (ctx) => {
    const password = ctx.match?.trim();
    if (!password) {
      await ctx.reply("❌ Format: /pass <code>parolingiz</code>", { parse_mode: "HTML" });
      return;
    }

    const userId = ctx.from!.id;
    if (!await isOperator(userId)) return;

    const pending = await db
      .select()
      .from(pendingNumbers)
      .where(and(eq(pendingNumbers.requestedByUserId, userId), eq(pendingNumbers.status, "awaiting_pass")))
      .orderBy(desc(pendingNumbers.createdAt))
      .limit(1);

    if (!pending.length || !pending[0].phoneCodeHash || !pending[0].otpCode) {
      await ctx.reply("❌ Faol 2FA so'rov topilmadi. Qaytadan /getnew dan boshlang.");
      return;
    }

    const row = pending[0];
    await ctx.reply("⏳ Parol tekshirilmoqda...");

    void (async () => {
      try {
        const sessionString = await signInWithCodeAndPass(row.phone, row.phoneCodeHash!, row.otpCode!, password);
        await finishSignInAndDeliverLink(ctx, row, sessionString, userId, row.otpCode!);
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
    })();
  });

  // ── /manualcode — fallback OTP entry ─────────────────────────────────────
  bot.command("manualcode", async (ctx) => {
    const userId = ctx.from!.id;
    if (!await isOperator(userId)) return;

    const parts = ctx.match?.trim().split(/\s+/);
    if (!parts || parts.length < 2) {
      await ctx.reply("❌ Format: /manualcode <code>+998901234567 12345</code>", { parse_mode: "HTML" });
      return;
    }

    const phone = parts[0];
    const otp = parts[1];

    const pending = await db
      .select()
      .from(pendingNumbers)
      .where(and(eq(pendingNumbers.phone, phone), eq(pendingNumbers.requestedByUserId, userId)))
      .orderBy(desc(pendingNumbers.createdAt))
      .limit(1);

    if (!pending.length || !pending[0].phoneCodeHash) {
      await ctx.reply("❌ Bu raqam uchun faol so'rov topilmadi yoki phoneCodeHash yo'q.");
      return;
    }

    const savedHash = pending[0].phoneCodeHash;
    await ctx.reply(`⏳ <code>${phone}</code> ga kirilmoqda...`, { parse_mode: "HTML" });

    void (async () => {
      try {
        const sessionString = await signInWithCodeAndPass(phone, savedHash, otp, null);

        const claim = await claimUserbotSession(phone, sessionString, userId);
        if (!claim.ok) {
          await ctx.reply(
            `⚠️ <code>${phone}</code> raqami allaqachon boshqa admin tomonidan olingan. O'tkazib yuborildi.`,
            { parse_mode: "HTML" },
          );
          await db.update(pendingNumbers).set({ status: "frozen" }).where(eq(pendingNumbers.id, pending[0].id));
          return;
        }

        await db.update(pendingNumbers).set({ status: "completed", otpCode: otp }).where(eq(pendingNumbers.id, pending[0].id));
        await recordStat(userId, "getnumber");
        await recordStat(userId, "session_created");

        const card = await getDefaultCard(userId);

        await ctx.reply(
          card
            ? `⏳ @${PREMIUM_BOT} dan havola olinmoqda... (💳 ****${card.cardNumber.slice(-4)} bilan)`
            : `⏳ @${PREMIUM_BOT} dan havola olinmoqda...`,
        );

        const { getLinkFromPremiumBot } = await import("../client.js");
        const link = await getLinkFromPremiumBot(sessionString, phone, PREMIUM_BOT, card);

        if (link) {
          await db.update(userbotSessions).set({ telegramLink: link }).where(eq(userbotSessions.phone, phone));
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
    })();
  });

  // ── cancel: callback ──────────────────────────────────────────────────────
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

    await db.update(pendingNumbers).set({ status: "cancelled" }).where(eq(pendingNumbers.id, pending[0].id));
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
    })();
  });

  // ── freeze: callback ──────────────────────────────────────────────────────
  bot.callbackQuery(/^freeze:(\d+)$/, async (ctx) => {
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

    await ctx.answerCallbackQuery("⏳ Freeze qilinmoqda...").catch(() => {});
    await ctx.editMessageText(
      `🧊 <code>${pending[0].phone}</code> freeze qilinyapti...`,
      { parse_mode: "HTML" },
    ).catch(() => {});

    void (async () => {
      await autoFreezeAndNotify(ctx, pending[0], "Operator tomonidan");
    })();
  });

  // ── getcode: callback ─────────────────────────────────────────────────────
  bot.callbackQuery(/^getcode:(\d+)$/, async (ctx) => {
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

    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(
      `⏳ <code>${pending[0].phone}</code> uchun kod so'ralmoqda...`,
      { parse_mode: "HTML" },
    );

    await ctx.reply(
      `⏳ Telegram ga <code>${pending[0].phone}</code> raqamiga kod yuborilmoqda...`,
      { parse_mode: "HTML" },
    );

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

      await db.update(pendingNumbers).set({ phoneCodeHash }).where(eq(pendingNumbers.id, pending[0].id));

      if (!pending[0].repreamMessageId || !pending[0].getCodeData) {
        await autoFreezeAndNotify(ctx, pending[0], "Manba bot tugmasi ma'lumoti topilmadi");
        return;
      }

      const providerBot = pending[0].providerBot ?? DEFAULT_REPREAM_BOT;

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
        await autoFreezeAndNotify(ctx, pending[0], `@${providerBot} dan 30 soniya ichida javob kelmadi`);
        return;
      }

      const parsed = parseRepreamCodeMessage(codeResponse.text);

      logger.info({ phone: pending[0].phone, hasCode: !!parsed.code, hasPass: !!parsed.pass, hasNumber: !!parsed.number }, "Parsed repream code message");

      if (!parsed.code) {
        await autoFreezeAndNotify(
          ctx,
          pending[0],
          `@${providerBot} Code maydoni bo'sh yoki topilmadi\n\n📩 Javob:\n<code>${codeResponse.text.slice(0, 200)}</code>`,
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

      let sessionString: string;
      try {
        sessionString = await signInWithCodeAndPass(pending[0].phone, phoneCodeHash, otp, twoFAPass);
      } catch (err: any) {
        const msg: string = err?.errorMessage ?? err?.message ?? "";
        const needsPassword = msg.includes("PASSWORD_HASH_INVALID") || msg.includes("SESSION_PASSWORD_NEEDED");

        if (needsPassword) {
          logger.warn({ phone: pending[0].phone, msg }, "signInWithCodeAndPass needs password");
          await db.update(pendingNumbers).set({ status: "awaiting_pass", otpCode: otp }).where(eq(pendingNumbers.id, pending[0].id));
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
        await autoFreezeAndNotify(ctx, pending[0], `Telegram kirish xatosi: ${msg}`);
        return;
      }

      await finishSignInAndDeliverLink(ctx, pending[0], sessionString, userId, otp);
    })();
  });

  // ── getnew: callback (after freeze — get new number) ─────────────────────
  bot.callbackQuery(/^getnew:(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    if (ctx.from.id !== userId) {
      await ctx.answerCallbackQuery("❌ Bu sizning so'rovingiz emas.").catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery("⏳ Yangi raqam olinmoqda...").catch(() => {});

    const newBot = await getOperatorSource(userId);
    const statusMsg = await ctx.reply(`⏳ @${newBot} dan yangi raqam so'ralmoqda...`);

    void (async () => {
      await doGetNumber(userId, ctx.api, ctx.chat!.id, statusMsg.message_id);
    })();
  });

  // ── menu_list callback ────────────────────────────────────────────────────
  bot.callbackQuery("menu_list", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from.id;

    const sessions = await db
      .select()
      .from(userbotSessions)
      .where(eq(userbotSessions.ownerId, uid))
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
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Yaroqsizlarni tozalash", "menu_cleanup_sessions").icon(EID.TRASH).danger()
          .row()
          .text("Bosh menyu", "menu_home").icon(EID.HOME).primary(),
      },
    );
  });

  // ── menu_cleanup_sessions callback ────────────────────────────────────────
  bot.callbackQuery("menu_cleanup_sessions", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const statusMsg = await ctx.reply("🧹 Sessiyalar tekshirilmoqda...");

    let lastEdit = 0;
    const result = await verifyAndPurgeDeadSessions((checked, total) => {
      const now = Date.now();
      if (now - lastEdit < 2000 && checked < total) return;
      lastEdit = now;
      ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `🧹 Tekshirilmoqda: ${checked}/${total}...`).catch(() => {});
    }, activePremiumSessions, ctx.from.id);

    const summary =
      `🧹 <b>Tozalash yakunlandi</b>\n\n` +
      `Tekshirildi: <b>${result.checked}</b> ta\n` +
      `O'chirildi (yaroqsiz): <b>${result.removed.length}</b> ta` +
      (result.removed.length ? `\n${result.removed.map((p) => `  ❌ <code>${p}</code>`).join("\n")}` : "") +
      (result.skipped.length ? `\n⏭ O'tkazib yuborildi (hozir band): <b>${result.skipped.length}</b> ta` : "") +
      (result.errors.length ? `\n\n⚠️ Tekshirib bo'lmadi: ${result.errors.length} ta` : "");

    await ctx.api
      .editMessageText(statusMsg.chat.id, statusMsg.message_id, summary, {
        parse_mode: "HTML",
        reply_markup: menuButton(),
      })
      .catch(() => ctx.reply(summary, { parse_mode: "HTML", reply_markup: menuButton() }));
  });
}
