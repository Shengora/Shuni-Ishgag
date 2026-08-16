/**
 * Proxy-penalty regression tests for the premium payment flow.
 *
 * Two invariants are guarded here:
 *  1. A PAYMENT_FAILED result from sendPaymentFormToTelegram (bank decline at
 *     step 5) must NOT call cooldownProxyIp or recordProxyIpFailure — the proxy
 *     delivered the request successfully and must not be penalised.
 *  2. A cardBlocked result from payPremiumViaWebApp (anti-fraud error shown on
 *     the tokenization page at step 4) MUST call both functions, because the
 *     proxy's fingerprint likely triggered the payment provider's bot detection.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ─── Hoisted mock helpers (must be defined before vi.mock() calls) ────────────

const { dbMock, returningMock, dbLimitFn, pwLaunch } = vi.hoisted(() => {
  const returningMock = vi.fn().mockResolvedValue([]);
  const dbLimitFn = vi.fn();

  // Drizzle-like select chain: all builder methods return `this`, terminal is
  // `limit()` which returns a Promise (controlled per-test by dbLimitFn).
  const selectChain: any = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: dbLimitFn };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);
  selectChain.orderBy.mockReturnValue(selectChain);

  // Drizzle-like update chain: builder methods return `this`.  Must also be
  // thenable so the fire-and-forget `.catch(() => ...)` pattern used in
  // getProxyConfig's `lastUsedAt` touch doesn't blow up.
  const updateChain: any = { set: vi.fn(), where: vi.fn(), returning: returningMock };
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockReturnValue(updateChain);
  Object.assign(updateChain, {
    then: (res: any, rej: any) => Promise.resolve(undefined).then(res, rej),
    catch: (fn: any) => Promise.resolve(undefined).catch(fn),
  });

  const dbMock = {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue(updateChain),
  };

  const pwLaunch = vi.fn();
  return { dbMock, returningMock, dbLimitFn, pwLaunch };
});

// ─── Module mocks (hoisted by vitest before imports) ─────────────────────────

vi.mock('@workspace/db', () => ({
  db: dbMock,
  proxyIps: {},
  proxySettings: {},
}));

// Intercepts both static and dynamic `import('playwright')` calls.
vi.mock('playwright', () => ({
  chromium: { launch: pwLaunch },
}));

vi.mock('./client.js', () => ({
  tokenizeCardWithStripe: vi.fn(),
}));

// ─── Import module under test ─────────────────────────────────────────────────

import {
  runFullPremiumFlow,
  clearAllProxyCooldowns,
  getProxyRuntimeStatus,
} from './premium.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

/** Proxy IP row returned by the mock DB for getProxyConfig(). */
const PROXY_ROW = {
  id: 99,
  server: 'proxy.test:3128',
  username: 'u',
  password: 'p',
  isActive: true,
  usedCount: 0,
  lastUsedAt: null,
  failCount: 0,
  lastFailedAt: null,
};

/** Minimal invoice message: a MessageMediaInvoice with no terms buttons. */
const FAKE_INVOICE = {
  id: 1001,
  media: { className: 'MessageMediaInvoice', title: 'Telegram Premium' },
  replyMarkup: null,
};

const CARD = {
  cardNumber: '4111111111111111',
  expiry: '12/26',
  cvv: '123',
  cardHolder: 'Test User',
};

// ─── Mock factories ───────────────────────────────────────────────────────────

/**
 * Build a mock Playwright page.
 *
 * `mode: 'success'` — the payment form fills and submits; credentials are
 *   captured after one poll iteration.
 * `mode: 'cardBlocked'` — all card selectors return invisible so no fields are
 *   filled; after 30 fruitless credential-poll iterations the final
 *   checkForErrorText() call returns a decline message, triggering the
 *   cardBlocked=true path.
 */
