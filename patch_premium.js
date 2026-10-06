const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/handlers/premium.ts';
let code = fs.readFileSync(filepath, 'utf8');

// Insert admins import
if (!code.includes('admins')) {
  code = code.replace(
    /import { userbotSessions, savedCards, cardUsages, pendingNumbers } from "@workspace\/db";/,
    'import { userbotSessions, savedCards, cardUsages, pendingNumbers, admins } from "@workspace/db";'
  );
}

// Find first occurrence of runFullPremiumFlow and modify onVerificationNeeded
const runBlock1 = code.indexOf('const result = await withTimeout(runFullPremiumFlow(');
if (runBlock1 !== -1) {
  const insertIndex = code.lastIndexOf('const operatorId = ctx.from!.id;', runBlock1);
  if (insertIndex !== -1 && !code.slice(insertIndex, runBlock1).includes('threeDsMode')) {
    code = code.substring(0, insertIndex + 'const operatorId = ctx.from!.id;'.length) +
           '\n    const [adminRow] = await db.select({ threeDsMode: admins.threeDsMode }).from(admins).where(eq(admins.telegramUserId, operatorId)).limit(1);\n    const threeDsMode = adminRow?.threeDsMode || "auto";' +
           code.substring(insertIndex + 'const operatorId = ctx.from!.id;'.length);
  }
}

// Find second occurrence (batch)
const runBlock2 = code.indexOf('const result = await withTimeout(runFullPremiumFlow(', runBlock1 + 100);
if (runBlock2 !== -1) {
  const insertIndex = code.lastIndexOf('const operatorId = ctx.from.id;', runBlock2);
  if (insertIndex !== -1 && !code.slice(insertIndex, runBlock2).includes('threeDsMode')) {
    code = code.substring(0, insertIndex + 'const operatorId = ctx.from.id;'.length) +
           '\n    const [adminRow] = await db.select({ threeDsMode: admins.threeDsMode }).from(admins).where(eq(admins.telegramUserId, operatorId)).limit(1);\n    const threeDsMode = adminRow?.threeDsMode || "auto";' +
           code.substring(insertIndex + 'const operatorId = ctx.from.id;'.length);
  }
}

fs.writeFileSync(filepath, code);
