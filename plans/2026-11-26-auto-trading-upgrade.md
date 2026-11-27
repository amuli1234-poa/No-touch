# Plan: Automatic Trading Upgrade — Single Best Signal + 24-Trade Daily Cap + Copy Trading

## Goal
Upgrade automatic trading so it:
1. **Only executes the single strongest scanner winner** (`scanSummary.winner`) per scan sweep — not all quality-passing signals.
2. **Caps at 24 trades per UTC day per account** (master + each follower copy account).
3. **Stops at the 24th trade for the day** — no queue. The 25th+ signal is ignored; trading resumes automatically at the next UTC midnight when the counter resets.
4. **Copy trading works within the cap** — follower copies count toward each follower's own 24/day.

## Current State (what already works)
- Auto path: `POST /api/execution/system-signal` → `AutoExecutionRunner.runForUser` → `gateway.submit` → `mirrorAutoTrade` → `copyEngine.mirrorMasterTrade` (copy fan-out already wired).
- Risk engine counts intents since UTC day start (`trades_per_session` rule) but defaults to 100,000 (unlimited).
- `App.tsx` publishes ALL quality-passing signals from `liveFeed` + every AI module (not just the winner).

---

## Task 1: Only publish the single scanner winner (frontend)

**File:** `src/App.tsx`

**Change:** Replace the two publisher `useEffect` blocks (lines ~878-964) with a single publisher that only sends `scanSummary.winner`.

- Remove the `liveFeed` loop (lines 881-899) that publishes every quality-passing item.
- Remove the AI module publisher loop (lines 933-964) that publishes every module's signal.
- Add a single publisher that:
  - Reads `scanSummary?.winner` (the single strongest signal from `selectStrongestSignal`).
  - If null, does nothing.
  - Checks `passesQualityFilter(winner.score, settings.minQuality)`.
  - Dedupes by a stable key `${winner.symbol}|${winner.timeframe}|${winner.direction}` (one per setup).
  - Calls `publishSystemSignal({ symbol, displayName, direction, timeframe, confidence: winner.score, entryPrice, stopLoss, takeProfit, setupKey, source: 'scanner', minQuality })`.

**Why:** The user wants only the single best signal the scanner renders on the dashboard (the "Best Signal" panel), not every AI module's signal.

---

## Task 2: 24-trade daily cap per account (backend)

**File:** `server/execution/autoRunner.ts`

**Change:** Add a daily trade counter check in `runForUser` before `submitSignal`.

