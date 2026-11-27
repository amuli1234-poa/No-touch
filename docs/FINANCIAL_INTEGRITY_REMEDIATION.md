# Financial Integrity Remediation — Plan & Progress

Status: Phases 4, 1, 5, 3, 2 implemented (see per-phase notes). NOT READY FOR PRODUCTION.

## Phase 4 — Currency precision
- `server/copyTrading/money.ts`: `currencyDigits`, `roundMoney(value, currency)` (no float
  drift; per-currency digits: USD/EUR/GBP 2, JPY/IDK 0, BTC 8, XRP 6).
- `finance.ts` uses `roundMoney` with each amount's currency. No silent conversion.

## Phase 1 — Immutable settlement adjustments
- `server/copyTrading/adjustments.ts`: `ContractAdjustmentRecord`, `applyContractAdjustment`
  (idempotent by `adjustment:<contractId>:<key>`), `effectiveProfit`.
- Store: `contractAdjustments` collection + `putContractAdjustment` / `listContractAdjustments`.
- Original settlement ledger entry and original commission entry are never overwritten.
- `computeFollowerCommissions` / `applyFollowerCommissions` / `buildStatement` use effective
  profit (original + adjustments); the statement returns `adjustments` for traceability.
- Audit: adjustment source, reason, timestamp, affected contract.

## Phase 5 — Event-driven commission processing
- `ContractMonitor` gains optional `onSettled(user, contract)`; composition wires it to
  `applyFollowerCommissions` for `copy_follower_` principals. Idempotent; crash-safe (recomputed
  from store on next settle/view). No commission before settlement.

## Phase 3 — Master /bot trade recording
- `buildStatement.masterRealisedPnl: number | null` — null (unavailable) when no master
  contracts are recorded, never a fabricated 0. UI shows "unavailable".
- Full /bot server-side recording is a bot-app change (deferred; documented).

## Phase 2 — Deriv markup verification
- `CommissionEntryRecord.reportedMarkup: number | null` added (null — Deriv exposes no markup
  attribution through the available API). Estimated / reported / confirmed are distinct;
  confirmed stays null until an external reconciliation reads the actual collected amount.
- No endpoint invented. `markupStatus` is `estimated` | `reported` | `confirmed`; only
  `confirmed` counts as collected revenue.

### External reconciliation procedure (manual, per settlement batch)
The 3% App ID markup is charged by Deriv on the stake and is **not** itemised on any
contract, `proposal_open_contract`, `portfolio` or `statement` response this build can read.
Confirmation therefore requires an out-of-band source. Do this once per reconciliation
window (e.g. daily), never inline in a request path:

1. **Export the platform's own ledger** for the window: every `commissionEntries` row with
   `contractId`, `stake`, `estimatedMarkup`, `reportedMarkup`, `markupStatus`, `currency`.
   Filter to `markupStatus !== 'confirmed'`.
2. **Obtain the actual collected markup** from the Deriv account statement / settlement
   report for the same account and window (the App ID's collected markup line, or the
   difference between the client's debited stake and the amount Deriv applied to the
   contract). This is the only authoritative figure.
3. **Reconcile per contract**: match by `contractId` + `currency`. Where the external figure
   exists, set `reportedMarkup` to it and `markupStatus` to `confirmed` via a store write
   (never overwrite the original `estimatedMarkup`; the confirmed value is additive). Where
   it does not exist, leave `reportedMarkup: null` / `markupStatus: 'estimated'`.
4. **Record the source**: the audit row names the statement/export used and the operator, so
   a confirmed figure is always traceable to an external document.
5. **Never auto-confirm**: no code path may set `markupStatus: 'confirmed'` from an estimate.
   Until step 2–3 run, confirmed platform revenue is reported as unavailable, not zero.

Until this procedure has been executed against a live Deriv statement, the platform remains
NOT READY FOR PRODUCTION for financial reporting.

## Acceptance
- Existing tests green; new regression tests per phase; server + frontend typechecks pass.
- Copy engine, scanner, bot builder, isolation untouched. DEMO/REAL separation intact.
- Status remains NOT READY FOR PRODUCTION pending live Deriv markup reconciliation.