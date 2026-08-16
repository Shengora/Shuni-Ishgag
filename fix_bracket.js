const fs = require('fs');
let content = fs.readFileSync('artifacts/api-server/src/bot/premium.ts', 'utf8');

// The while loop was not properly closed!
// The last thing in the try block before catch is:
//     // Ambiguous — allow SendPaymentForm attempt
//     logger.warn("Could not capture credentials — will try SendPaymentForm without explicit token");
//     return { submitted: true, proxyIpId };

content = content.replace(
  /    return \{ submitted: true, proxyIpId \};\n\n  \} catch \(err: any\) \{/,
  `    return { submitted: true, proxyIpId };\n    }\n  } catch (err: any) {`
);

fs.writeFileSync('artifacts/api-server/src/bot/premium.ts', content);
