import { resolveTargets, riskReward } from './aiCommon';
import type { StructuredTradeLevels } from '../types/structuredRead';

/**
 * A published trade must be enterable in the real market, not merely well-ordered. The first
 * target has to clear a minimum structural distance from the entry, and the stop cannot sit an
 * absurd distance away — both expressed in ATR units so they hold on every index.
 */
const MIN_TARGET_DISTANCE_ATR = 0.5;
const MAX_STOP_DISTANCE_ATR = 15;

/**
 * Builds a structurally valid trade plan from an entry, a structural stop and a pool of
 * candidate target levels. Returns null when the stop is on the wrong side of the entry, the
 * entry is not finite, the first target sits inside the entry's noise band, or the stop is so
 * far away the trade is unenterable — so a module never publishes a degenerate trade. Targets
 * are resolved with the SAME shared resolver every other engine uses (TP1/TP2 guaranteed).
 */
export function buildStructuredTrade(params: {
  direction: 'RISE' | 'FALL';
  entry: number;
  stop: number;
  candidates: readonly (number | null | undefined)[];
  unit: number;
}): StructuredTradeLevels | null {
  const { direction, entry, stop, candidates, unit } = params;
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  const stopOk = direction === 'RISE' ? stop < entry : stop > entry;
  if (!stopOk) return null;
  const atr = Math.max(1e-9, Math.abs(unit) || 1e-9);
  if (Math.abs(entry - stop) > atr * MAX_STOP_DISTANCE_ATR) return null;
  const ladder = resolveTargets(direction, entry, candidates, unit);
  if (ladder.length === 0) return null;
  const tp1 = ladder[0];
  const tp1Distance = direction === 'RISE' ? tp1 - entry : entry - tp1;
  if (tp1Distance < atr * MIN_TARGET_DISTANCE_ATR) return null;
  const tp2 = ladder[1] ?? (direction === 'RISE' ? entry + Math.abs(entry - stop) * 2 : entry - Math.abs(entry - stop) * 2);
  const tp3 = ladder[2] ?? null;
  return { entry, stop, tp1, tp2, tp3, riskRewardRatio: riskReward(entry, stop, tp1) };
}
