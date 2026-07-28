/**
 * Verifier bot management handlers:
 * menu_verifiers, verifier_detail, verifier_default,
 * verifier_disable, verifier_enable, verifier_remove, verifier_add
 * + text handler for bot username input
 */
import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import { verifierBots } from "@workspace/db";
import { eq } from "drizzle-orm";
import { E, EID } from "../../lib/emoji.js";
import { awaitingVerifierInput, menuButton } from "./shared.js";

export function registerVerifierHandlers(bot: Bot): void {

  // ── menu_verifiers — list all verifier bots ───────────────────────────────
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

  // ── verifier_detail ───────────────────────────────────────────────────────
  bot.callbackQuery(/^verifier_detail:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    const [bot_row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    if (!bot_row) {
      await ctx.reply("Bot topilmadi.", { reply_markup: menuButton() });
      return;
    }

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

  // ── verifier_default ──────────────────────────────────────────────────────
  bot.callbackQuery(/^verifier_default:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    await db.update(verifierBots).set({ isDefault: false });
    await db.update(verifierBots).set({ isDefault: true, isActive: true }).where(eq(verifierBots.id, id));
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await ctx.reply(
      `${E.STAR} <b>@${row?.username ?? id}</b> default verifier bot qilib belgilandi!`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary() },
    );
  });

  // ── verifier_disable ──────────────────────────────────────────────────────
  bot.callbackQuery(/^verifier_disable:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    await db.update(verifierBots).set({ isActive: false, isDefault: false }).where(eq(verifierBots.id, id));
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await ctx.reply(
      `${E.BAN} <b>@${row?.username ?? id}</b> o'chirildi.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary() },
    );
  });

  // ── verifier_enable ───────────────────────────────────────────────────────
  bot.callbackQuery(/^verifier_enable:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    await db.update(verifierBots).set({ isActive: true }).where(eq(verifierBots.id, id));
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await ctx.reply(
      `${E.OK} <b>@${row?.username ?? id}</b> yoqildi.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary() },
    );
  });

  // ── verifier_remove ───────────────────────────────────────────────────────
  bot.callbackQuery(/^verifier_remove:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    const [row] = await db.select().from(verifierBots).where(eq(verifierBots.id, id)).limit(1);
    await db.delete(verifierBots).where(eq(verifierBots.id, id));
    await ctx.reply(
      `${E.TRASH} <b>@${row?.username ?? id}</b> o'chirildi.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary() },
    );
  });

  // ── verifier_add — prompt for username ───────────────────────────────────
  bot.callbackQuery("verifier_add", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    awaitingVerifierInput.add(ctx.from.id);
    await ctx.reply(
      `${E.ADD} <b>Verifier bot qo'shish</b>\n\nBot username kiriting (@ bilan yoki usiz):\n\nMisol: <code>RePreAmooBot</code>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Bekor", "menu_verifiers").icon(EID.NO).danger() },
    );
  });

  // ── Text handler for verifier username input ──────────────────────────────
  // Must be registered as a text handler; bot.ts places it AFTER the OTP handler.
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from) return next();

    if (awaitingVerifierInput.has(ctx.from.id)) {
      awaitingVerifierInput.delete(ctx.from.id);
      const username = ctx.message.text.replace(/^@/, "").trim();
      if (!username || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
        await ctx.reply(
          `${E.NO} Noto'g'ri username. Qaytadan urinib ko'ring.`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary() },
        );
        return;
      }
      const existing = await db.select().from(verifierBots);
      const makeDefault = existing.length === 0;
      await db.insert(verifierBots).values({ username, isActive: true, isDefault: makeDefault })
        .onConflictDoUpdate({ target: verifierBots.username, set: { isActive: true } });
      await ctx.reply(
        `${E.OK} <b>@${username}</b> verifier bot sifatida qo'shildi!` +
          (makeDefault ? `\n${E.STAR} Birinchi bot — default qilib belgilandi.` : ""),
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Verifier botlar", "menu_verifiers").icon(EID.ROBOT).primary() },
      );
      return;
    }

    return next();
  });
}
