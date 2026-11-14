# Phase 1 — Repository Audit and Architecture Assessment

Status: **assessment only. No execution code written.**
Scope: read the existing system, decide what to keep, and plan the phased build.

---

## 1. What already exists (audited)

### Runtime and stack

| Layer | Technology | Evidence |
|---|---|---|
| Frontend | Vite 8, React 19, TypeScript, Tailwind v4, Lightweight Charts v5 | `package.json`, `vite.config.ts` |
| Package manager | bun | `bun.lock` |
| Backend | Express on `tsx`, TypeScript, ESM | `server/index.ts` |
| Persistence | Pluggable: JSON file **or** SQLite (`node:sqlite`, WAL, real transactions, indexes) | `server/store/{backend,json_backend,sqlite_backend,store}.ts` |
| Tests | `node:test`, 10 suites, all green | `server/tests/*`, `src/tests/*` |
| Admin | Separate SPA (`admin/`), separate cookie/session/RBAC | `admin/src`, `server/routes/admin/*` |

Total: 164 TS/TSX files, ~33.5k lines. The scanner engines (~13) are **client-side**.

### Authentication and identity — strong foundation, keep as-is

- Deriv OAuth 2.0 **Authorization Code + PKCE**, token exchange server-side only
  (`server/lib/deriv.ts`, `server/routes/auth.ts`).
- Session: opaque id, HMAC-SHA256 signed HttpOnly cookie, sliding renewal,
  server-side revocation (`server/lib/session.ts`, `server/lib/crypto.ts`).
- **Deriv access token encrypted at rest** with AES-256-GCM (`seal`/`open`,
  key derived from `SESSION_SECRET` via HKDF). Never sent to the browser.
- OAuth `state` validated server-side, single-use transactions (replay-proof),
  `code_verifier` in a server transaction plus a short-lived cookie fallback.
- Scope is **`trade`** only. `openid` is not an allowed Deriv scope, so the
  `trade`-scoped accounts endpoint doubles as the identity source.
- Reauthorization: `/api/deriv/verify` re-validates the token and revokes the
  session on mismatch or revocation.

### Multi-tenant isolation — partially present

- `UserRecord` is keyed by an id derived from the verified Deriv `sub`
  (`u_<base64url(sub)>`), never a client value.
- `BalanceService` already enforces the exact pattern the trading build needs:
  the requested account **must** appear in the session user's own stored account
  list; a client-asserted `mode` that disagrees is **rejected, not substituted**;
  DEMO and REAL are kept separate (`server/services/balance.ts`).
- Admin authorization is permission-based (24 permissions, 5 roles), separate
  cookie/session/MFA/CSRF/lockout (`server/admin/permissions.ts`,
  `server/middleware/adminAuth.ts`).

### Market data — client-side only (a gap for execution)

- `src/services/DerivWebSocketManager.ts` connects from the **browser** to the
  Deriv public WebSocket (`ticks_history`, `ticks` subscribe). No auth, no
  server involvement.
- The backend has **no** market-data service.

### AI analysis — scaffolded, honest, no provider

- `src/features/analysis/`: engine interface, a deterministic engine wrapping the
  real price-action pipeline, and declared AI engines that report `UNAVAILABLE`
  because no inference provider is configured. `GEMINI_API_KEY` is absent.

### Execution — none exists

- Verified by search: there is **no** proposal, buy, stake, contract or ledger
  code anywhere in `server/` or `src/`. `src/components/views/TradePanel.tsx` is
  explicitly documented as *not* an order ticket.
- This is the clean slate the trading build starts from. Nothing to unwind.

---

## 2. Verified Deriv API surface

### 2a. Documentation-confirmed endpoints

Confirmed from `developers.deriv.com/docs` navigation (the reference pages are
JS-rendered, so field-level schemas were read from the live API instead — see 2b):

- **WebSocket — Trading Operations:** `Proposal`, `Buy`, `Sell`,
  `Proposal open contract`, `Contract update`, `Contract update history`,
  `Cancel`, `Bulk purchase`.
- **WebSocket — Market Data:** `Active symbols`, `Contracts for`, `Contracts
  list`, `Ticks`, `Ticks history`.
- **WebSocket — Account Management:** `Balance`, `Portfolio`, `Profit table`,
  `Statement`, `Transaction`.
