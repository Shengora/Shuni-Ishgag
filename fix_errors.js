const fs = require('fs');
let content = fs.readFileSync('artifacts/api-server/src/bot/premium.ts', 'utf8');

// fix useProxy usage
content = content.replace(
  /logger\.error\(\{ err: msg\.slice\(0, 300\), useProxy \}, "Browser launch failed or timed out"\);/,
  `logger.error({ err: msg.slice(0, 300) }, "Browser launch failed or timed out");`
);

// fix the "Function lacks ending return statement".
// Let's add a throw at the end of the while loop just in case it exits without throwing
// Wait, the while loop contains:
// if (attempt < MAX_RETRIES) { attempt++; continue; }
// throw gotoErr;
// But the end of the while loop isn't a return. We should `throw new Error("Max retries exceeded")` after the while loop.
// Let's check what's right after `    }` (end of while loop).

content = content.replace(
  /    return \{ submitted: true, proxyIpId \};\n    \}\n  \} catch \(err: any\) \{/,
  `    return { submitted: true, proxyIpId };\n    }\n    throw new Error("Max retries exceeded");\n  } catch (err: any) {`
);

fs.writeFileSync('artifacts/api-server/src/bot/premium.ts', content);