function makeMockPage(mode: 'success' | 'cardBlocked') {
  let evaluateCallCount = 0;

  // Shared locator object — self-referential so .first()/.last() return it.
  const loc: any = {
    // isVisible always returns true: card fields and pay button are found in
    // both modes.  The distinction between 'success' and 'cardBlocked' is made
    // solely by what evaluate() returns (see below).  Keeping isVisible=true
    // ensures the flow reaches the *post-submit* checkForErrorText() call at
    // line ~1722 (after credentials are polled), which is the only cardBlocked
    // path that includes proxyIpId in its return value.
    isVisible: vi.fn().mockResolvedValue(true),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    // count() === 0 → no Stripe iframes detected → falls through to direct selectors.
    count: vi.fn().mockResolvedValue(0),
  };
  loc.first = vi.fn().mockReturnValue(loc);
  loc.last = vi.fn().mockReturnValue(loc);
  loc.locator = vi.fn().mockReturnValue(loc);

  return {
    on: vi.fn(),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    // Rejecting waitForSelector simulates the card form never becoming
    // individually visible; the code falls back to a waitForTimeout(10 000)
    // which our mock resolves instantly.
    waitForSelector: vi.fn().mockRejectedValue(new Error('selector not found')),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    evaluate: vi.fn().mockImplementation(() => {
      evaluateCallCount++;
      if (mode === 'success') {
        // First evaluate call (credential poll iteration 1) returns the captured
        // credential → payPremiumViaWebApp returns { submitted: true, proxyIpId }.
        return Promise.resolve('{"type":"card","token":"test_sg_token"}');
      }
      // cardBlocked mode: up to 30 credential-poll evaluates return null
      // (no credentials captured), then the 31st call is checkForErrorText()
      // which returns a decline message so the function returns
      // { submitted: false, cardBlocked: true, proxyIpId }.
      if (evaluateCallCount <= 30) return Promise.resolve(null);
      return Promise.resolve('card was declined');
    }),
    locator: vi.fn().mockReturnValue(loc),
    frameLocator: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue(loc),
      locator: vi.fn().mockReturnValue(loc),
    }),
    process: vi.fn().mockReturnValue(null),
  };
}

function makeMockBrowser(page: ReturnType<typeof makeMockPage>) {
  return {
    newContext: vi.fn().mockResolvedValue({ newPage: vi.fn().mockResolvedValue(page) }),
    close: vi.fn().mockResolvedValue(undefined),
    process: vi.fn().mockReturnValue(null),
  };
}

/**
 * Minimal TelegramClient mock.
 *
 * addEventHandler() fires the registered handler immediately (via setTimeout 0)
 * with FAKE_INVOICE so waitForBotMsg() resolves without waiting 30 s.
 *
 * `invokeFn` controls what client.invoke() returns / throws, allowing each test
 * to simulate GetPaymentForm and SendPaymentForm responses independently.
 */
function makeClient(invokeFn: (req: any) => Promise<any>) {
  return {
    addEventHandler: vi.fn().mockImplementation((handler: any) => {
      // Fire asynchronously so waitForBotMsg's Promise is registered first.
      setTimeout(() => handler({ message: FAKE_INVOICE }), 0);
    }),
    removeEventHandler: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getInputEntity: vi.fn().mockResolvedValue({ className: 'InputPeerUser', userId: BigInt(1) }),
    invoke: vi.fn().mockImplementation(invokeFn),
    connect: vi.fn().mockResolvedValue(undefined),
  };
}

