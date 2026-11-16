import { computeAdxSeries, computeRsiSeries, ema } from './indicators';
import { computeAtrSeries, detectSwings, getCandleStats, type CandleStats } from './swings';
import { confirmedOnly } from './trendlineDetection';
import { formatPrice } from '../utils/derivParser';
import { AI_TIMEFRAME_KEYS } from '../config/deriv';
import type { Candle, TimeframeKey } from '../types/market';
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

/** EMA series (nulls until the seed). Single implementation lives in `indicators.ts`. */
export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  return ema(values, period);
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

/**
 * Status label helper — a developing read never shows as CONFIRMED.
 *
 * `CONFIRMED` is only ever returned when the setup is actually confirmed (and therefore
 * publishable). A high score that still awaits M1 confirmation reads as
 * WAITING_FOR_CONFIRMATION, never CONFIRMED, so a badge can never claim a confirmed entry
 * while no trade exists.
 */
export function statusForScore(
  score: number,
  gate: number,
  confirmed = true
): AiSignal['status'] {
  if (score >= gate) return confirmed ? 'CONFIRMED' : 'WAITING_FOR_CONFIRMATION';
  if (score >= gate - 12) return 'WAITING_FOR_CONFIRMATION';
  return 'WAITING_FOR_SETUP';
}

/** Builds a compact top-down timeframe read from raw detail strings (M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1). */
export function buildTimeframeReads(params: {
  m15: string;
  m5: string;
  m1: string;
  m15Tone?: AiTimeframeRead['tone'];
  m5Tone?: AiTimeframeRead['tone'];
  m1Tone?: AiTimeframeRead['tone'];
  /** M7 trend & market-structure confirmation read — present when M7 candles were supplied. */
  m7?: string;
  m7Tone?: AiTimeframeRead['tone'];
  /** M3 entry-setup confirmation read — present when M3 candles were supplied. */
  m3?: string;
  m3Tone?: AiTimeframeRead['tone'];
  /**
   * Extra ten-timeframe ladder reads (M30/M10/M6/M4/M2), in top-down order. Each is a
   * `timeframeConditionRead` result for a timeframe the module actually read; a timeframe
   * with insufficient data is simply omitted so it is never faked.
   */
  ladder?: readonly { timeframe: TimeframeKey; label: string; detail: string; tone: AiTimeframeRead['tone'] }[];
}): AiTimeframeRead[] {
  const reads: AiTimeframeRead[] = [
    { timeframe: 'M15', label: 'M15 structure', detail: params.m15, tone: params.m15Tone ?? 'neutral' },
  ];
  if (params.m7 !== undefined) {
    reads.push({ timeframe: 'M7', label: 'M7 trend & structure', detail: params.m7, tone: params.m7Tone ?? 'neutral' });
  }
  reads.push({ timeframe: 'M5', label: 'M5 setup', detail: params.m5, tone: params.m5Tone ?? 'neutral' });
  if (params.m3 !== undefined) {
    reads.push({ timeframe: 'M3', label: 'M3 confirmation', detail: params.m3, tone: params.m3Tone ?? 'neutral' });
  }
  reads.push({ timeframe: 'M1', label: 'M1 entry', detail: params.m1, tone: params.m1Tone ?? 'neutral' });
  if (params.ladder && params.ladder.length > 0) {
    const order = AI_TIMEFRAME_KEYS;
    const seen = new Set(reads.map((r) => r.timeframe));
    for (const extra of params.ladder) {
      if (seen.has(extra.timeframe)) continue;
      seen.add(extra.timeframe);
      reads.push({
        timeframe: extra.timeframe,
        label: extra.label,
        detail: extra.detail,
        tone: extra.tone,
      });
    }
    reads.sort((a, b) => order.indexOf(a.timeframe) - order.indexOf(b.timeframe));
  }
  return reads;
}

/**
 * Builds the extra ten-timeframe ladder reads (M30/M10/M6/M4/M2) for one index from its
 * per-timeframe candles, using the SAME market-condition classifier every module uses. A
 * timeframe with insufficient confirmed data is omitted — never faked.
 */
