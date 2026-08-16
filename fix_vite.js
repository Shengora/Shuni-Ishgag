const fs = require('fs');
let content = fs.readFileSync('artifacts/mockup-sandbox/vite.config.ts', 'utf8');

// Provide fallbacks to avoid throw new Error during vite config load
content = content.replace(
  /const rawPort = process.env.PORT;[\s\S]*?const basePath = process.env.BASE_PATH;[\s\S]*?\}\n/m,
  `const rawPort = process.env.PORT || "3000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(\`Invalid PORT value: "\${rawPort}"\`);
}

const basePath = process.env.BASE_PATH || "/";

`
);

fs.writeFileSync('artifacts/mockup-sandbox/vite.config.ts', content);
