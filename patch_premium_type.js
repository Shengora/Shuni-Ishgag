const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/handlers/premium.ts';
let code = fs.readFileSync(filepath, 'utf8');

// There is a build error: TS2304: Cannot find name 'threeDsMode' on line 839.
// We need to define it where it's used inside the second runFullPremiumFlow block.

const runBlock2 = code.indexOf('const operatorId = ctx.from.id;', 400);
if (runBlock2 !== -1) {
    if (!code.slice(runBlock2, runBlock2 + 200).includes('threeDsMode')) {
        const insertPos = runBlock2 + 'const operatorId = ctx.from.id;'.length;
        code = code.substring(0, insertPos) +
           '\n    const [adminRow] = await db.select({ threeDsMode: admins.threeDsMode }).from(admins).where(eq(admins.telegramUserId, operatorId)).limit(1);\n    const threeDsMode = adminRow?.threeDsMode || "auto";' +
           code.substring(insertPos);
        fs.writeFileSync(filepath, code);
    }
}
