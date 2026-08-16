const fs = require('fs');

const content = fs.readFileSync('artifacts/api-server/src/bot/premium.ts', 'utf8');

// The basic idea is to replace the start of the `try { ... pw = await import("playwright"); const proxyConfig = ... }`
// with a while/for loop. Since the try/catch extends a long way, we'll use a string replacement that specifically targets the parts we need.

// Part 1: Introduce the loop and proxy fetching logic inside the try block.
let newContent = content.replace(
  `  try {
    const pw = await import("playwright");

    // ── Proxy (DB pool → env → Webshare API) ──────────────────────────────────
    const proxyConfig = await getProxyConfig();
    // Track for usage increment on success. Cleared if we fall back to a direct
    // connection, so a proxy that didn't actually work isn't credited a success
    // (which would otherwise reset its failure counter).
    let proxyIpId = proxyConfig?.ipId;
    // Unlike proxyIpId above, this never gets cleared on fallback — it's only
    // used to release the in-flight reservation taken out in getProxyConfig(),
    // which must happen regardless of how this attempt turns out.
    reservedProxyIpId = proxyConfig?.ipId;

    // ── Inner helper: launch browser + create page + wire interceptors ─────────
    // Extracted so we can relaunch without proxy when the proxy blocks the site.
    const launchPage = async (useProxy: boolean): Promise<void> => {`,
  `  try {
    const pw = await import("playwright");

    const MAX_RETRIES = 3;
    let attempt = 1;
    let proxyConfig: any;
    let proxyIpId: number | undefined;

    while (attempt <= MAX_RETRIES) {
      // ── Proxy (DB pool → env → Webshare API) ──────────────────────────────────
      proxyConfig = await getProxyConfig();
      proxyIpId = proxyConfig?.ipId;
      reservedProxyIpId = proxyConfig?.ipId;

      // ── Inner helper: launch browser + create page + wire interceptors ─────────
      // Always uses the provided proxy.
      const launchPage = async (): Promise<void> => {
        const cfg = proxyConfig;`
);

// Part 2: Adjust `launchPage` internal proxy usages.
// Since we removed `useProxy: boolean` argument and replaced `const cfg = useProxy ? proxyConfig : undefined;` with `const cfg = proxyConfig;` above.

// Part 3: Fix `launchPage(!!proxyConfig);`
newContent = newContent.replace(
  /try \{\s+await launchPage\(!!proxyConfig\);\s+\} catch \(launchErr: any\) \{([\s\S]*?)const safeUrl =/m,
  `try {
        await launchPage();
      } catch (launchErr: any) {
        if (proxyConfig) {
          logger.warn(
            { proxyServer: proxyConfig.server, err: (launchErr?.message ?? "").slice(0, 200) },
            "Browser launch failed with proxy — retrying with a new proxy"
          );
          if (proxyIpId) await recordProxyIpFailure(proxyIpId).catch(() => {});
          releaseProxyIpReservation(reservedProxyIpId);
          try { await browser?.close(); } catch (_) {}
          browser = null; page = null;

          if (attempt < MAX_RETRIES) {
            attempt++;
            continue;
          }
        }
        throw launchErr;
      }

      const safeUrl =`
);

// Part 4: Fix the page.goto try/catch fallback.
newContent = newContent.replace(
  /try \{\s+await page.goto\(formUrl, \{ timeout: PLAYWRIGHT_GOTO_TIMEOUT, waitUntil: "domcontentloaded" \}\);\s+\} catch \(gotoErr: any\) \{([\s\S]*?)throw gotoErr;\s+\}\s+\}/m,
  `try {
        await page.goto(formUrl, { timeout: PLAYWRIGHT_GOTO_TIMEOUT, waitUntil: "domcontentloaded" });
      } catch (gotoErr: any) {
        const msg: string = gotoErr?.message ?? "";
        const isNetErr = /ERR_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_TUNNEL_CONNECTION_FAILED|net::ERR|Timeout \\d+ms exceeded/i.test(msg);
        if (isNetErr && proxyConfig) {
          logger.warn(
            { proxyServer: proxyConfig.server, err: msg.slice(0, 120) },
            "Proxy network error on goto — retrying with a new proxy",
          );
          if (proxyIpId) await recordProxyIpFailure(proxyIpId).catch(() => {});
          releaseProxyIpReservation(reservedProxyIpId);
          try { await browser?.close(); } catch (_) {}
          browser = null; page = null;

          if (attempt < MAX_RETRIES) {
            attempt++;
            continue;
          }
        }
        throw gotoErr;
      }`
);

// Part 5: Close the while loop at the end of the step 5 execution block.
// Wait, the while loop needs to cover the entire process so if it succeeds, it returns.
// At the end of the `try {` block, before the `catch` that handles the whole thing, we need to return the credentials?
// Actually, in `payPremiumViaWebApp`, if it completes successfully, it reaches `return { success: true, credentials: ... };`.
// If it completes successfully it just returns, so breaking out of the loop is natural.
// Let's find where the loop should end.
// The end of `payPremiumViaWebApp` has:
// return { success: true, credentialToken: JSON.parse(capturedCredentials).token, proxyIpId };
// So we just need to add `}` before `} catch (err: any) {` of the outer try block.

newContent = newContent.replace(
  /return \{ success: true, credentialToken: JSON.parse\(capturedCredentials\)\.token, proxyIpId \};\s+\} catch \(err: any\) \{/m,
  `return { success: true, credentialToken: JSON.parse(capturedCredentials).token, proxyIpId };\n    }\n  } catch (err: any) {`
);

fs.writeFileSync('artifacts/api-server/src/bot/premium.ts', newContent);
