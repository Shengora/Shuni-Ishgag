/**
 * Card handlers: /addcard, /cards
 * + card_detail, card_setdefault, card_delete, card_delete_confirm
 * + menu_cards, menu_addcard
 */
import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import { savedCards, cardUsages, proxySettings } from "@workspace/db";
import { eq, and, desc, gte } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { E, EID } from "../../lib/emoji.js";
import { recordStat } from "../super-admin.js";
import { notifyError } from "../notify.js";
import { isOperator, menuButton } from "./shared.js";

export function registerCardsHandlers(bot: Bot): void {

  const ADDCARD_USAGE =
    `${E.CARD} <b>Karta qo'shish</b>\n\n` +
    `Format:\n<code>/addcard BANK_NOMI KARTA_RAQAMI MM/YY CVV ISM SHARIF</code>\n\n` +
    `Misollar:\n` +
    `<code>/addcard Kapital 4111111111111111 12/26 123 Alisher Valiyev</code>\n` +
    `<code>/addcard Uzcard 8600123456781234 03/28 456 Sardor</code>\n` +
    `<code>/addcard Humo 9860123456781234 07/27 789 Nodir</code>`;

  // ── /addcard ──────────────────────────────────────────────────────────────
  bot.command("addcard", async (ctx) => {
    const userId = ctx.from!.id;
    if (!await isOperator(userId)) return;

    const raw = ctx.match?.trim() || "";

    // We expect at least 5 logical parts now: Bank, Card, Expiry, CVV, Name
    // However, card number and name might have spaces.
    const parts = raw.split(/\s+/);
    if (parts.length < 5) {
      await ctx.reply(ADDCARD_USAGE, { parse_mode: "HTML" });
      return;
    }

    const bankName = parts[0];

    // Find the indices for MM/YY and CVV. They should be somewhere in the middle before the name.
    // Usually the format is: Bank [Card...] MM/YY CVV [Name...]
    // We scan from left to right to find the expiry (MM/YY or MMYY) and assume the next token is CVV.
    let expiryIndex = -1;
    for (let i = 1; i < parts.length - 1; i++) {
      if (/^\d{2}\/\d{2}$/.test(parts[i]) || /^\d{4}$/.test(parts[i])) {
        // If it looks like expiry and the next one looks like CVV (3-4 digits)
        if (/^\d{3,4}$/.test(parts[i + 1])) {
          expiryIndex = i;
          break;
        }
      }
    }

    if (expiryIndex === -1) {
      // Fallback: if we didn't find the exact match, assume old logic relative positions from the end of card,
      // but we need the user to input Name. Let's just use regex on the whole string to extract parts reliably.
      await ctx.reply(
        `${E.NO} Format noto'g'ri. Iltimos kartadan keyin Muddat (MM/YY) va CVV, so'ngra ism-sharifingizni kiriting.\nMisol: <code>/addcard Kapital 4111 1111 1111 1111 12/26 123 Alisher Valiyev</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const expiryRaw = parts[expiryIndex];
    const cvv = parts[expiryIndex + 1];

    // Card number is everything between bankName and expiry
    const cardParts = parts.slice(1, expiryIndex);
    const cardNumber = cardParts.join("").replace(/\D/g, "");

    // Name is everything after CVV
    const nameParts = parts.slice(expiryIndex + 2);
    const cardHolder = nameParts.join(" ").trim();

    if (!cardHolder) {
      await ctx.reply(`${E.NO} Ism-sharif ko'rsatilmagan. Iltimos, oxirida ismingizni kiriting.`, { parse_mode: "HTML" });
      return;
    }

    // Normalise to MM/YY canonical format (premium.ts expects "MM/YY" for split("/"))
    const expiryDigits = expiryRaw.replace(/\D/g, "");
    if (expiryDigits.length !== 4) {
      await ctx.reply(
        `${E.NO} Muddat noto'g'ri. MM/YY formatida kiriting, masalan <code>12/26</code>.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const expiry = `${expiryDigits.slice(0, 2)}/${expiryDigits.slice(2, 4)}`; // → "12/26"
    if (cardNumber.length < 13 || cardNumber.length > 19) {
      await ctx.reply(`${E.NO} Karta raqami noto'g'ri uzunlikda (${cardNumber.length} ta raqam).`, { parse_mode: "HTML" });
      return;
    }
    if (cvv.length < 3 || cvv.length > 4) {
      await ctx.reply(`${E.NO} CVV 3 yoki 4 raqamli bo'lishi kerak.`, { parse_mode: "HTML" });
      return;
    }

    // Check if already exists
    const exist = await db.select({ id: savedCards.id }).from(savedCards)
      .where(and(eq(savedCards.userId, userId), eq(savedCards.cardNumber, cardNumber)))
      .limit(1);
    if (exist.length) {
      await ctx.reply(
        `${E.ALERT} Bu karta allaqachon saqlangan.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Kartalar", "menu_cards").icon(EID.CARD).primary() },
      );
      return;
    }

    // First card of this user → set as default
    const existing = await db.select({ id: savedCards.id }).from(savedCards)
      .where(eq(savedCards.userId, userId)).limit(1);
    const isDefault = existing.length === 0;

    const cardNumberMasked = `****${cardNumber.slice(-4)}`;

    await db.insert(savedCards).values({
      userId,
      cardHolder, // Full name of the user
      bankName,
      cardNumber,
      cardNumberMasked,
      expiry,
      cvv,
      isDefault,
    });
    await recordStat(userId, "card_added");

    const maskedFull = cardNumber.replace(/(.{4})/g, "$1 ").trim();

    await ctx.reply(
      `${E.OK} <b>Karta qo'shildi!</b>\n\n` +
      `🏦 Bank: <b>${bankName}</b>\n` +
      `💳 Raqam: <code>${maskedFull}</code>\n` +
      `📅 Muddat: ${expiry}\n` +
      (isDefault ? `\n${E.STAR} Asosiy karta sifatida belgilandi` : ""),
      { parse_mode: "HTML", reply_markup: menuButton() },
    );
  });

  // ── menu_addcard callback (shows prompt) ──────────────────────────────────
  bot.callbackQuery("menu_addcard", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from.id;
    if (!await isOperator(userId)) return;

    await ctx.reply(ADDCARD_USAGE, { parse_mode: "HTML", reply_markup: menuButton() });
  });

  // ── /cards & menu_cards ───────────────────────────────────────────────────
  const showCardList = async (reply: (t: string, o?: any) => Promise<any>, userId: number) => {
    const cards = await db.select().from(savedCards)
      .where(eq(savedCards.userId, userId))
      .orderBy(desc(savedCards.createdAt));

    if (!cards.length) {
      await reply(
        `${E.CARD} <b>Kartalar</b>\n\nHech qanday karta saqlanmagan.\n\nKarta qo'shish uchun:`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Karta qo'shish", "menu_addcard").icon(EID.ADD).success().row().text("Bosh menyu", "menu_home").icon(EID.HOME).primary() },
      );
      return;
    }

    const [proxyRow] = await db.select().from(proxySettings).where(eq(proxySettings.id, 1)).limit(1);
    const cardLimitDays = proxyRow?.cardLimitDays ?? 3;
    const periodStart = new Date(Date.now() - cardLimitDays * 24 * 60 * 60 * 1000);

    const kb = new InlineKeyboard();
    for (const c of cards) {
      const last4  = c.cardNumber.slice(-4);
      const def    = c.isDefault ? " ⭐" : "";
      kb.text(`****${last4}${def}`, `card_detail:${c.id}`).icon(EID.CARD).primary().row();
    }
    kb.text("Karta qo'shish", "menu_addcard").icon(EID.ADD).success()
      .text("Bosh menyu", "menu_home").icon(EID.HOME).primary();

    const lines: string[] = [];
    for (const c of cards) {
      const usages = await db.select().from(cardUsages).where(
        and(eq(cardUsages.cardNumber, c.cardNumber), eq(cardUsages.operatorId, userId), gte(cardUsages.usedAt, periodStart))
      );
      const used = usages.length;
      const def = c.isDefault ? ` ${E.STAR} asosiy` : "";
      lines.push(`• ****${c.cardNumber.slice(-4)} (${c.expiry}) — ${used}/5 (limit)${def}`);
    }

    await reply(
      `${E.CARD} <b>Saqlangan kartalar</b> (${cards.length} ta):\n\n` + lines.join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
  };

  bot.command("cards", async (ctx) => {
    const userId = ctx.from!.id;
    if (!await isOperator(userId)) return;
    await showCardList(ctx.reply.bind(ctx), userId);
  });

  bot.callbackQuery("menu_cards", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from.id;
    if (!await isOperator(userId)) return;
    await showCardList(ctx.reply.bind(ctx), userId);
  });

  // ── card_detail ───────────────────────────────────────────────────────────
  bot.callbackQuery(/^card_detail:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from.id;
    if (!await isOperator(userId)) return;
    const cardId = parseInt(ctx.match[1]);

    const [card] = await db.select().from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.reply(`${E.NO} Karta topilmadi.`, { parse_mode: "HTML", reply_markup: menuButton() });
      return;
    }

    const masked = card.cardNumber.replace(/(.{4})/g, "$1 ").trim();

    const kb = new InlineKeyboard();
    if (!card.isDefault) {
      kb.text("Asosiy qilib belgilash", `card_setdefault:${card.id}`).icon(EID.STAR).success().row();
    }
    kb.text("O'chirish", `card_delete:${card.id}`).icon(EID.TRASH).danger()
      .text("Orqaga", "menu_cards").icon(EID.CARD).primary();

    await ctx.reply(
      `${E.CARD} <b>Karta ma'lumotlari</b>\n\n` +
      `💳 Raqam: <code>${masked}</code>\n` +
      `📅 Muddat: ${card.expiry}\n` +
      `🔒 CVV: <code>${card.cvv}</code>\n` +
      (card.cardHolder ? `👤 Egasi: ${card.cardHolder}\n` : "") +
      (card.isDefault ? `\n${E.STAR} Bu asosiy karta` : ""),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── card_setdefault ───────────────────────────────────────────────────────
  bot.callbackQuery(/^card_setdefault:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from.id;
    if (!await isOperator(userId)) return;
    const cardId = parseInt(ctx.match[1]);

    const [card] = await db.select().from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.answerCallbackQuery({ text: "❌ Karta topilmadi.", show_alert: true });
      return;
    }

    await db.update(savedCards).set({ isDefault: false }).where(eq(savedCards.userId, userId));
    await db.update(savedCards).set({ isDefault: true }).where(eq(savedCards.id, cardId));

    await ctx.reply(
      `${E.OK} ****${card.cardNumber.slice(-4)} asosiy karta sifatida belgilandi.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Kartalar", "menu_cards").icon(EID.CARD).primary() },
    );
  });

  // ── card_delete ───────────────────────────────────────────────────────────
  bot.callbackQuery(/^card_delete:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from.id;
    if (!await isOperator(userId)) return;
    const cardId = parseInt(ctx.match[1]);

    const [card] = await db.select().from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.answerCallbackQuery({ text: "❌ Karta topilmadi.", show_alert: true });
      return;
    }

    const kb = new InlineKeyboard()
      .text("Ha, o'chir", `card_delete_confirm:${card.id}`).icon(EID.TRASH).danger()
      .text("Bekor", `card_detail:${card.id}`).icon(EID.NO).primary();

    await ctx.reply(
      `${E.ALERT} <b>Kartani o'chirmoqchimisiz?</b>\n\n💳 ****${card.cardNumber.slice(-4)}`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── card_delete_confirm ───────────────────────────────────────────────────
  bot.callbackQuery(/^card_delete_confirm:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from.id;
    if (!await isOperator(userId)) return;
    const cardId = parseInt(ctx.match[1]);

    try {
      const [card] = await db.select().from(savedCards)
        .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
        .limit(1);

      if (!card) {
        await ctx.answerCallbackQuery({ text: "❌ Karta topilmadi.", show_alert: true });
        return;
      }

      await db.delete(savedCards).where(eq(savedCards.id, cardId));

      // If it was the default, promote next oldest
      if (card.isDefault) {
        const [next] = await db.select().from(savedCards)
          .where(eq(savedCards.userId, userId))
          .orderBy(desc(savedCards.createdAt))
          .limit(1);
        if (next) {
          await db.update(savedCards).set({ isDefault: true }).where(eq(savedCards.id, next.id));
        }
      }

      await ctx.reply(
        `${E.OK} Karta o'chirildi (****${card.cardNumber.slice(-4)}).`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Kartalar", "menu_cards").icon(EID.CARD).primary() },
      );
    } catch (err: any) {
      logger.error({ err }, "card_delete_confirm error");
      await notifyError(err, "card_delete_confirm error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });
}
