const fs = require('fs');
const botFile = 'artifacts/api-server/src/bot/bot.ts';
let botCode = fs.readFileSync(botFile, 'utf8');

// fix userId redeclaration in text handler
if (botCode.includes('bot.on("message:text", async (ctx, next) => {')) {
  botCode = botCode.replace(
`  bot.on("message:text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();

    if (pendingNameEdits.has(userId)) {
      const resolve = pendingNameEdits.get(userId);
      pendingNameEdits.delete(userId);
      if (resolve && text.length > 0) {
        await resolve(text);
        return; // Consumed
      }
    }
`,
`  bot.on("message:text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text?.trim() || "";

    if (pendingNameEdits.has(userId)) {
      const resolve = pendingNameEdits.get(userId);
      pendingNameEdits.delete(userId);
      if (resolve && text.length > 0) {
        await resolve(text);
        return; // Consumed
      }
    }
`
  );

  // also fix second redeclaration
  botCode = botCode.replace(
      `    const userId = ctx.from.id;\n    const pending = activeOtpFlow.get(userId);`,
      `    const pending = activeOtpFlow.get(userId);`
  );
}

fs.writeFileSync(botFile, botCode);

const cardsFile = 'artifacts/api-server/src/bot/handlers/cards.ts';
let cardsCode = fs.readFileSync(cardsFile, 'utf8');

if (cardsCode.includes('bot.callbackQuery(/^card_edit_name:')) {
    cardsCode = cardsCode.replace(
        'bot.callbackQuery(/^card_edit_name:(\\d+)$/, async (ctx) => {',
        'export function registerCardEditNameHandler(bot: Bot) { bot.callbackQuery(/^card_edit_name:(\\d+)$/, async (ctx: any) => {'
    );
    cardsCode += '\n}\n';

    // Oh actually card_edit_name handler was injected into the wrong scope, let's just properly fix it

}
