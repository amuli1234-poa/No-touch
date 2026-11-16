import type { Candle } from '../types/market';
import type { ManagedRankedSetup, RankedSetup, RankedSetupStatus } from '../types/ranking';

/**
 * AUTOMATIC SETUP LIFECYCLE.
 *
 * Every ranked setup is advanced against fresh confirmed candles:
 *  - TP hit  → COMPLETED   (removed from active lists + chart, recorded as a win)
 *  - SL hit  → INVALIDATED (removed from active lists + chart, recorded as a loss)
 *  - neither → stays ACTIVE
 *
 * A setup is never re-opened, never re-used and never resurrected: once settled its
 * status is terminal. When both the target and the stop sit inside the same bar the
 * stop wins — the conservative, worst-case reading.
 */

export interface SetupLifecycleVerdict {
  status: RankedSetupStatus;
  outcome: 'TARGET_HIT' | 'STOP_HIT' | 'INVALIDATED' | null;
  settledAt: number | null;
  exitPrice: number | null;
}

const STILL_ACTIVE: SetupLifecycleVerdict = {
  status: 'ACTIVE',
  outcome: null,
  settledAt: null,
  exitPrice: null,
};

/** Evaluate one setup against fresh candles. Pure — no side effects. */
export function evaluateSetupLifecycle(
  setup: RankedSetup,
  candles: readonly Candle[]
): SetupLifecycleVerdict {
  const { stopLoss, takeProfit1, direction, confirmedBarTime } = setup;
  if (candles.length === 0) return STILL_ACTIVE;

  const isRise = direction === 'RISE';
  // Only bars confirmed at or after the setup's confirmation bar may settle it.
  const fresh = candles.filter((c) => c.time >= confirmedBarTime);

  for (const bar of fresh) {
    const hitStop = stopLoss !== null && (isRise ? bar.low <= stopLoss : bar.high >= stopLoss);
    if (hitStop) {
      return {
        status: 'INVALIDATED',
        outcome: 'STOP_HIT',
        settledAt: bar.time,
        exitPrice: stopLoss,
      };
    }
    if (takeProfit1 !== null) {
      const hitTarget = isRise ? bar.high >= takeProfit1 : bar.low <= takeProfit1;
      if (hitTarget) {
        return {
          status: 'COMPLETED',
          outcome: 'TARGET_HIT',
          settledAt: bar.time,
          exitPrice: takeProfit1,
        };
      }
    }
  }
  return STILL_ACTIVE;
}

/**
 * Applies the automatic lifecycle to a batch of ranked setups, preserving the previous
 * verdict for setups that have already settled (a settled setup is never re-opened, even
 * if the candle window no longer contains the settle bar).
 */
export function advanceSetupLifecycles(
  setups: readonly RankedSetup[],
  candlesBySymbol: ReadonlyMap<string, readonly Candle[]>,
  previous: ReadonlyMap<string, ManagedRankedSetup> = new Map()
): { active: ManagedRankedSetup[]; settled: ManagedRankedSetup[] } {
  const active: ManagedRankedSetup[] = [];
  const settled: ManagedRankedSetup[] = [];

  for (const setup of setups) {
    const prior = previous.get(setup.key);
    // A terminal setup stays terminal — it is never reused or re-opened.
    if (prior && prior.status !== 'ACTIVE') {
      settled.push({ ...prior, wasActive: true });
      continue;
    }

    const candles = candlesBySymbol.get(setup.symbol) ?? [];
    const verdict = evaluateSetupLifecycle(setup, candles);
    const managed: ManagedRankedSetup = {
      ...setup,
      status: verdict.status,
      wasActive: prior?.wasActive ?? true,
      settledAt: verdict.settledAt,
      outcome: verdict.outcome,
    };

    if (verdict.status === 'ACTIVE') active.push(managed);
    else settled.push(managed);
  }

  return { active, settled };
}

/** True when a status is terminal (a settled setup that must never return to active). */
export function isSettledStatus(status: RankedSetupStatus): boolean {
  return status !== 'ACTIVE';
}
