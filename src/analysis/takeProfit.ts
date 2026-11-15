import type {
  SupportResistanceLevel,
  SupplyDemandZone,
} from '../types/analysis';
import type { Candle } from '../types/market';
import type { TpAdjustment } from '../types/training';
import { computeAtrSeries } from './swings';

/**
 * Dynamic take-profit engine.
 *
 * Entry and stop-loss are LOCKED by the caller and are never touched here. The
 * take-profit is the only mutable level. The same functions drive live operation
 * and historical replay so backtested behaviour matches live behaviour exactly.
 */

export interface TpSignalView {
  direction: 'RISE' | 'FALL';
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

/** True when a proposed take-profit is on the correct side of current market price. */
export function takeProfitAheadOfPrice(
  direction: 'RISE' | 'FALL',
  takeProfit: number,
  marketPrice: number
): boolean {
  return direction === 'RISE' ? takeProfit > marketPrice : takeProfit < marketPrice;
}

/** A valid TP never sits behind price and never crosses the locked entry or stop-loss. */
export function isValidTakeProfit(
  signal: TpSignalView,
  newTp: number,
  marketPrice: number
): boolean {
  if (!Number.isFinite(newTp)) return false;
  if (!takeProfitAheadOfPrice(signal.direction, newTp, marketPrice)) return false;
  if (signal.direction === 'RISE') {
    // Reward side: strictly above entry, and above the stop-loss.
    if (newTp <= signal.entry) return false;
    if (newTp <= signal.stopLoss) return false;
  } else {
    if (newTp >= signal.entry) return false;
    if (newTp >= signal.stopLoss) return false;
  }
  return true;
}

/**
 * Applies a validated take-profit adjustment, appending an audit record. Returns the
 * signal unchanged when the new TP is invalid (behind price or crossing entry/SL).
 */
export function applyTakeProfit(
  signal: TpSignalView,
  newTp: number,
  reason: string,
  marketPrice: number,
  timestamp: number,
  barTime: number,
  history: readonly TpAdjustment[]
): { signal: TpSignalView; history: TpAdjustment[] } | null {
  if (!isValidTakeProfit(signal, newTp, marketPrice)) return null;
  const rounded = newTp;
  if (Math.abs(rounded - signal.takeProfit) < 1e-9) return null;
  const adjustment: TpAdjustment = {
    previous: signal.takeProfit,
    next: rounded,
    timestamp,
    reason,
    kind: rounded > signal.takeProfit === (signal.direction === 'RISE') ? 'EXTEND' : 'TIGHTEN',
    barTime,
  };
  return {
    signal: { ...signal, takeProfit: rounded },
    history: [...history, adjustment],
  };
}

/**
 * Evaluates whether the dynamic take-profit should move given the current bar,
 * structure and momentum. Uses ONLY the bars supplied (callers pass confirmed,
 * non-future candles). Returns null when no justified adjustment exists.
 *
 * Rules:
 *  - Extend TP only when momentum strongly supports continuation and there is fresh
 *    structural room ahead.
 *  - Tighten TP when momentum weakens/exhausts or an opposing level develops close by.
 *  - Never place TP behind current market price; never cross entry/stop-loss.
 */
export interface TpEvaluationInput {
  direction: 'RISE' | 'FALL';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** Confirmed candles up to and including the current evaluation bar. */
  candles: readonly Candle[];
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  precision: number;
  marketPrice: number;
}

export function evaluateDynamicTakeProfit(
  input: TpEvaluationInput
): { newTakeProfit: number; reason: string } | null {
  const { direction, entry, stopLoss, takeProfit, candles, marketPrice } = input;
  if (candles.length < 20) return null;
  const isRise = direction === 'RISE';

  const atrs = computeAtrSeries(candles, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  if (atr <= 0) return null;

  const last = candles[candles.length - 1];
  const recent = candles.slice(-6);
  const avgRange =
    recent.reduce((sum, c) => sum + Math.max(1e-9, c.high - c.low), 0) / recent.length;
  const lastBody = Math.abs(last.close - last.open);
  const bodyRatio = avgRange > 0 ? lastBody / avgRange : 0;

  // Consecutive directional closes into the latest bar.
  let consecutive = 0;
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - 7); i--) {
    const bull = candles[i].close > candles[i].open;
    if ((isRise && bull) || (!isRise && !bull)) consecutive++;
    else break;
  }

