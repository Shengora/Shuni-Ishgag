---
name: Bot handler architecture
description: How the api-server bot module is organised after the monolith-to-modules refactor
---

# Bot handler architecture

The original 3940-line `bot.ts` was split into focused handler modules under `artifacts/api-server/src/bot/handlers/`.

## Module layout

| File | Exports | Covers |
|------|---------|--------|
| `handlers/shared.ts` | All shared Maps/Sets, keyboard builders, helpers | State, TTL cleanup job, `sendMainMenu`, `buildOperatorStatusText` |
| `handlers/login.ts` | `registerLoginHandlers(bot)` | `/login`, `/code`, `/resendcode`, `/2fa`, `menu_login`, master-share callbacks |
| `handlers/cards.ts` | `registerCardsHandlers(bot)` | `/addcard`, `/cards`, card detail/default/delete callbacks |
| `handlers/sessions.ts` | `registerSessionHandlers(bot)` | `/getnumber`, `/list`, `/pass`, `/manualcode`, cancel/freeze/getcode/getnew callbacks |
| `handlers/batch.ts` | `registerBatchHandlers(bot)` | `menu_getnumber`, `src_pick:`, `batch_count:N` |
| `handlers/premium.ts` | `registerPremiumHandlers(bot)` | `/getpremium`, `menu_getpremium`, `batch_premium_*`, `step6_*`, `card_retry_*` |
| `handlers/verifiers.ts` | `registerVerifierHandlers(bot)` | `menu_verifiers`, `verifier_*`, verifier text input |
| `bot.ts` (new, slim) | `createBot()` | Wires all handlers, OTP intercept middleware, /start /menu /status |

## Key design decisions

**Why:** Each handler imports shared state directly from `shared.ts` as module-level singletons — not a passed context object. Simpler and avoids re-initialisation bugs.

**OTP intercept placement:** Registered as a `bot.on("message:text")` listener *before* all other text handlers. It uses `activeOtpFlow` Map (operator → activeFlowId[]) to know which operators are waiting and consumes 4-8 digit numeric messages silently.

**step6 / card_retry callbacks:** Registered in `premium.ts` at the top of `registerPremiumHandlers()` — before the operator-only middleware — so 3DS button presses from any user context still work.

**TTL cleanup:** `startCallbackMapCleanup()` runs a `setInterval` every 5 min evicting `pendingOtpCallbacks`/`pendingStep6Callbacks`/`pendingCardRetryCallbacks` entries older than 15 min, using parallel timestamp Maps (`otpTsMap`, `s6TsMap`, `crTsMap`) in `shared.ts`.

## Bugs fixed

1. `sendMainMenu` used `isSuperAdmin()` (env-only) → now `await isAnySuperAdmin()` so DB super admins see Login button.
2. No TTL safety net on pending callback Maps → added 15-min eviction loop.
3. `/getnumber` and `getnew:` had duplicated flow logic → deduplicated via `doGetNumber()` helper in sessions.ts.
4. `/addcard` format: `BANK_NOMI CARD_NUMBER MM/YY CVV` — stores `cardHolder = bankName` and generates `cardNumberMasked = ****${last4}`.

**How to apply:** When touching any premium flow, all pendingXxxCallbacks.set() calls must also call the matching trackXxxTs() and all .delete() calls must call clearXxxTs().