export function ladderTimeframeReads(
  candlesByTimeframe: Partial<Record<TimeframeKey, readonly Candle[]>> | undefined,
  roleLabels: Partial<Record<TimeframeKey, string>> = {}
): { timeframe: TimeframeKey; label: string; detail: string; tone: AiTimeframeRead['tone'] }[] {
  if (!candlesByTimeframe) return [];
  const out: { timeframe: TimeframeKey; label: string; detail: string; tone: AiTimeframeRead['tone'] }[] = [];
  for (const tf of AI_TIMEFRAME_KEYS) {
    const candles = candlesByTimeframe[tf];
    if (!candles || candles.length === 0) continue;
    const read = timeframeConditionRead(candles, roleLabels[tf] ?? tf);
    if (!read) continue;
    out.push({ timeframe: tf, label: `${tf} ${roleLabels[tf] ?? 'structure'}`, detail: read.detail, tone: read.tone });
  }
  return out;
}

/**
 * A short timeframe read (tone + detail) derived from a candle series using the SAME
 * market-condition classifier every module uses. Returns null when there is not enough
 * confirmed data — the caller then simply omits the read, so a timeframe is never faked.
 */
export function timeframeConditionRead(
  candles: readonly Candle[],
  role: string
): { detail: string; tone: AiTimeframeRead['tone'] } | null {
  const confirmed = confirmedOnly(candles);
  if (confirmed.length < 30) return null;
  const read = readAiCondition(confirmed, aiAtr(confirmed));
  const tone: AiTimeframeRead['tone'] =
    read.bias === 'bullish'
      ? 'bull'
      : read.bias === 'bearish'
        ? 'bear'
        : read.condition === 'CONSOLIDATION' || read.condition === 'RANGING'
          ? 'warn'
          : 'neutral';
  return { detail: `${role} — ${read.detail}`, tone };
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

/** Outcome of an M1 (entry-timeframe) confirmation scan. */
export interface M1Confirmation {
  confirmed: boolean;
  time: number;
  detail: string;
}

/**
 * The shared M1 confirmation scan every AI engine uses. It walks the last few CONFIRMED
 * entry-timeframe bars (most recent first) and returns the first one that satisfies the
 * caller's `accept` predicate. Each strategy keeps its own confirmation rule and wording;
 * only the scan loop is shared, so a strategy can never accidentally read the live bar.
 *
 * `accept` returns the confirmation detail text when a bar confirms, or `null` otherwise.
 */
export function scanM1Confirmation(
  entry: readonly Candle[],
  accept: (bar: Candle, stats: CandleStats) => string | null,
  pendingDetail: string,
  lookback = 5
): M1Confirmation {
  const bars = confirmedOnly(entry);
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - lookback); i--) {
    const bar = bars[i];
    const detail = accept(bar, getCandleStats(bar));
    if (detail) return { confirmed: true, time: bar.time, detail };
  }
  return { confirmed: false, time: 0, detail: pendingDetail };
}

/** M1 confirmation for a model that requires a directional close relative to a price level. */
export function m1LevelConfirm(
  entry: readonly Candle[],
  direction: AiDirection,
  level: number,
  atr: number,
  toleranceAtr: number,
  detail: (stats: CandleStats) => string,
  pendingDetail: string
): M1Confirmation {
  return scanM1Confirmation(
    entry,
    (bar, stats) => {
      const dirOk = direction === 'RISE' ? stats.isBullish : stats.isBearish;
      const beyond = direction === 'RISE' ? bar.close - level : level - bar.close;
      return dirOk && beyond > -atr * toleranceAtr ? detail(stats) : null;
    },
    pendingDetail
  );
}

/** M1 confirmation for a model that requires a directional bar with a minimum body. */
export function m1BodyConfirm(
  entry: readonly Candle[],
  direction: AiDirection,
  atr: number,
  bodyAtr: number,
  detail: (stats: CandleStats) => string,
  pendingDetail: string
): M1Confirmation {
  return scanM1Confirmation(
    entry,
    (bar, stats) => {
      const dirOk = direction === 'RISE' ? stats.isBullish : stats.isBearish;
      return dirOk && stats.body >= atr * bodyAtr ? detail(stats) : null;
    },
    pendingDetail
  );
}

/** Reward-to-risk from entry / stop / first target (null when degenerate). */
export function riskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return 0;
  return Number((reward / risk).toFixed(2));
}

/**
 * Drops drafts whose stop has landed on the WRONG SIDE of their entry. A structural stop
 * derived from a level that price has already passed through (e.g. a swept low that price
 * later closed below) can end up beyond the entry, which makes the trade unenterable. Such
 * drafts are removed so a module never publishes an invalid setup — it simply keeps the
 * remaining candidates or waits for the next valid one.
 */
