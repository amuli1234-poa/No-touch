# REAL Execution Release Review

Status: **NOT RELEASED.** REAL execution stays disabled. This review records the
controls that gate it and what must be true before anyone changes that.

The machine-checkable half of this review is `server/tests/real_release_gate.test.ts`
(`npm run test:real-gate`).

## 1. Decision

REAL execution remains **off**. This is the default state of the system, not a
configuration that happens to be set: every flag defaults to `false`, and the
release ladder requires a deliberate, layered opt-in that no runtime code path
can flip.

Enabling REAL is a separate, explicit act. It is not part of this phase, and
nothing in the codebase enables it.

## 2. What gates REAL today

REAL money can only move if **all** of the following hold. Each is independent,
so a single mistake in any one is not enough to trade.

| # | Control | Where | Default |
|---|---|---|---|
| 1 | Master switch `ALLOW_EXECUTION` | `server/config/flags.ts` | `false` |
| 2 | `ALLOW_REAL_EXECUTION` — **and** the master switch | `server/config/flags.ts` | `false` |
| 3 | Customer authorisation `realExecutionAuthorised` | `server/execution/gateway.ts` | `false` |
| 4 | Account is owned by the user, active and tradable | `server/execution/accountGuard.ts` | — |
| 5 | Account mode is taken from the stored account, never the request | `accountGuard.ts` | — |
| 6 | Risk engine approves the trade | `server/services/risk.ts` | — |
| 7 | Automatic execution refuses REAL outright | `server/execution/autoRunner.ts` | — |

Notes:

- Flags are read from the environment **only** — never a request body, cookie or
  header — and the module offers no setter, so no runtime code can enable
  trading. Only a process restart with different env can.
- Only the exact lowercase string `"true"` enables a switch. `"TRUE"`, `"1"`,
  `"yes"` and whitespace variants all stay off, so a typo cannot arm a kill
  switch.
- The account mode is authoritative from the stored account record. A request
  that asserts `demo` against a `real` account (or vice versa) is refused with
  `account_mode_mismatch`; a request cannot downgrade a REAL trade to escape a
  REAL check, nor upgrade a DEMO account to trade REAL.
- Automatic execution is DEMO-only by design; a REAL account is refused before
  any proposal is requested.

## 3. Failure and recovery posture

- A purchase that may have reached Deriv but whose confirmation was lost moves
  to `UNKNOWN` → `RECONCILIATION_REQUIRED`. It is **never retried**. It is
  resolved by reading Deriv's own record (portfolio lookup, then a bounded
  probe) — see `server/execution/contractMonitor.ts`.
- A definite rejection (not uncertain) fails the intent cleanly and records no
  contract.
- Settlement is idempotent; a replayed lifecycle update cannot double-post to
  the ledger.
- The token is sealed at rest (AES-256-GCM) and never appears in persisted state
  or the audit trail (proven by `npm run test:security`).

## 4. Preconditions before REAL could ever be enabled

This list is deliberately conservative. Until every item is met and signed off,
REAL stays off.

1. **Extended forward test on DEMO.** A sustained DEMO run (weeks, not seconds)
   with the real gateway, reconciling settlement against Deriv transaction data.
2. **Independent security review** of the execution path, secrets handling and
   the audit trail.
3. **Explicit operator authorisation model.** A documented, auditable way for a
   customer to authorise REAL, and to revoke it, distinct from the DEMO consent.
4. **Per-account REAL limits** reviewed and set by a human, with a hard daily
   loss ceiling that cannot be raised automatically.
5. **Operational runbook.** How to halt trading, how to reconcile a stuck intent,
   and who is paged.
6. **A separate release review** — this document, repeated with REAL the subject
   rather than the exclusion.

## 5. How REAL would be enabled (and why this phase does not)

Enabling REAL requires, at minimum:

- `ALLOW_EXECUTION=true` and `ALLOW_REAL_EXECUTION=true` in the environment, and
- the customer's `realExecutionAuthorised` set to `true`.

Both are deliberate, separate acts. Neither is performed here. `ALLOW_REAL_EXECUTION`
is not documented as settable in this release, and `server/config/flags.ts`
carries no code that sets it.

## 6. Summary

The system is built to trade DEMO safely and to refuse REAL by default, through
layered controls that fail closed. That is the correct end state for this phase.
REAL execution is **not released**.
