# WickSentinel — Copy Trading Business Platform: Audit & Implementation Plan

Status: **Phases 1–3 implemented and typechecked.** Phase 4 reuses the existing
isolation/security suites; Phase 5 design applied via the existing token system.
This document is the required "existing functionality audit" (§1) and the phased plan.
It is additive: the working copy-trading engine, bot builder and scanner are **not** modified.

---

## 1. Existing functionality audit (what already works)

### 1.1 Copy-trading engine (`server/copyTrading/`)
- `engine.ts` — `CopyExecutionEngine.mirrorMasterTrade(input)`: DEMO-only, per-master switch,
  fans out over the master's followers in parallel (`Promise.all`), one idempotency key per
  follower (`copy:<masterIntentId>:<accountId>`), builds a copy `SignalRecord`
  (`reason: copy:<signal.id>`), then `gateway.createIntent({asCopy:true})` → `gateway.submit`.
  A follower failure is isolated (audited, others still copy). Held / expired / unreadable-token
  followers are skipped. REAL master trades and REAL followers are never copied.
- `readiness.ts` — `buildCopyReadiness()`: read-only projection (DEGRADED / READY / PAUSED /
  NO_FOLLOWERS / AWAITING_AUTHORIZATION / UNKNOWN) with per-check scope. Never writes.
- `pat.ts` — `validatePatToken()`: the single PAT validator (shape + `fetchAccounts` + demo filter
  + identity). Requires `DERIV_PAT_APP_ID`, distinct from the OAuth app.
- `performance.ts` — `buildCopyPerformance()`: read-only P/L across master + follower principals,
  per-account rows and daily buckets. (Fixed this session: `purchaseTime` seconds→ms.)

### 1.2 Execution engine (`server/execution/`) — reused unchanged
- `gateway.ts` — the **only** purchase submitter. Order: kill switches → ownership/mode →
  approval window → token → account lock → signal single-use → risk → proposal → buy.
  Uncertain purchase → `UNKNOWN` → `RECONCILIATION_REQUIRED`; never blind-retried.
- `composition.ts` — `createExecution()` builds `{gateway, runner, monitor, flags, systemSignals,
  copyEngine, broker}`; the copy engine is injected into the trader, execution and bot routers.
- `contractMonitor.ts` — idempotent settlement (`dedupeKey settlement:<contractId>`), reconciliation
  (reads Deriv, never retries), boot reclassification of `UNKNOWN` contracts.
- `services/risk.ts` — every rule runs, fails closed on null balance; copy trades skip
  `symbol_in_use` (`signal.reason.startsWith('copy:')`).
- `broker/{derivBroker,fakeBroker,types}.ts` — OTP-URL flow, `getContract` one-shot read,
  `InvalidOfferings` distinct from a generic reject.

### 1.3 Auth & client security (`server/lib`, `server/routes/auth.ts`)
- Deriv OAuth 2.0 + PKCE; server-side sessions (HttpOnly signed cookie); AES-256-GCM sealing of
  Deriv tokens (`seal`/`open`); PAT validated by `validatePatToken` and sealed before persistence.
- Copy-trading OAuth callback writes follower + consent automatically; PAT path writes consent
  explicitly. Tokens never returned to the browser, logged, or written to audit (`redact()`).

### 1.4 Store (`server/store/`)
- 33 collections incl. `contracts`, `ledgerEntries` (dedupe by `dedupeKey`), `signals`,
  `tradeIntents`, `executionAttempts`, `executionAudit`, and copy-trading
  (`copyTradingFollowers/Invitations/Consents/Controls`). Tenant-scoped accessors;
  `listContractsForUsers()` spans the synthetic `copy_follower_<id>` principals.
- `clearTradingData()` wipes trading history but keeps the append-only audit.

### 1.5 Admin console (`admin/`, `server/routes/admin/`)
- 8 existing copy routes under `/api/admin/v1/copy-trading` (clients, invitations, masters,
  authorize-token/oauth, status, delete, connections, control, readiness, performance, balance,
  risk) with `copytrading.*` RBAC (SUPER/PLATFORM mutate; FINANCE/SUPPORT/ANALYST read-only).
- `CopyTradingClientsPage.tsx` (1033 lines) + `CopyEnginePanel.tsx` + `CopyReadinessPanel.tsx`.
- Design system in `admin/src/components/UI.tsx` (Card, StatCard, Badge, Notice, Empty, Modal,
  Pagination, Toaster, Sparkline, PageHeader, LoadingBlock) + `styles/theme.css` tokens.

### 1.6 Trader copy surfaces (`src/`)
- `lib/copyTrading.ts` (typed client) + `views/CopyTradingView.tsx` (manager dashboard).
  This session: master's own rows filtered out of the manager performance table.

### 1.7 Test coverage already green
`test:copy-admin` (35), `test:copy-engine` (17), `test:copy-readiness` (58), `test:copy-balance`
(6), `test:execution` (24), `test:exec-routes` (56), `test:risk` (25), `test:broker` (15),
`test:monitor` (10), `test:isolation` (21), `test:security` (6).