- **WebSocket — Subscription Management:** `Forget`, `Forget all`.
- **WebSocket — Authentication:** `authorize`.
- **REST — Options Setup:** Get accounts, Create account, Reset demo balance.
- REST Options Trading (Legacy) is read-only.
- The API is split into **demo** and **real** WebSocket connections.

### 2b. Live-verified from this environment (read-only, no credentials, no purchase)

These were measured, not assumed. Probes are reproducible from `node_modules/ws`.

**Finding 1 — the legacy WebSocket is unreachable from the server, but the new
options API works.**

| Endpoint | Result from server |
|---|---|
| `wss://ws.derivws.com/websockets/v3` | **HTTP 520 (Cloudflare block)** |
| `wss://ws.binaryws.com/websockets/v3` | **HTTP 520 (Cloudflare block)** |
| `https://api.derivws.com/trading/v1/options/accounts` | 401 (reachable; needs auth) |
| `wss://api.derivws.com/trading/v1/options/ws/public` | **OPEN — real data flowing** |
| `https://auth.deriv.com/.well-known/openid-configuration` | 200 |

The browser streams market data from the legacy WS fine (it is a browser client),
but **the backend cannot use it.** Execution must therefore be built on the new
options API (`api.derivws.com`), which the frontend already references
(`DerivWebSocketManager.ts` line 60 lists the public options WS endpoint).

**Finding 2 — verified contract catalogue for `R_100` (live `contracts_for`).**
Rise/Fall and Multipliers are **not** named `RISE`/`FALL`/`MULT`; the real
contract types are:

- **Rise/Fall = `CALL` / `PUT`** — `contract_category: "callput"`,
  `expiry_type: "daily"`, `barriers: 1`, `default_stake: 2`,
  `min_contract_duration: "1d"`, `max_contract_duration: "365d"`,
  `sentiment: "up" | "down"`.
  (The same symbol also lists `CALL`/`PUT` under other expiry variants, so the
  adapter must select the correct expiry variant, not just the first match.)
- **Multipliers = `MULTUP` / `MULTDOWN`** — `contract_category: "multiplier"`,
  `expiry_type: "no_expiry"`, `barriers: 0`,
  `multiplier_range: [40, 100, 200, 300, 400]`,
  `cancellation_range: ["5m","10m","15m","30m","60m"]`, `default_stake: 2`.

Also verified live: `active_symbols` returns 95 symbols with
`underlying_symbol` / `underlying_symbol_name` / `pip_size`; `ticks` returns
`{ ask, bid, epoch, quote, symbol, pip_size }`.

### Open items still requiring an authenticated demo account (blocking before Phase 6)

I have **not** verified these, because doing so requires a real Deriv app
credential and a demo account, which I do not have and will not fabricate. They
must be confirmed against a live demo account before any execution code is
written:

1. **Authenticated trading WS host + auth mechanism** — the exact
   `.../ws/demo` and `.../ws/real` paths and how the OAuth access token (or a
   per-account token from the accounts endpoint) authorises a specific account.
2. **`proposal` request/response schema** on the new API — field names for
   `contract_type`, `duration`/`duration_unit` (CALL/PUT), `multiplier` +
   barriers (MULTUP/MULTDOWN), `amount`, `basis`, `currency`, and the returned
   proposal `id` / `spot` / `payout`.
3. **`buy` request/response schema** — `buy: <proposal id>` + `price`, and the
   returned `contract_id` / `buy_price` / `balance_after` / `transaction_id`.
4. **`proposal_open_contract`** settlement fields (status, profit, exit spot).
5. **Multipliers `limit_order`** stop-loss / take-profit fields on the proposal.

**This is the correct place to stop and get input.** Verifying items 1–5 needs
your Deriv application (app id + the registered redirect URI) and a **demo**
account to test against. I will not guess these schemas — guessing a purchase
payload is exactly the failure mode the brief forbids.

---

## 3. Architecture decisions

### Keep (do not replace)

- The entire OAuth/session/token-sealing stack — it already meets the credential
  requirements.
- `BalanceService`'s ownership/mode validation as the reference pattern; the
  execution gateway will use the same "resolve from the session user's own
  records, reject mismatches" approach.
- The admin surface, kept strictly separate from customer trading.
- The pluggable store and its SQLite backend.
- The client-side analysis engines.

### Add — new, independent modules (all server-side)

