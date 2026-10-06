const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/handlers/premium.ts';
let code = fs.readFileSync(filepath, 'utf8');

// The error is TS2304: Cannot find name 'threeDsMode' on line 841 (inside startBatchPremiumExecution).
// We need to query threeDsMode inside startBatchPremiumExecution.

const signature = `async function startBatchPremiumExecution(ctx: any, operatorId: number, state: { totalRequested: number, selections: {cardId: number, uses: number}[] }) {`;
const insertQuery = `\n    const [adminRow] = await db.select({ threeDsMode: admins.threeDsMode }).from(admins).where(eq(admins.telegramUserId, operatorId)).limit(1);\n    const threeDsMode = adminRow?.threeDsMode || "auto";`;

if (code.includes(signature)) {
   code = code.replace(signature, signature + insertQuery);
   fs.writeFileSync(filepath, code);
}