- Add a constant `DAILY_TRADE_LIMIT = 24`.
- Add a helper `countTradesToday(store, userId, accountId, now)` that counts intents for the account with `createdAt >= utcDayStart(now)` (same UTC-day-start logic as the risk engine's `trades_per_session`).
- In `runForUser`, after the `autoStopped` check and before the `inFlight` check:
  - If `countTradesToday >= DAILY_TRADE_LIMIT`, return `{ outcome: 'skipped_daily_limit', reason: 'daily_limit_reached' }`. No signal is queued — the day's trading simply stops and resumes at the next UTC midnight.
- Add `'skipped_daily_limit'` to the `AutoRunOutcome` union.

**File:** `server/copyTrading/engine.ts`

**Change:** Add the same daily cap check per follower account in `mirrorMasterTrade`.

- Before adding a follower entry to the `entries` array, check `countTradesToday(store, principal.id, account.accountId, now) >= DAILY_TRADE_LIMIT`.
- If capped, skip that follower with reason `'daily_limit_reached'` (add to the `skipped` outcomes, audit it).
- Follower copies count toward the follower's own 24/day (each follower account has its own counter).
- The master's own trades are counted in `runForUser` (Task 2 above), so the master's 24/day is also enforced.

**Why:** Each account (master + each follower) gets its own 24 trades per UTC day. Manual and bot trades are NOT capped (they don't go through `runForUser` or the copy engine's cap check).

---

## Task 3: Stop at the cap, resume next UTC day (backend)

**File:** `server/execution/autoRunner.ts`

**Change:** No queue. When the daily cap is hit, automatic trading stops for the rest of the UTC day.

- `runForUser` returns `skipped_daily_limit` once `countTradesToday >= DAILY_TRADE_LIMIT`. No signal is stored.
- Because the counter is "intents since UTC midnight", it resets on its own at the next UTC day, so trading resumes automatically with no further work.
- The best signal (RISE/FALL) published to `/api/execution/system-signal` is what places the trade when shown; the cap only bounds how many per day.

**Why:** The customer asked for a hard stop at 24 — wait for the next day, then restart. Queuing the 25th signal would place a stale trade the customer never saw as the live best signal.

---

## Task 4: Scanner status endpoint update (backend)

**File:** `server/routes/execution.ts` — `GET /api/execution/scanner` (lines ~729-777)

**Change:** Add daily trade usage to the response.

- Import `DAILY_TRADE_LIMIT` from `autoRunner.ts`.
- Count the user's intents today (same `countTradesToday` logic).
- Add to the response:
  - `dailyTradesUsed: <count>`
  - `dailyTradeLimit: 24`
  - `dailyLimitReached: <count >= 24>`
- Update the `reason` field: if `dailyLimitReached` and no other reason, set `reason: 'daily_limit_reached'`.

**Why:** The Trade panel can show "24/24 trades used — resets at midnight UTC" and the reason is visible.

---

## Task 5: Update `POST /api/execution/system-signal` route (backend)

**File:** `server/routes/execution.ts` — lines ~234-321

**Change:** Handle the new `skipped_daily_limit` outcome.

- After `runner.runForUser(...)`, if `auto.outcome === 'skipped_daily_limit'`:
  - Do NOT call `markExecuted` (the signal was not executed).
  - Do NOT call `mirrorAutoTrade` (nothing to copy).
  - The response already includes `auto`, so the client sees the reason.
- The existing `executed` path (markExecuted + mirrorAutoTrade) is unchanged.

---

## Task 6: Tests

**File:** `server/tests/copy_trading_engine.test.ts` (add tests)

- Test: 24th copy succeeds, 25th is skipped with `daily_limit_reached`.
- Test: follower copies count toward the follower's own cap (not the master's).
- Test: manual trades are not capped (no `runForUser` / copy engine involvement).

**File:** `server/tests/execution.test.ts` or new `server/tests/auto_daily_limit.test.ts`

- Test: `runForUser` executes 24 trades, 25th returns `skipped_daily_limit`.
- Test: after the cap, every further signal that day is refused (no queue builds up).
- Test: on the next UTC day the counter resets and trading resumes automatically.

---

## Files NOT Modified (safety)
- `server/execution/gateway.ts` — no changes (the cap is enforced before the gateway is called).
- `server/services/risk.ts` — no changes (the cap is a separate check, not a risk rule).
- `server/execution/types.ts` — no new fields (the cap uses existing intent records for counting).
- Manual trade routes (`POST /api/execution/place`) — no changes (manual trades are not capped).
- Bot run routes — no changes (bot trades are not capped).

---

## Implementation Order
1. Task 1 (frontend: single winner publisher) — independent, can be done first.
2. Task 2 (backend: 24-cap in autoRunner + copyEngine) — core logic.
3. Task 3 (backend: stop at cap, resume next UTC day) — depends on Task 2.
4. Task 4 (backend: scanner status endpoint) — depends on Task 2.
5. Task 5 (backend: system-signal route update) — depends on Task 2.
6. Task 6 (tests) — after all backend changes.

## Validation
- `node node_modules/typescript/bin/tsc --noEmit` (frontend typecheck)
- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` (server typecheck)
- `node node_modules/tsx/dist/cli.mjs --test server/tests/copy_trading_engine.test.ts`
- `node node_modules/tsx/dist/cli.mjs --test server/tests/execution.test.ts`
- New test file for daily limit behaviour (`server/tests/auto_daily_limit.test.ts`)
- Restart backend (`:8787`) and dev (`:3000`) to verify end-to-end