```
server/execution/
  gateway.ts            # the ONLY component allowed to submit a purchase
  stateMachine.ts       # durable trade-intent states + transitions
  intentStore.ts        # trade intents / attempts / contracts / ledger (SQLite)
  locks.ts              # account-level execution locks (DB-backed)
  adapters/
    riseFall.ts         # Rise/Fall proposal + buy
    multipliers.ts      # Multipliers proposal + buy (separate assumptions)
  broker/
    types.ts            # BrokerAdapter interface
    derivBroker.ts      # real Deriv WS adapter
    fakeBroker.ts       # tests ONLY
server/services/
  marketData.ts         # server-side Deriv WS market data + snapshots
  risk.ts               # risk engine (server-enforced)
  strategy.ts           # signal/strategy validation
  ledger.ts             # financial ledger, reconciliation
  contractMonitor.ts    # contract lifecycle tracking
  notifications.ts      # customer notifications
server/config/flags.ts  # kill switches (ALLOW_EXECUTION etc.)
```

Rules the architecture enforces:

- **AI models never touch the execution gateway.** They produce analysis; the
  strategy engine produces a signal; the gateway is the only submitter.
- **Every backend execution request derives identity from the verified session.**
  No frontend-supplied customer id, ownership claim, mode or permission is
  trusted.
- **The JSON backend cannot be used for execution.** Atomicity requires SQLite;
  the gateway must refuse to run on JSON. (Existing note in `store.ts` already
  says callers needing atomicity must use SQLite.)
- **Execution uses the new options API, not the legacy WebSocket.** The legacy WS
  is Cloudflare-blocked from the server (Finding 1). The market-data service and
  the execution gateway will both talk to `api.derivws.com/trading/v1/options/ws/*`.
  The existing client-side `DerivWebSocketManager` may keep using the legacy WS
  for chart data, but no server-side execution path may depend on it.

### Persistence

New SQLite collections (keyed): `tradeIntents`, `executionAttempts`,
`contracts`, `ledgerEntries`, `riskProfiles`, `executionPreferences`,
`notifications`, `signals`. Append-only: `executionAudit`, `stateTransitions`.
Registered in `COLLECTION_SPECS` so every backend stays consistent.

---

## 4. Phase plan

| Phase | Deliverable | Gate to pass before next phase |
|---|---|---|
| 1 | This assessment + plan | Your approval |
| 2 | Customer accounts, secure isolation, per-tenant records | Isolation + IDOR tests pass |
| 3 | Server-side market data + AI orchestration | Snapshot consistency + freshness tests |
| 4 | Signal + strategy validation | Signal id/expiry/duplicate tests |
| 5 | Risk engine | All risk controls + rejection reasons tested |
| 6 | **Manual DEMO execution** | A verified DEMO purchase via the real gateway |
| 7 | Automatic DEMO execution | Same validation path as manual; stop works |
| 8 | Contract monitoring + ledger reconciliation | Settlement reconciles to Deriv transaction data |
| 9 | Security, failure recovery, forward testing | Full security + recovery suite |
| 10 | REAL execution release review | **Stays disabled until separately authorised** |

---

## 5. Security controls already in place vs. required

| Requirement | Current state |
|---|---|
| Server-side token handling | Done (sealed AES-256-GCM) |
| OAuth state/callback validation | Done (single-use transactions) |
| Session integrity | Done (HMAC-signed, revocable) |
| Admin separated from trading | Done (separate cookie/RBAC) — must be *kept* separate |
| Ownership + mode validation | Done for balances; must be extended to execution |
| Redaction of secrets from logs | Audit service redacts; must extend to execution paths |
| Cross-tenant access → authz error | Pattern exists; must add execution-path tests |
| Kill switches | **Not implemented** — Phase 2/6 |
| Risk engine | **Not implemented** — Phase 5 |
| Execution state machine | **Not implemented** — Phase 6 |
| Durable account-level locks | **Not implemented** — Phase 6 |
| Fake broker adapter | **Not implemented** — Phase 6 |

---

## 6. Explicit non-actions

- No REAL execution will be enabled.
- No code will be written against assumed Deriv schemas — the six open items in
  §2 are verified first.
- No existing working functionality is removed.
- `ALLOW_EXECUTION`, `ALLOW_DEMO_EXECUTION`, `ALLOW_REAL_EXECUTION` will all
  default to `false`, with REAL permanently so until a separate release review.
