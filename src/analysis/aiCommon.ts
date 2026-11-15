import { computeAdxSeries, computeRsiSeries } from './indicators';
import { computeAtrSeries, detectSwings, getCandleStats } from './swings';
import { confirmedOnly } from './trendlineDetection';
import type { Candle } from '../types/market';
import type {
  AiDirection,
  AiLevel,
  AiMarketCondition,
  AiSignal,
  AiSignalLifecycle,
  AiTimeframeRead,
  AiZone,
} from '../types/aiModule';

/** Last ATR(14) value (never zero — falls back to the last range). */
export function aiAtr(candles: readonly Candle[], period = 14): number {
  if (candles.length === 0) return 1e-6;
  const series = computeAtrSeries(candles, period);
  const last = series[series.length - 1];
  if (last && last > 0) return last;
  const c = candles[candles.length - 1];
  return Math.max(1e-6, c.high - c.low);
}

/** Simple moving average of the last `period` values (null when insufficient data). */
export function smaLast(values: readonly number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** EMA series (nulls until the seed). Mirrors `indicators.ts` but exported for modules. */
export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function emaLast(values: readonly number[], period: number): number | null {
  const series = emaSeries(values, period);
  const last = series[series.length - 1];
  return last ?? null;
}

/** Standard deviation of the last `period` closes. */
export function stdevLast(values: readonly number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

export interface AiConditionRead {
  condition: AiMarketCondition;
  /** Dominant direction of the read. */
  bias: 'bullish' | 'bearish' | 'neutral';
  /** 0–1 trend strength (ADX-normalised). */
  strength: number;
  detail: string;
}

/**
 * Classifies the current market condition from confirmed candles: EMA alignment + ADX
 * strength + recent structure. This is the FIRST step of every module's operating flow —
 * the module then selects the strategy appropriate to the read. It never forces a bias
 * onto a conflicting market.
 */
export function readAiCondition(candles: readonly Candle[], atr: number): AiConditionRead {
  const confirmed = confirmedOnly(candles);
  if (confirmed.length < 30) {
    return {
      condition: 'UNCLEAR',
      bias: 'neutral',
      strength: 0,
      detail: 'Not enough confirmed candles for a market-condition read.',
    };
  }

  const closes = confirmed.map((c) => c.close);
  const ema9 = emaLast(closes, 9);
  const ema20 = emaLast(closes, 20);
  const ema50 = emaLast(closes, 50);
  const adxSeries = computeAdxSeries(confirmed, 14);
  const adx = adxSeries[adxSeries.length - 1] ?? 0;
  const price = closes[closes.length - 1];

  const recent = confirmed.slice(-20);
  const recentRange = Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low));
  const prior = confirmed.slice(-40, -20);
  const priorRange =
    prior.length > 0
      ? Math.max(...prior.map((c) => c.high)) - Math.min(...prior.map((c) => c.low))
      : recentRange;

  const swings = detectSwings(confirmed, 3, 3);
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;

  const bullStack =
    ema9 !== null && ema20 !== null && ema50 !== null && ema9 > ema20 && ema20 > ema50 && price > ema9;
  const bearStack =
    ema9 !== null && ema20 !== null && ema50 !== null && ema9 < ema20 && ema20 < ema50 && price < ema9;

  const expansion = recentRange > priorRange * 1.35 && recentRange > atr * 6;
  const contraction = recentRange < priorRange * 0.7 && recentRange < atr * 4;
  const strength = Math.max(0, Math.min(1, adx / 40));

  const bull = bullStack || (hh && hl);
  const bear = bearStack || (lh && ll);

  if (adx >= 22 && bull && !bear) {
    return {
      condition: 'STRONG_BULLISH',
      bias: 'bullish',
      strength,
      detail: `Bullish structure with ADX ${adx.toFixed(1)} — trend continuation is the priority.`,
    };
  }
  if (adx >= 22 && bear && !bull) {
    return {
      condition: 'STRONG_BEARISH',
      bias: 'bearish',
      strength,
      detail: `Bearish structure with ADX ${adx.toFixed(1)} — trend continuation is the priority.`,
    };
  }
  if (expansion) {
    return {
      condition: 'VOLATILITY_EXPANSION',
      bias: bull ? 'bullish' : bear ? 'bearish' : 'neutral',
      strength,
      detail: `Range expanding ${(recentRange / atr).toFixed(1)}× ATR — breakout / momentum conditions.`,
    };
  }
  if (contraction) {
    return {
      condition: 'VOLATILITY_CONTRACTION',
      bias: 'neutral',
      strength,
      detail: `Range compressing to ${(recentRange / atr).toFixed(1)}× ATR — breakout pending.`,
    };
  }
  if ((bull || bear) && adx < 22) {
    return {
      condition: 'WEAK_TREND',
      bias: bull ? 'bullish' : 'bearish',
      strength,
      detail: `Directional lean (${bull ? 'bullish' : 'bearish'}) but ADX only ${adx.toFixed(
        1
      )} — weak trend.`,
    };
  }
  if (!bull && !bear && adx < 20) {
    const tight = recentRange < atr * 3.5;
    return {
      condition: tight ? 'CONSOLIDATION' : 'RANGING',
      bias: 'neutral',
      strength,
      detail: tight
        ? 'Tight consolidation — wait for an expansion trigger.'
        : 'Ranging market — trade range extremes, not the middle.',
    };
  }
  return {
    condition: 'UNCLEAR',
    bias: 'neutral',
    strength,
    detail: 'Conflicting signals — no clean directional or range read.',
  };
}

