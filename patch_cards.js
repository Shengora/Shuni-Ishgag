const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/handlers/cards.ts';
let code = fs.readFileSync(filepath, 'utf8');

if (!code.includes('card_edit_name:')) {
  // Add edit name button
  code = code.replace(
    /kb\.text\("O'chirish", `card_delete:\$\{card\.id\}`\)\.icon\(EID\.TRASH\)\.danger\(\)/,
    'kb.text("Ism-sharifni o\'zgartirish", `card_edit_name:${card.id}`).icon(EID.ADD).primary().row()\n      .text("O\'chirish", `card_delete:${card.id}`).icon(EID.TRASH).danger()'
  );

  // Add pendingNameEdits to imports
  if (code.includes('import { isOperator,')) {
    code = code.replace(
      'import { isOperator, menuButton } from "./shared.js";',
      'import { isOperator, menuButton, pendingNameEdits } from "./shared.js";'
    );
  } else if (!code.includes('pendingNameEdits')) {
    code = code.replace(
        'import { isOperator,',
        'import { isOperator, pendingNameEdits,'
    );
  }

  // Add the handler for card_edit_name
  code += `
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

  fs.writeFileSync(filepath, code);
}