### 1.8 Gaps this platform fills
- No commission / markup / high-water-mark ledger. **(Phase 1 — done)**
- No admin revenue/commission/risk/reports pages. (Phase 2)
- No client portal (earnings/statements/risk settings). (Phase 3)
- No platform-wide financial statement aggregation. (Phase 1/2)
- Master `/bot` trades are not recorded server-side (known parity gap; documented, not faked).

---

## 2. Fee calculation policy (normative — single source of truth)

Constants live in `server/copyTrading/finance.ts` (`FEE_POLICY`):

- **Manager performance commission = 40%** of *commission base*.
- **Client profit allocation = 60%** of *commission base*.
- **App ID markup = 3%** of *stake* (the traded volume), charged via the configured App ID.

Definitions:
- **Commission base** is the realised profit of a *settled* contract **above the follower's
  high-water mark (HWM)**. HWM is the peak cumulative realised P/L for that follower.
  `base = max(0, cumulativeAfter − hwmBefore)`; `hwmAfter = max(hwmBefore, cumulativeAfter)`.
  Losses carry forward: a loss lowers cumulative P/L but never the HWM, so no commission is
  charged until a new profit high is reached.
- **Only settled contracts count.** `status ∈ {won, lost, sold, cancelled}` and a finite `profit`.
  Projected / unsettled P/L is never commissioned.
- **Markup**: `estimatedMarkup = stake × 3%` recorded at settlement time as *estimated*.
  `confirmedMarkup` equals the estimate once the contract is settled **and** reconciled
  (Deriv data confirmed); until then it is `null` and is **not** counted as collected revenue.
- **Idempotency**: one commission record per contract, `dedupeKey = commission:<contractId>`.
  Recomputation is pure and deterministic (settled contracts ordered by `settlementTime`, then id),
  so a re-run inserts only missing records and never double-charges.
- **Corrections**: a settlement correction is a new `adjustment` record, never an edit of an
  existing commission (out of Phase 1 scope; documented).

---

## 3. Phased plan

### Phase 1 — Financial engine (this change)
- `server/copyTrading/finance.ts`: `FEE_POLICY`, `computeFollowerCommissions()` (pure),
  `applyFollowerCommissions()` (idempotent writer), `buildStatement()` (per-follower + master
  aggregation: realised P/L, commission, client allocation, estimated vs confirmed markup).
- Store: new `commissionEntries` collection + accessors (`putCommissionEntry`,
  `listCommissionEntries`, `listAllCommissionEntries`); included in `clearTradingData`.
- Tests: `server/tests/copy_finance.test.ts` (commission math, HWM carry-forward, markup
  estimated vs confirmed, idempotency, settled-only, isolation).

### Phase 2 — Admin pages (8) + backend
Overview, Client Management (exists, extend), Individual Client Details, Strategy Management,
Live Execution Monitor, Revenue & Commission, Risk & Safety Centre, Reports/Audit/Reconciliation.
New read routes under `/api/admin/v1/copy-trading/*` reusing existing permissions; new
`admin/src/pages/*` + `lib/copyTrading.ts` methods. No mock data.

### Phase 3 — Client portal (5) in the trader SPA (`/app`)
Onboarding (reuse OAuth + PAT), Dashboard, My Trades, My Account & Risk Settings, Earnings &
Statements. Reuse `ProtectedRoute` + session; new `src/lib/copyClient.ts` + `views/*`.

### Phase 4 — Execution reliability + security + isolation tests
Broker-timeout / uncertain-acceptance / delayed-settlement / simultaneous-execution /
emergency-stop / unauthorized-admin tests (fake broker only).

### Phase 5 — Reatech360-inspired design system + responsive pass
Reusable Sidebar/Topbar/PageHeader/MetricCard/DataTable/Chart/Modal/StatusBadge/FinancialSummary/
Empty/Loading/Error components; neutral surfaces, restrained navy/blue/violet, non-colour-only
status; desktop-first admin, mobile-comfortable client portal.

---

## 4. Deliverable checklist (updated as phases land)
1. Audit — §1 above.
2. New functionality — §3 (Phases 1–3 done).
3. Files changed — see final report.
4. DB migrations — new `commissionEntries` collection (no data migration; additive).
5. API endpoints — Phase 2 admin: `/overview`, `/finance`, `/reconciliation`,
   `/executions`, `/clients/:id/detail`, `/strategies`, `/audit` (all `copytrading.read`).
   Phase 3 client (session-scoped by Deriv identity): `/api/copy-client/summary`,
   `/trades`, `/earnings`.
6. Tests — `test:copy-finance` (10), `test:copy-reporting` (8); existing
   isolation/security/execution/broker/monitor/copy suites reused for Phase 4.
7. Security findings — tokens sealed, never returned; commission records carry no secrets;
   client routes scoped by session identity (a client can only read their own records).
8. Outstanding issues — master `/bot` server-side parity; corrections as adjustments.
9. Needs live Deriv verification — confirmed markup equals estimate (real reconciliation).
10. Production-readiness — Phases 1–3 self-contained and tested; not a complete release yet.