/** True when price is in the discount (below equilibrium) of the recent dealing range. */
export function dealingRange(candles: readonly Candle[], lookback = 40): {
  high: number;
  low: number;
  equilibrium: number;
  position: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
} | null {
  const confirmed = confirmedOnly(candles);
  if (confirmed.length < 10) return null;
  const window = confirmed.slice(-lookback);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const equilibrium = (high + low) / 2;
  const price = confirmed[confirmed.length - 1].close;
  const span = Math.max(1e-9, high - low);
  const rel = (price - low) / span;
  return {
    high,
    low,
    equilibrium,
    position: rel > 0.6 ? 'PREMIUM' : rel < 0.4 ? 'DISCOUNT' : 'EQUILIBRIUM',
  };
}

/** RSI at the last confirmed bar. */
export function rsiLast(candles: readonly Candle[], period = 14): number | null {
  const confirmed = confirmedOnly(candles);
  const series = computeRsiSeries(
    confirmed.map((c) => c.close),
    period
  );
  return series[series.length - 1] ?? null;
}

/** The most recent confirmed bar (or null). */
export function lastConfirmed(candles: readonly Candle[]): Candle | null {
  const confirmed = confirmedOnly(candles);
  return confirmed.length ? confirmed[confirmed.length - 1] : null;
}

/** A bullish/bearish candle body close beyond `level` (a valid structural break). */
export function bodyClosedBeyond(
  candle: Candle,
  level: number,
  direction: AiDirection,
  atr: number,
  minAtr = 0.15
): boolean {
  const stats = getCandleStats(candle);
  const displacement = direction === 'RISE' ? candle.close - level : level - candle.close;
  if (displacement < atr * minAtr) return false;
  return direction === 'RISE' ? stats.isBullish : stats.isBearish;
}

/**
 * Tracks a published signal's lifecycle against fresh confirmed candles. Entry and stop
 * are locked at publication; only the outcome is evaluated. A bar spanning both stop and
 * target settles as a loss (conservative). Mirrors the D&S module's status helper.
 */
export function aiSignalStatus(
  signal: AiSignal,
  freshCandles: readonly Candle[]
): AiSignalLifecycle {
  if (signal.lifecycle === 'COMPLETED' || signal.lifecycle === 'INVALIDATED') {
    return signal.lifecycle;
  }
  const fresh = freshCandles.filter((c) => c.time >= signal.confirmedBarTime);
  if (fresh.length === 0) return signal.lifecycle;

  const isRise = signal.direction === 'RISE';
  const targets = [signal.takeProfit1, signal.takeProfit2, signal.takeProfit3].filter(
    (v): v is number => v !== null
  );
  const finalTarget = isRise ? Math.min(...targets) : Math.max(...targets);

  for (const bar of fresh) {
    const hitStop = isRise ? bar.low <= signal.stopLoss : bar.high >= signal.stopLoss;
    const hitTarget = isRise ? bar.high >= finalTarget : bar.low <= finalTarget;
    if (hitStop) return 'INVALIDATED';
    if (hitTarget) return 'COMPLETED';
  }
  return 'ACTIVE';
}

