const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/handlers/shared.ts';
let code = fs.readFileSync(filepath, 'utf8');

if (!code.includes('export const pendingNameEdits')) {
  code = code.replace(
    /export const pendingCardRetryCallbacks = new Map<string, \(choice: number \| "cancel"\) => void>\(\);/,
    'export const pendingCardRetryCallbacks = new Map<string, (choice: number | "cancel") => void>();\nexport const pendingNameEdits = new Map<number, (name: string) => void>();'
  );
  fs.writeFileSync(filepath, code);
}
