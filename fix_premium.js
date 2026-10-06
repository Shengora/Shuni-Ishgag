const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/handlers/premium.ts';
let code = fs.readFileSync(filepath, 'utf8');

const targetStr = `const operatorId = ctx.from.id;`;

// Let's just find and replace the second batch_premium function
code = code.replace(
`  bot.callbackQuery(/^batch_premium_run(:.+)?$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;`,
`  bot.callbackQuery(/^batch_premium_run(:.+)?$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const operatorId = ctx.from.id;
    const [adminRow] = await db.select({ threeDsMode: admins.threeDsMode }).from(admins).where(eq(admins.telegramUserId, operatorId)).limit(1);
    const threeDsMode = adminRow?.threeDsMode || "auto";`
);

fs.writeFileSync(filepath, code);