/** Status label helper — a developing read never shows as CONFIRMED. */
export function statusForScore(score: number, gate: number): AiSignal['status'] {
  if (score >= gate) return 'CONFIRMED';
  if (score >= gate - 12) return 'WAITING_FOR_CONFIRMATION';
  return 'WAITING_FOR_SETUP';
}

/** Builds a compact three-timeframe read from raw detail strings. */
export function buildTimeframeReads(params: {
  m15: string;
  m5: string;
  m1: string;
  m15Tone?: AiTimeframeRead['tone'];
  m5Tone?: AiTimeframeRead['tone'];
  m1Tone?: AiTimeframeRead['tone'];
}): AiTimeframeRead[] {
  return [
    { timeframe: 'M15', label: 'M15 structure', detail: params.m15, tone: params.m15Tone ?? 'neutral' },
    { timeframe: 'M5', label: 'M5 setup', detail: params.m5, tone: params.m5Tone ?? 'neutral' },
    { timeframe: 'M1', label: 'M1 entry', detail: params.m1, tone: params.m1Tone ?? 'neutral' },
  ];
}

/** Chart levels for a published signal (entry / stop / TP1-3). */
export function signalLevels(signal: {
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
}): AiLevel[] {
  const levels: AiLevel[] = [
    { price: signal.entryPrice, label: 'ENTRY', kind: 'entry' },
    { price: signal.stopLoss, label: 'INVALIDATION', kind: 'stop' },
    { price: signal.takeProfit1, label: 'TP1', kind: 'target' },
    { price: signal.takeProfit2, label: 'TP2', kind: 'target' },
  ];
  if (signal.takeProfit3 !== null) {
    levels.push({ price: signal.takeProfit3, label: 'TP3', kind: 'target' });
  }
  return levels;
}

/** Clamps a number into [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Reward-to-risk from entry / stop / first target (null when degenerate). */
export function riskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return 0;
  return Number((reward / risk).toFixed(2));
}

/** Structural targets in the trade direction, deduped and ordered. */
export function orderTargets(
  direction: AiDirection,
  entry: number,
  candidates: readonly number[]
): number[] {
  const forward = candidates.filter((p) =>
    direction === 'RISE' ? p > entry : p < entry
  );
  const sorted = [...new Set(forward)].sort((a, b) =>
    direction === 'RISE' ? a - b : b - a
  );
  return sorted;
}

/**
 * Assembles a module signal. `levels` are the chart levels; entry/stop/targets are passed
 * explicitly so each module keeps full control of its own structural invalidation.
 */
export function buildAiSignal(params: {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: AiSignal['marketFamily'];
  precision: number;
  direction: AiDirection;
  modelId: string;
  modelLabel: string;
  strategyLabel: string;
  status: AiSignal['status'];
  score: number;
  condition: AiMarketCondition;
  entryPrice: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
  invalidationCondition: string;
  reasons: string[];
  confirmations: string[];
  timeframes: AiTimeframeRead[];
  confirmedBarTime: number;
}): AiSignal {
  const now = Date.now();
  return {
    ...params,
    lifecycle: 'ACTIVE',
    riskRewardRatio: riskReward(params.entryPrice, params.stopLoss, params.takeProfit1),
    levels: signalLevels(params),
    createdAt: now,
    lastUpdated: now,
  };
}

/** Builds a zone, de-duplicating an id suffix. */
export function makeZone(params: {
  id: string;
  direction: AiDirection;
  label: string;
  upperPrice: number;
  lowerPrice: number;
  quality: number;
  fresh: boolean;
  watch: boolean;
  reason: string;
}): AiZone {
  return { ...params };
}