  // Nearest opposing level/zone ahead of price (the structural barrier to reward).
  const barriers: number[] = [];
  for (const l of input.supportResistance) {
    if (l.status !== 'active') continue;
    if (isRise && l.type === 'resistance' && l.price > marketPrice) barriers.push(l.price);
    if (!isRise && l.type === 'support' && l.price < marketPrice) barriers.push(l.price);
  }
  for (const z of input.supplyDemand) {
    if (z.status === 'invalidated') continue;
    if (isRise && z.type === 'supply' && z.lowerPrice > marketPrice) barriers.push(z.lowerPrice);
    if (!isRise && z.type === 'demand' && z.upperPrice < marketPrice) barriers.push(z.upperPrice);
  }
  const barrier: number | null =
    barriers.length === 0
      ? null
      : barriers.reduce((best, price) => (isRise ? Math.min(best, price) : Math.max(best, price)));

  // Momentum exhaustion: strong run then a small body / opposing wick.
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const exhaustion =
    consecutive >= 4 &&
    (bodyRatio < 0.6 ||
      (isRise && upperWick >= lastBody * 1.2) ||
      (!isRise && lowerWick >= lastBody * 1.2));

  const strongContinuation = consecutive >= 2 && bodyRatio >= 0.75 && !exhaustion;
  const weakMomentum = bodyRatio < 0.5 || exhaustion;

  const extension = Math.max(atr * 1.5, Math.abs(takeProfit - entry) * 0.35);

  // 1) Tighten: an opposing level has developed between price and the current TP.
  if (barrier !== null) {
    const barrierBeforeTp = isRise ? barrier < takeProfit : barrier > takeProfit;
    const barrierBeyondBuffer = isRise
      ? barrier - marketPrice >= atr * 0.4
      : marketPrice - barrier >= atr * 0.4;
    if (barrierBeforeTp && barrierBeyondBuffer) {
      const tightened = isRise ? barrier - atr * 0.25 : barrier + atr * 0.25;
      if (isValidTakeProfit({ direction, entry, stopLoss, takeProfit }, tightened, marketPrice)) {
        return {
          newTakeProfit: tightened,
          reason: `Opposing ${
            isRise ? 'resistance' : 'support'
          } developed ahead at ${barrier.toFixed(input.precision)} — tightening TP in front of it.`,
        };
      }
    }
  }

  // 2) Tighten: momentum weakening / exhaustion with no fresh room to run.
  if (weakMomentum && barrier === null) {
    const tightened = isRise ? marketPrice + atr * 0.6 : marketPrice - atr * 0.6;
    const closer =
      isRise ? tightened < takeProfit - atr * 0.2 : tightened > takeProfit + atr * 0.2;
    if (closer && isValidTakeProfit({ direction, entry, stopLoss, takeProfit }, tightened, marketPrice)) {
      return {
        newTakeProfit: tightened,
        reason: exhaustion
          ? `Momentum exhaustion after ${consecutive} bars — moving TP closer to bank gains.`
          : `Momentum weakened (body ${bodyRatio.toFixed(2)}x range) — tightening TP.`,
      };
    }
  }

  // 3) Extend: strong momentum AND clear structural room beyond the current TP.
  if (strongContinuation) {
    const roomAhead = barrier === null ? Infinity : isRise ? barrier - takeProfit : takeProfit - barrier;
    if (roomAhead > atr * 0.75) {
      const extended = isRise ? takeProfit + extension : takeProfit - extension;
      if (isValidTakeProfit({ direction, entry, stopLoss, takeProfit }, extended, marketPrice)) {
        return {
          newTakeProfit: extended,
          reason: `Strong ${isRise ? 'bullish' : 'bearish'} continuation (${consecutive} bars, body ${bodyRatio.toFixed(
            2
          )}x) with open structural room — extending TP.`,
        };
      }
    }
  }

  return null;
}
