/**
 * Login handlers: /login, /code, /resendcode, /2fa
 * + menu_login, login_slot_add, login_delete_confirm, login_delete_do
 * + master_share_list, master_share_slot, master_share_slot_do
 */
import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import { masterSessions, pendingAuthStates, admins } from "@workspace/db";
import { eq, and, asc, desc, ne } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { E, EID } from "../../lib/emoji.js";
import {
  isAnySuperAdmin,
  recordStat,
} from "../super-admin.js";
import {
  startMasterLogin,
  resendCodeForPhone,
  completeMasterLoginCode,
  completeMasterLogin2FA,
  removeMasterSession,
  TwoFARequiredError,
} from "../client.js";
import { notifyError } from "../notify.js";
import { mainMenuKeyboard, menuButton } from "./shared.js";

export function registerLoginHandlers(bot: Bot): void {

  // ── /login ────────────────────────────────────────────────────────────────
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

    // Find first free slot (1-3)
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

    // Guard: this phone must not already be linked in any slot
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

      // Auto-login: code read from existing session
      if (autoCode) {
        await ctx.reply(`${E.REFRESH} <b>${phone}</b> — mavjud sessiondan kod o'qildi, kirilmoqda...`, { parse_mode: "HTML" });
        try {
          const sessionString = await completeMasterLoginCode(phone, autoCode, phoneCodeHash, operatorId, slot);
          await db.insert(masterSessions).values({ operatorId, slot, phone, sessionString })
            .onConflictDoUpdate({ target: [masterSessions.operatorId, masterSessions.slot], set: { phone, sessionString } });
          await db.delete(pendingAuthStates).where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
          await ctx.reply(
            `${E.OK} <b>Slot ${slot}:</b> <code>${phone}</code> muvaffaqiyatli ulandi!`,
            { parse_mode: "HTML", reply_markup: mainMenuKeyboard(true) },
          );
        } catch (autoErr: any) {
          if (autoErr instanceof TwoFARequiredError) {
            await db.delete(pendingAuthStates).where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
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

      // Manual flow
      await db.delete(pendingAuthStates).where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
      await db.insert(pendingAuthStates).values({ userId: operatorId, slot, phone, phoneCodeHash, step: "code" });

      const codeDestHint =
        codeType === "SentCodeTypeApp"
          ? `${E.PHONE} Kod <b>Telegram ilovangizga</b> yuborildi.`
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
          `${E.CLOCK} <b>Telegram FLOOD_WAIT</b>\n\nKutish vaqti: <b>${hours > 0 ? `${hours} soat ` : ""}${mins} daqiqa</b>\n\nBoshqa raqam sinab ko'ring yoki kutib turing.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      await notifyError(err, "login command error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });

  // ── /code ─────────────────────────────────────────────────────────────────
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
      .select().from(pendingAuthStates)
      .where(eq(pendingAuthStates.userId, operatorId))
      .orderBy(desc(pendingAuthStates.createdAt)).limit(1);

    if (!authStates.length) {
      await ctx.reply("❌ Avval /login buyrug'ini yuboring.");
      return;
    }

    const { phone, phoneCodeHash, slot } = authStates[0];
    try {
      await ctx.reply(`${E.CLOCK} Kirilmoqda...`, { parse_mode: "HTML" });
      const sessionString = await completeMasterLoginCode(phone, code, phoneCodeHash, operatorId, slot);
      await db.insert(masterSessions).values({ operatorId, slot, phone, sessionString })
        .onConflictDoUpdate({ target: [masterSessions.operatorId, masterSessions.slot], set: { phone, sessionString } });
      await db.delete(pendingAuthStates).where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
      await recordStat(operatorId, "login");
      await ctx.reply(
        `${E.OK} <b>Slot ${slot}:</b> <code>${phone}</code> muvaffaqiyatli ulandi!`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard(true) },
      );
    } catch (err: any) {
      if (err instanceof TwoFARequiredError) {
        await db.update(pendingAuthStates).set({ step: "2fa" })
          .where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
        await ctx.reply(
          `${E.LOCK} <b>2FA parol kerak!</b>\n\nParolingizni kiriting:\n/2fa <code>parolingiz</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      if (err?.errorMessage === "PHONE_CODE_INVALID" || err?.message?.includes("PHONE_CODE_INVALID")) {
        await ctx.reply(
          `${E.NO} <b>Kod noto'g'ri.</b>\n\nQaytadan urinib ko'ring: /login`,
          { parse_mode: "HTML" },
        );
        return;
      }
      if (err?.errorMessage === "PHONE_CODE_EXPIRED" || err?.message?.includes("PHONE_CODE_EXPIRED")) {
        await ctx.reply(`${E.CLOCK} <b>Kod muddati o'tgan.</b>\n\nYangi kod olish uchun: /login`, { parse_mode: "HTML" });
        return;
      }
      logger.error({ err }, "code command error");
      await notifyError(err, "code command error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });

  // ── /resendcode ───────────────────────────────────────────────────────────
  bot.command("resendcode", async (ctx) => {
    const operatorId = ctx.from!.id;
    if (!await isAnySuperAdmin(operatorId)) {
      await ctx.reply(`${E.NO} Bu buyruq faqat super admin uchun.`, { parse_mode: "HTML" });
      return;
    }

    const authStates = await db
      .select().from(pendingAuthStates)
      .where(eq(pendingAuthStates.userId, operatorId))
      .orderBy(desc(pendingAuthStates.createdAt)).limit(1);

    if (!authStates.length || authStates[0].step !== "code") {
      await ctx.reply("❌ Faol login so'rovi topilmadi. Avval /login yuboring.");
      return;
    }

    const { phone, phoneCodeHash, slot } = authStates[0];
    await ctx.reply(`${E.CLOCK} Kod qayta yuborilmoqda...`, { parse_mode: "HTML" });

    void (async () => {
      try {
        const { newPhoneCodeHash, codeType } = await resendCodeForPhone(phone, phoneCodeHash, operatorId, slot);
        await db.update(pendingAuthStates).set({ phoneCodeHash: newPhoneCodeHash })
          .where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));

        const hint =
          codeType === "SentCodeTypeSms"   ? `${E.ANNOUNCE} Kod <b>SMS</b> orqali yuborildi.`
          : codeType === "SentCodeTypeCall" ? `${E.PHONE} Kod <b>telefon qo'ng'irog'i</b> orqali keladi.`
          : codeType === "SentCodeTypeApp"  ? `${E.PHONE} Kod <b>Telegram ilovangizga</b> yuborildi.`
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
    })();
  });

  // ── /2fa ──────────────────────────────────────────────────────────────────
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
      .select().from(pendingAuthStates)
      .where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.step, "2fa")))
      .orderBy(desc(pendingAuthStates.createdAt)).limit(1);

    if (!authStates.length) {
      await ctx.reply("❌ Faol 2FA so'rov topilmadi.\n\nQaytadan /login dan boshlang.");
      return;
    }

    const { phone, slot } = authStates[0];

    try {
      await ctx.reply(`${E.CLOCK} 2FA paroli tekshirilmoqda...`, { parse_mode: "HTML" });
      const sessionString = await completeMasterLogin2FA(password, operatorId, slot);
      await db.insert(masterSessions).values({ operatorId, slot, phone, sessionString })
        .onConflictDoUpdate({ target: [masterSessions.operatorId, masterSessions.slot], set: { phone, sessionString } });
      await db.delete(pendingAuthStates).where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
      await recordStat(operatorId, "login");
      await ctx.reply(
        `${E.OK} <b>Slot ${slot}:</b> <code>${phone}</code> 2FA bilan muvaffaqiyatli ulandi!`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard(true) },
      );
    } catch (err: any) {
      if (err?.message?.includes("Faol login jarayoni topilmadi")) {
        await db.delete(pendingAuthStates).where(and(eq(pendingAuthStates.userId, operatorId), eq(pendingAuthStates.slot, slot)));
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

  // ── menu_login callback ───────────────────────────────────────────────────
  bot.callbackQuery("menu_login", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;

    if (!await isAnySuperAdmin(operatorId)) {
      await ctx.answerCallbackQuery({ text: "❌ Faqat super admin uchun.", show_alert: true }).catch(() => {});
      return;
    }

    const rows = await db
      .select().from(masterSessions)
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
      return row ? `${E.OK} Slot ${s}: <code>${row.phone}</code>` : `${E.NO} Slot ${s}: Bo'sh`;
    });

    await ctx.reply(
      `${E.KEY} <b>Operator loginlar</b>\n\n${lines.join("\n")}\n\nMaksimum 3 ta telefon ulash mumkin.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── login_slot_add ────────────────────────────────────────────────────────
  bot.callbackQuery(/^login_slot_add:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!await isAnySuperAdmin(ctx.from.id)) return;
    const slot = parseInt(ctx.match[1]);
    await ctx.reply(
      `${E.ADD} <b>Slot ${slot} — Login</b>\n\nTelefon raqamingizni yuboring:\n<code>/login +998901234567</code>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Orqaga", "menu_login").icon(EID.KEY).primary() },
    );
  });

  // ── login_delete_confirm ──────────────────────────────────────────────────
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

  // ── login_delete_do ───────────────────────────────────────────────────────
  bot.callbackQuery(/^login_delete_do:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;
    if (!await isAnySuperAdmin(operatorId)) return;
    const slot = parseInt(ctx.match[1]);
    try {
      await removeMasterSession(operatorId, slot);
      await db.delete(masterSessions).where(and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, slot)));
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

  // ── master_share_list ─────────────────────────────────────────────────────
  bot.callbackQuery("master_share_list", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;

    const ownRows = await db
      .select().from(masterSessions)
      .where(eq(masterSessions.operatorId, operatorId))
      .orderBy(asc(masterSessions.slot));

    if (!ownRows.length) {
      await ctx.reply(`${E.NO} Hech qanday login topilmadi.`, { parse_mode: "HTML", reply_markup: menuButton() });
      return;
    }

    const adminRows = await db
      .select({ telegramUserId: admins.telegramUserId, firstName: admins.firstName, username: admins.username })
      .from(admins).where(eq(admins.isBlocked, false));
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

  // ── master_share_slot ─────────────────────────────────────────────────────
  bot.callbackQuery(/^master_share_slot:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;
    const slot = Number(ctx.match[1]);

    const [slotRow] = await db
      .select().from(masterSessions)
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
      .from(admins).where(eq(admins.isBlocked, false));

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
        .icon(isOn ? EID.OK : EID.ADD)[isOn ? "success" : "primary"]().row();
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

  // ── master_share_slot_do ──────────────────────────────────────────────────
  bot.callbackQuery(/^master_share_slot_do:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;
    const slot     = Number(ctx.match[1]);
    const targetId = Number(ctx.match[2]);

    const [slotRow] = await db
      .select().from(masterSessions)
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
      // Admin boshqa slotda bo'lsa — u yerdan olib tashla (1 admin faqat 1 slotda)
      const otherRows = await db
        .select().from(masterSessions)
        .where(and(eq(masterSessions.operatorId, operatorId), ne(masterSessions.slot, slot)));
      for (const r of otherRows) {
        if (!r.sharedWith) continue;
        try {
          const ids: number[] = JSON.parse(r.sharedWith);
          if (ids.includes(targetId)) {
            const newIds = ids.filter(id => id !== targetId);
            await db.update(masterSessions)
              .set({ sharedWith: newIds.length ? JSON.stringify(newIds) : null })
              .where(and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, r.slot)));
          }
        } catch { /* ignore */ }
      }
    }

    await db.update(masterSessions)
      .set({ sharedWith: shared.length ? JSON.stringify(shared) : null })
      .where(and(eq(masterSessions.operatorId, operatorId), eq(masterSessions.slot, slot)));

    await removeMasterSession(targetId).catch(() => {});

    const adminRows = await db
      .select({ telegramUserId: admins.telegramUserId, firstName: admins.firstName, username: admins.username })
      .from(admins).where(eq(admins.isBlocked, false));

    const others = adminRows.filter(r => r.telegramUserId !== operatorId);
    const kb = new InlineKeyboard();
    for (const r of others) {
      const name = r.username ? `@${r.username}` : r.firstName ?? String(r.telegramUserId);
      const isOn = shared.includes(r.telegramUserId);
      kb.text(isOn ? `${name} ✅` : name, `master_share_slot_do:${slot}:${r.telegramUserId}`)
        .icon(isOn ? EID.OK : EID.ADD)[isOn ? "success" : "primary"]().row();
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
}