/** Return the class name that gramjs stamps on TL request objects. */
function className(req: any): string {
  return (req?.className ?? req?.constructor?.name ?? '') as string;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('premium flow testing', () => {
  beforeEach(() => {
    // Clear any cooldowns left from a previous test.
    clearAllProxyCooldowns();

    // Reset mock call history.
    vi.clearAllMocks();

    // Re-arm DB limit mock: two getProxyConfig() calls in sequence —
    //   1. getProxyMaxUses()  → [{ maxUses: 8 }]
    //   2. proxy IP rows      → [PROXY_ROW]     (id = 99 picked by the flow)
    //   subsequent calls      → [] (e.g. anyActive exhaustion check)
    dbLimitFn.mockReset();
    dbLimitFn
      .mockResolvedValueOnce([{ maxUses: 8 }])
      .mockResolvedValueOnce([PROXY_ROW])
      .mockResolvedValue([]);

    returningMock.mockResolvedValue([]);
  });

  // ── Test 1: Full Successful Premium Flow ─────────────────────────────────────

  it(
    'executes the full premium flow successfully',
    async () => {
      // Playwright succeeds: card fields visible, credentials captured.
      const page = makeMockPage('success');
      pwLaunch.mockResolvedValue(makeMockBrowser(page));

      // Mock Telegram Client that simulates successful flow
      const client = makeClient(async (req: any) => {
        const cn = className(req);
        if (cn.includes('GetPaymentForm')) {
          // No providerPublicKey → Smart Glocal / Playwright path (step 4).
          return { url: 'https://smartglocal.test/pay', formId: BigInt(42) };
        }
        if (cn.includes('SendPaymentForm')) {
          // Successful payment submission
          return { className: 'payments.PaymentResult', success: true };
        }
        if (cn.includes('GetBotCallbackAnswer')) {
          // Success on clicking buttons in step 2 or 6
          return { message: 'Success' };
        }
        if (cn.includes('GetMessages')) {
          return [{ id: 1 }];
        }
        return {};
      });

      // Override the sendMessage specifically for the Verifier Bot Step to send back "premium: ✅"
      client.sendMessage = vi.fn().mockImplementation(async (botUsername: string) => {
         if (botUsername === 'RePreAmooBot') {
             // We need to trigger the handler manually to simulate bot's reply
             // But in `checkPremiumWithRepream`, we add new event handlers
             // Since `makeClient` just uses a FAKE_INVOICE by default for event handlers,
             // let's override `addEventHandler` to return a positive response for RePreAmooBot
         }
      });

      client.addEventHandler = vi.fn().mockImplementation((handler: any, event: any) => {
          setTimeout(() => {
              if (event && event.fromUsers && event.fromUsers.includes('RePreAmooBot')) {
                  handler({ message: { text: "premium: ✅ 2026-10-10" } });
              } else {
                 const markupWithBtn = {
                    rows: [{ buttons: [{ text: "Yes", data: "yes" }] }]
                 };
                 handler({ message: { ...FAKE_INVOICE, replyMarkup: markupWithBtn } });
              }
          }, 0);
      });


      const onProgress = vi.fn().mockResolvedValue(undefined);
      const onStep6 = vi.fn().mockResolvedValue(undefined);

      const result = await runFullPremiumFlow(
        client as any,
        'PremiumBot',
        'RePreAmooBot',
        CARD,
        onProgress,
        undefined, // onAskOtp
        undefined, // onVerificationNeeded
        undefined, // repreamMsgId
        onStep6,
        client as any, // masterClient for verifier bot
      );

      expect(result.success).toBe(true);
      expect(result.hasPremium).toBe(true);
      expect(result.autoRenewalCancelled).toBe(true);
      expect(onStep6).toHaveBeenCalled();

      // Ensure the proxy usages were incremented successfully (Step 5 completed successfully)
      // Since it's a drizzle update chain, check if update was called on proxyIps
      expect(dbMock.update).toHaveBeenCalled();
    },
    20_000,
  );

  // ── Test 2: Proxy Penalty Regression (PAYMENT_FAILED) ──────────────────────────

  it(
    'PAYMENT_FAILED at step 5 does NOT penalise proxy IP 99',
    async () => {
      // Playwright succeeds: card fields visible, credentials captured immediately.
      const page = makeMockPage('success');
      pwLaunch.mockResolvedValue(makeMockBrowser(page));

      const client = makeClient(async (req: any) => {
        const cn = className(req);
        if (cn.includes('GetPaymentForm')) {
          // No providerPublicKey → Smart Glocal / Playwright path (step 4).
          return { url: 'https://smartglocal.test/pay', formId: BigInt(42) };
        }
        if (cn.includes('SendPaymentForm')) {
          // Simulate bank decline at step 5.
          const err = Object.assign(new Error('PAYMENT_FAILED'), {
            errorMessage: 'PAYMENT_FAILED',
          });
          throw err;
        }
        return {};
      });

      const result = await runFullPremiumFlow(
        client as any,
        'PremiumBot',
        'RePreAmooBot',
        CARD,
      );

      // The flow must surface a payment decline, not a generic error.
      expect(result.success).toBe(false);
      expect(result.paymentDeclined).toBe(true);

      // Proxy IP 99 was used for the Playwright step (proxyIpId = 99 in the
      // returned PlaywrightCardResult). The PAYMENT_FAILED branch must not put
      // it on cooldown.
      expect(getProxyRuntimeStatus().cooldowns.has(99)).toBe(false);

      // recordProxyIpFailure calls db.update().set().where().returning().
      // If .returning() was never called, the proxy failure counter was not
      // incremented.
      expect(returningMock).not.toHaveBeenCalled();
    },
    15_000,
  );

  // ── Test 3: Proxy Network Failure & Fallback ──────────────────────────────────

  it(
    'retries with a new proxy when chromium launch fails due to proxy error',
    async () => {
      // First call to getProxyConfig returns ID 99
      // Second call returns ID 100
      const PROXY_ROW_2 = { ...PROXY_ROW, id: 100, server: 'proxy.test:8080' };

      dbLimitFn.mockReset();
      dbLimitFn
        .mockResolvedValueOnce([{ maxUses: 8 }])
        .mockResolvedValueOnce([PROXY_ROW])       // First attempt gets ID 99
        .mockResolvedValueOnce([{ maxUses: 8 }])
        .mockResolvedValueOnce([PROXY_ROW_2])     // Second attempt gets ID 100
        .mockResolvedValue([]);

      // Playwright fails on the first launch attempt (e.g. proxy unreachable)
      // Playwright succeeds on the second attempt
      const page = makeMockPage('success');
      pwLaunch
        .mockRejectedValueOnce(new Error('ERR_PROXY_CONNECTION_FAILED'))
        .mockResolvedValueOnce(makeMockBrowser(page));

      // Mock Telegram Client
      const client = makeClient(async (req: any) => {
        const cn = className(req);
        if (cn.includes('GetPaymentForm')) {
          return { url: 'https://smartglocal.test/pay', formId: BigInt(42) };
        }
        if (cn.includes('SendPaymentForm')) {
          return { className: 'payments.PaymentResult', success: true };
        }
        if (cn.includes('GetBotCallbackAnswer')) {
          return { message: 'Success' };
        }
        if (cn.includes('GetMessages')) {
          return [{ id: 1 }];
        }
        return {};
      });

      const result = await runFullPremiumFlow(
        client as any,
        'PremiumBot',
        'RePreAmooBot',
        CARD,
      );

      expect(result.success).toBe(true);

      // The proxy network failure MUST have recorded a failure against IP 99
      // The exact argument passed to where/eq should correspond to ID 99
      expect(returningMock).toHaveBeenCalled();

      // And because it fell back successfully to ID 100, IP 99 should NOT be on cooldown
      // (cooldowns are only for card-blocked anti-fraud errors)
      expect(getProxyRuntimeStatus().cooldowns.has(99)).toBe(false);
    },
    20_000,
  );

  // ── Test 4: Proxy Penalty Regression (cardBlocked) ─────────────────────────────

  it(
    'cardBlocked at tokenization page DOES penalise proxy IP 99',
    async () => {
      // Playwright page eventually shows a decline message → cardBlocked=true.
      const page = makeMockPage('cardBlocked');
      pwLaunch.mockResolvedValue(makeMockBrowser(page));

      const client = makeClient(async (req: any) => {
        const cn = className(req);
        if (cn.includes('GetPaymentForm')) {
          // No providerPublicKey → Smart Glocal / Playwright path.
          return { url: 'https://smartglocal.test/pay', formId: BigInt(42) };
        }
        // SendPaymentForm is never reached — flow returns at step 4.
        return {};
      });

      const result = await runFullPremiumFlow(
        client as any,
        'PremiumBot',
        'RePreAmooBot',
        CARD,
      );

      // cardBlocked is surfaced as a paymentDeclined to trigger card-retry UI.
      expect(result.success).toBe(false);
      expect(result.paymentDeclined).toBe(true);

      // Proxy IP 99 MUST be on cooldown — the tokenization page showed an
      // anti-fraud error, implicating the proxy's fingerprint.
      expect(getProxyRuntimeStatus().cooldowns.has(99)).toBe(true);

      // recordProxyIpFailure MUST have been called: it increments the proxy's
      // failure counter and auto-retires it after PROXY_MAX_FAILURES strikes.
      expect(returningMock).toHaveBeenCalled();
    },
    15_000,
  );
});
