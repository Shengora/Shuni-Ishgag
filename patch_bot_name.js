const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/bot.ts';
let code = fs.readFileSync(filepath, 'utf8');

if (!code.includes('pendingNameEdits')) {
  // Add import
  code = code.replace(
    'pendingOtpCallbacks,',
    'pendingOtpCallbacks,\n  pendingNameEdits,'
  );

  const textHandlerBlock = `  bot.on("message:text", async (ctx, next) => {`;

  const textHandlerAdditions = `  bot.on("message:text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();

    if (pendingNameEdits.has(userId)) {
      const resolve = pendingNameEdits.get(userId);
      pendingNameEdits.delete(userId);
      if (resolve && text.length > 0) {
        await resolve(text);
        return; // Consumed
      }
    }`;

  code = code.replace(textHandlerBlock, textHandlerAdditions);

  // We should also replace 'const text = ctx.message.text.trim();' below this to prevent redeclaration if any, but since we re-declared it at the top, let's remove it later
  code = code.replace(
    /const text = ctx.message.text.trim\(\);\n    if \(!\/\^\\d\{4,8\}\$\/.test\(text\)\) return next\(\);/,
    'if (!/^\\d{4,8}$/.test(text)) return next();'
  );

  fs.writeFileSync(filepath, code);
}
