const fs = require('fs');
const content = fs.readFileSync('artifacts/api-server/src/bot/premium.ts', 'utf8');

// Fix `const cfg = useProxy ? proxyConfig : undefined;` which was left over.
const fixedContent = content.replace(
  /const launchPage = async \(\): Promise<void> => {\n        const cfg = proxyConfig;\n      const cfg = useProxy \? proxyConfig : undefined;/m,
  `const launchPage = async (): Promise<void> => {\n        const cfg = proxyConfig;`
);

fs.writeFileSync('artifacts/api-server/src/bot/premium.ts', fixedContent);
