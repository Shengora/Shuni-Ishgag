Wait, if `page.waitForSelector` times out, it throws. Previously we had `await page.waitForTimeout(10000)` fallback which doesn't throw. But when `humanFill` executes `locator.click({ timeout: 5000 })`, if the element isn't clickable within 5 seconds, it throws.
In the previous code without the timeout, `locator.click()` would wait forever until the 120s watchdog killed the process.
Now it throws after 5 seconds, gets caught by the `try-catch` wrapper inside the for-loop, and silently ignores that field (`catch (_) {}`).
This means if ALL fields fail to be filled within their 5s timeout (maybe because the page is still loading slowly behind the proxy), `filled` remains `false`.
Then it falls back to the attribute-pattern scan: `const allInputs = await page.locator('input[...]').all()`.
If no inputs are found, it checks for error text. If no error text, it logs "Could not identify all card fields" or "No card inputs found" and returns `{ submitted: false }`.
This explains the message: `Karta formasi to'ldirishda xato — /tmp/premium-fail-*.png ga screenshot saqlandi`.
The timeout of 5s on `click` might be too aggressive if the DOM is slow to become interactive. Playwright's default is 30s.

Actually, the previous code had NO explicit timeout on `click()` or `pressSequentially()`, meaning they used the default 30s.
If the 30s timeout triggered, it would throw. If it didn't throw in 30s, it would eventually hit the 120s watchdog.
By setting it to 5s, I made it fail much faster.
Is failing faster the right move? Yes, failing fast is better than hanging for 2 minutes and blocking everyone else. But maybe 10 seconds is more reasonable for slow proxies?
Or maybe `humanFill` should just use the default 30s, and the watchdog is sufficient now that `serializeLaunch` doesn't block the queue anymore?
Wait! The original issue was "Qotib qoldi yana" (it froze again).
If `serializeLaunch` deadlock is fixed, the watchdog will gracefully kill it after 120s, and the *queue* will unblock. This alone solves the systemic hang.
But a 120s wait for a single failed attempt is still annoying for the user. A 15-30s timeout for interactions is better. Let's change `timeout: 5000` to `timeout: 15000` just to be safe with slow proxy loading, so it doesn't fail prematurely.

I'll bump the action timeouts to 15000.
