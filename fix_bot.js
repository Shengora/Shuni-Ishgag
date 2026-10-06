const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/bot.ts';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
`    const userId = ctx.from?.id;
    if (!userId) return next();`,
`    if (!userId) return next();`
);

fs.writeFileSync(filepath, code);
