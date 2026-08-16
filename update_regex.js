const fs = require('fs');
const content = fs.readFileSync('artifacts/api-server/src/bot/premium.ts', 'utf8');
const updatedContent = content.replace(
  /const isNetErr = \/ERR_TIMED_OUT\|ERR_CONNECTION_REFUSED\|ERR_PROXY_CONNECTION_FAILED\|ERR_EMPTY_RESPONSE\|ERR_TUNNEL_CONNECTION_FAILED\|net::ERR\/i\.test\(msg\);/,
  'const isNetErr = /ERR_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_TUNNEL_CONNECTION_FAILED|net::ERR|Timeout \\d+ms exceeded/i.test(msg);'
);
fs.writeFileSync('artifacts/api-server/src/bot/premium.ts', updatedContent);
