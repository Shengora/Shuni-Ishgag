const fs = require('fs');
const cardsFile = 'artifacts/api-server/src/bot/handlers/cards.ts';
let cardsCode = fs.readFileSync(cardsFile, 'utf8');

cardsCode = cardsCode.replace('export function registerCardEditNameHandler(bot: Bot) { bot.callbackQuery(/^card_edit_name:(\\d+)$/, async (ctx: any) => {', '  bot.callbackQuery(/^card_edit_name:(\\d+)$/, async (ctx) => {');
cardsCode = cardsCode.replace(/\n}\n$/, '');

// Wait, looking at the previous patch script, the bot.callbackQuery was just added at the very end of the file.
// We need to inject it INSIDE the export function registerCardsHandlers(bot: Bot) { ... }

// Find where to put it
const lastBlock = '  // ── card_delete_confirm ───────────────────────────────────────────────────';
const editHandler = `
  // ── card_edit_name ────────────────────────────────────────────────────────
  bot.callbackQuery(/^card_edit_name:(\\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from.id;
    if (!await isOperator(userId)) return;
    const cardId = parseInt(ctx.match[1]);

    const [card] = await db.select().from(savedCards)
      .where(and(eq(savedCards.id, cardId), eq(savedCards.userId, userId)))
      .limit(1);

    if (!card) {
      await ctx.reply(\`\${E.NO} Karta topilmadi.\`, { parse_mode: "HTML", reply_markup: menuButton() });
      return;
    }

    pendingNameEdits.set(userId, async (name: string) => {
      try {
        await db.update(savedCards).set({ cardHolder: name }).where(eq(savedCards.id, cardId));
        await ctx.reply(\`✅ ****\${card.cardNumber.slice(-4)} kartasining ismi "\${name}" ga o'zgartirildi.\`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Kartalar", "menu_cards").icon(EID.CARD).primary() });
      } catch (err) {
        logger.error({ err }, "card edit name error");
      }
    });

    const kb = new InlineKeyboard().text("Bekor qilish", \`card_detail:\${card.id}\`).icon(EID.NO).danger();
    await ctx.reply(\`Yangi ism-sharifni kiriting (****\${card.cardNumber.slice(-4)} uchun):\`, { reply_markup: kb });
  });
`;

let cleanCode = fs.readFileSync(cardsFile, 'utf8');

// strip out the bad injection
const regex = /bot\.callbackQuery\(\/\^card_edit_name:\\(\\d\+\)\$\/, async \(ctx\) => \{[\s\S]*\}\);/g;
cleanCode = cleanCode.replace(regex, '');
// strip out my recent export function registerCardEditNameHandler...
cleanCode = cleanCode.replace(/export function registerCardEditNameHandler[\s\S]*\}\);[\s\S]*\}\n/g, '');

const lastBracketIdx = cleanCode.lastIndexOf('}');
cleanCode = cleanCode.substring(0, lastBracketIdx) + editHandler + '\n}\n';

fs.writeFileSync(cardsFile, cleanCode);