export function structurallyValidDrafts<
  T extends { direction: AiDirection; entry: number; stop: number; targets: number[] }
>(drafts: readonly T[]): T[] {
  return drafts.filter(
    (d) =>
      Number.isFinite(d.entry) &&
      Number.isFinite(d.stop) &&
      (d.direction === 'RISE' ? d.stop < d.entry : d.stop > d.entry)
  );
}

/**
 * Bounded confluence bonus (0–18) from INDEPENDENT evidence a model has already computed.
 *
 * Modules score `base + confirmation + confluence`. Every module's base is set so that a
 * fully confirmed setup with strong confluence can reach its publication gate — without
 * this term several modules could never publish at all because their maximum achievable
 * score sat below their own gate. The bonus is capped so it can never carry a setup on its
 * own: confirmation is still required to publish.
 */
export function confluenceBonus(factors: {
  fvgQuality?: number;
  obQuality?: number;
  momentumConfirmed?: boolean;
  poolTouches?: number;
  trendAligned?: boolean;
  displacement?: boolean;
}): number {
  let b = 0;
  if (factors.fvgQuality !== undefined) b += factors.fvgQuality >= 70 ? 6 : factors.fvgQuality >= 50 ? 3 : 0;
  if (factors.obQuality !== undefined) b += factors.obQuality >= 70 ? 6 : factors.obQuality >= 50 ? 3 : 0;
  if (factors.momentumConfirmed) b += 5;
  if (factors.poolTouches !== undefined) b += factors.poolTouches >= 3 ? 4 : factors.poolTouches >= 2 ? 2 : 0;
  if (factors.trendAligned) b += 3;
  if (factors.displacement) b += 4;
  return Math.min(18, b);
}

/**
 * Bounded reward-to-risk sub-score (0–20), mirroring the Demand & Supply engine's
 * `spaceScore`. The Live Scanner previously ranked on confirmation + confluence alone, so a
 * setup risking 12× its reward could outrank one with a healthy 3:1 R:R even though the panel
 * advertises ranking "by quality, structure and reward-to-risk".
 */
export function rewardToRiskScore(reward: number, risk: number): number {
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || risk <= 0) return 0;
  const rr = reward / risk;
  return rr >= 2 ? 20 : rr >= 1.5 ? 15 : rr >= 1 ? 9 : 3;
}

/**
 * A structurally valid, monotonic target ladder anchored to the ACTUAL entry.
 *
 * Every returned target lies strictly beyond `entry` in `direction`, ordered nearest →
 * farthest, with at least TP1 and TP2 guaranteed from `unit` (the trade risk) when
 * structure offers fewer. This is the single guarantee that a published trade can never
 * carry a target on the wrong side of its entry — the class of bug that arises when an
 * engine derives targets from the current price while entering at a zone boundary.
 */
export function resolveTargets(
  direction: AiDirection,
  entry: number,
  candidates: readonly (number | null | undefined)[],
  unit: number
): number[] {
  const step = Math.max(1e-9, Math.abs(unit) || 1e-9);
  const eps = step * 0.05;
  const forward = candidates.filter(
    (p): p is number =>
      typeof p === 'number' &&
      Number.isFinite(p) &&
      (direction === 'RISE' ? p > entry + eps : p < entry - eps)
  );
  const ladder = [...new Set(forward)].sort((a, b) =>
    direction === 'RISE' ? a - b : b - a
  );
  const fallback = (mult: number) =>
    direction === 'RISE' ? entry + step * mult : entry - step * mult;
  // Guarantee TP1 and TP2, then enforce strict monotonic ordering beyond the previous leg.
  if (ladder.length < 1) ladder.push(fallback(2));
  if (ladder.length < 2) ladder.push(fallback(3.5));
  const out = ladder.slice(0, 3);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const ok = direction === 'RISE' ? out[i] > prev + eps : out[i] < prev - eps;
    if (!ok) out[i] = direction === 'RISE' ? prev + step * 1.5 : prev - step * 1.5;
  }
  return out;
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
  const { takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3 } = params;
  return {
    ...params,
    lifecycle: 'ACTIVE',
    riskRewardRatio: riskReward(params.entryPrice, params.stopLoss, tp1),
    levels: signalLevels({
      entryPrice: params.entryPrice,
      stopLoss: params.stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      takeProfit3: tp3,
    }),
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
