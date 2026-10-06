const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/handlers/premium.ts';
let code = fs.readFileSync(filepath, 'utf8');

// Also need add trackOtpTs, clearOtpTs
if (!code.includes('trackOtpTs')) {
    code = code.replace(
        /import \{([\s\S]*?)pendingOtpCallbacks,([\s\S]*?)\} from "\.\/shared\.js";/,
        'import {$1pendingOtpCallbacks,\n  trackOtpTs,\n  clearOtpTs,\n  addActiveOtpFlow,\n  removeActiveOtpFlow,$2} from "./shared.js";'
    );
}

fs.writeFileSync(filepath, code);
