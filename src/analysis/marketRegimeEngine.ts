import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  clamp,
  emaLast,
  makeZone,
  readAiCondition,
  statusForScore,
} from './aiCommon';
import { computeAdxSeries, computeMacdSeries } from './indicators';
import { detectSwings, getCandleStats, computeAtrSeries } from './swings';
import { analyzeMarketStructure } from './structure';
import { detectLiquidityPools, detectSweeps } from './smcTools';
import { confirmedOnly } from './trendlineDetection';
import type {
  AiDirection,
  AiInstrumentAnalysis,
  AiMarketCondition,
  AiSignal,
  AiTimeframeRead,
  AiZone,
} from '../types/aiModule';
import type { Candle, MarketFamily } from '../types/market';
import { formatPrice } from '../utils/derivParser';

/**
 * MARKET REGIME & CONSOLIDATION AI — condition-first engine.
 *
 * Its primary responsibility is to distinguish trending from ranging markets, detect
 * consolidation and genuine regime transitions, and rate the trading conditions. It only
 * produces a directional signal when the regime actually supports one (e.g. a confirmed
 * breakout) — otherwise it reports NO VALID SETUP.
 */

export const REGIME_PUBLICATION_MIN_SCORE = 85;

export type TradingConditionRating = 'EXCELLENT' | 'GOOD' | 'CAUTION' | 'AVOID_TRADING';

export const REGIME_MODEL_LABELS: Record<string, string> = {
  REGIME_BREAKOUT_RETEST: 'Range Breakout & Retest',
  REGIME_TREND_CONTINUATION: 'Trend Continuation',
  REGIME_REVERSAL_CHOCH: 'Range → CHOCH Reversal',
  REGIME_COMPRESSION_RELEASE: 'Compression Release',
};

export interface MarketRegimeEngineParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  structureCandles: readonly Candle[];
  setupCandles: readonly Candle[];
  entryCandles: readonly Candle[];
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
}

interface RegimeRead {
  label: string;
  condition: AiMarketCondition;
  bias: 'bullish' | 'bearish' | 'neutral';
  detail: string;
  rangeHigh: number | null;
  rangeLow: number | null;
  equilibrium: number | null;
  rating: TradingConditionRating;
  accumulationLike: boolean;
  distributionLike: boolean;
  transition: string;
}

function classifyRegime(candles: readonly Candle[]): RegimeRead {
  const bars = confirmedOnly(candles);
  const atr = aiAtr(bars);
  const condition = readAiCondition(bars, atr);
  const swings = detectSwings(bars, 3, 3);
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
  const closes = bars.map((c) => c.close);
  const adx = computeAdxSeries(bars, 14).at(-1) ?? 0;
  const macd = computeMacdSeries(closes);
  const hist = macd.histogram.at(-1) ?? 0;
  const ema20 = emaLast(closes, 20);
  const ema50 = emaLast(closes, 50);
  const price = closes.at(-1) ?? 0;

  const window = bars.slice(-40);
  const rangeHigh = window.length ? Math.max(...window.map((c) => c.high)) : null;
  const rangeLow = window.length ? Math.min(...window.map((c) => c.low)) : null;
  const equilibrium = rangeHigh !== null && rangeLow !== null ? (rangeHigh + rangeLow) / 2 : null;
  const rangeHeight = rangeHigh !== null && rangeLow !== null ? rangeHigh - rangeLow : 0;

  // Consolidation metrics: overlapping candles + contracting range.
  const recent = bars.slice(-15);
  const overlap = recent.filter((c, i) => i > 0 && Math.min(c.high, recent[i - 1].high) > Math.max(c.low, recent[i - 1].low)).length;
  const prior = bars.slice(-30, -15);
  const priorRange = prior.length ? Math.max(...prior.map((c) => c.high)) - Math.min(...prior.map((c) => c.low)) : rangeHeight;
  const contracting = rangeHeight < priorRange * 0.75;
  const tightConsolidation = overlap >= 9 && contracting && rangeHeight < atr * 4;

  // Accumulation / distribution: repeated sweeps both sides within a tight range.
  const pools = detectLiquidityPools(bars, atr, 2, price);
  const sweeps = detectSweeps(bars, pools, atr, 2);
  const sweepsBothSides =
    sweeps.some((s) => s.side === 'BSL' && s.genuine) && sweeps.some((s) => s.side === 'SSL' && s.genuine);
  const nearLow = rangeHeight > 0 && rangeLow !== null ? (price - rangeLow) / rangeHeight < 0.35 : false;
  const nearHigh = rangeHeight > 0 && rangeHigh !== null ? (rangeHigh - price) / rangeHeight < 0.35 : false;
  const accumulationLike = tightConsolidation && sweepsBothSides && nearLow;
  const distributionLike = tightConsolidation && sweepsBothSides && nearHigh && !accumulationLike;

  let label: string;
  let condOut: AiMarketCondition = condition.condition;
  let bias: 'bullish' | 'bearish' | 'neutral' = condition.bias;
  let detail = condition.detail;
  let transition = 'No regime transition detected.';

  if (adx >= 25 && hh && hl) {
    label = 'Strong bullish trend';
    condOut = 'STRONG_BULLISH';
    bias = 'bullish';
    transition = 'Trend is accelerating — continuation favoured while structure holds.';
  } else if (adx >= 25 && lh && ll) {
    label = 'Strong bearish trend';
    condOut = 'STRONG_BEARISH';
    bias = 'bearish';
    transition = 'Trend is accelerating — continuation favoured while structure holds.';
  } else if ((hh && hl) || (lh && ll)) {
    label = hh && hl ? 'Weak bullish trend' : 'Weak bearish trend';
    condOut = 'WEAK_TREND';
    bias = hh && hl ? 'bullish' : 'bearish';
    transition = 'Weak directional lean — watch for a structural break.';
  } else if (tightConsolidation) {
    label = accumulationLike ? 'Accumulation-like' : distributionLike ? 'Distribution-like' : 'Tight consolidation';
    condOut = 'CONSOLIDATION';
    bias = 'neutral';
    transition = 'Compression inside the range — wait for a displacement breakout.';
  } else if (condition.condition === 'VOLATILITY_EXPANSION') {
    label = 'Volatility expansion';
    condOut = 'VOLATILITY_EXPANSION';
    transition = 'Range expanding — breakout continuation conditions.';
  } else if (condition.condition === 'VOLATILITY_CONTRACTION') {
    label = 'Volatility compression';
    condOut = 'VOLATILITY_CONTRACTION';
    transition = 'Contraction under way — a release is developing.';
  } else if (!hh && !hl && !lh && !ll) {
    label = 'Sideways / ranging';
    condOut = 'RANGING';
    bias = 'neutral';
    transition = 'Ranging — trade the extremes, not the middle.';
  } else {
    label = 'Transitional / unclear';
    condOut = 'UNCLEAR';
    transition = 'Mixed signals — wait for a clearer regime.';
  }

  // Condition rating.
  let rating: TradingConditionRating = 'GOOD';
  if (label === 'Transitional / unclear') rating = 'AVOID_TRADING';
  else if (tightConsolidation && !accumulationLike && !distributionLike) rating = 'CAUTION';
  else if (adx >= 25 && (hh || ll)) rating = 'EXCELLENT';
  else if (condOut === 'RANGING') rating = 'CAUTION';
  else if (Math.abs(price - (ema50 ?? price)) < atr && adx < 18) rating = 'CAUTION';

  return {
    label,
    condition: condOut,
    bias,
    detail,
    rangeHigh,
    rangeLow,
    equilibrium,
    rating,
    accumulationLike,
    distributionLike,
    transition,
  };
}

function m1Confirm(
  entry: readonly Candle[],
  direction: AiDirection,
  atr: number
): { confirmed: boolean; time: number; detail: string } {
  const bars = confirmedOnly(entry);
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--) {
    const bar = bars[i];
    const stats = getCandleStats(bar);
    const dirOk = direction === 'RISE' ? stats.isBullish : stats.isBearish;
    if (dirOk && stats.body >= atr * 0.35) {
      return { confirmed: true, time: bar.time, detail: `M1 confirmed the ${direction === 'RISE' ? 'bullish' : 'bearish'} transition with a ${(stats.body / atr).toFixed(2)}× ATR body.` };
    }
  }
  return { confirmed: false, time: 0, detail: 'M1 transition confirmation pending.' };
}

export function analyzeMarketRegimeInstrument(params: MarketRegimeEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth } = params;
  const structure = confirmedOnly(params.structureCandles);
  const setup = confirmedOnly(params.setupCandles);
  const entry = confirmedOnly(params.entryCandles);

  const lastOf = (arr: readonly Candle[]) => (arr.length ? arr[arr.length - 1] : null);
  const price = lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastOf(structure)?.close ?? 0;
  const atr = aiAtr(setup.length ? setup : structure);
  const regime = classifyRegime(structure.length >= 30 ? structure : setup);

  const base: AiInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status: 'ANALYSING',
    statusExplanation: 'Classifying the market regime…',
    condition: regime.condition,
    timeframes: [],
    signal: null,
    activeZones: [],
    watchZones: [],
    bestScore: 0,
    atr,
    dataHealth,
    lastUpdated: Date.now(),
  };

  if (setup.length < 30 || entry.length < 5 || atr <= 0) {
    return {
      ...base,
      statusExplanation: 'Insufficient confirmed candles for the regime read.',
      rejectionReason: 'Not enough data.',
    };
  }

  const swings = detectSwings(setup, 3, 3);
  const ms = analyzeMarketStructure(setup, swings, computeAtrSeries(setup), precision);
  const latestBreak = ms.latestBreak;

  interface Draft {
    modelId: string;
    direction: AiDirection;
    entry: number;
    stop: number;
    targets: number[];
    score: number;
    reasons: string[];
    confirmations: string[];
    confirmed: boolean;
    confirmationTime: number;
    strategy: string;
  }
  const drafts: Draft[] = [];

  const { rangeHigh, rangeLow, equilibrium } = regime;

  // Range breakout & retest — only when a body close confirms the break.
  if (rangeHigh !== null && rangeLow !== null && regime.rating !== 'AVOID_TRADING') {
    const brokeUp = price > rangeHigh && latestBreak?.direction === 'bullish';
    const brokeDown = price < rangeLow && latestBreak?.direction === 'bearish';
    if (brokeUp || brokeDown) {
      const dir: AiDirection = brokeUp ? 'RISE' : 'FALL';
      const level = brokeUp ? rangeHigh : rangeLow;
      const conf = m1Confirm(entry, dir, aiAtr(entry));
      const targets = dir === 'RISE' ? [rangeHigh + (rangeHigh - rangeLow)] : [rangeLow - (rangeHigh - rangeLow)];
      drafts.push({
        modelId: 'REGIME_BREAKOUT_RETEST',
        direction: dir,
        entry: price,
        stop: dir === 'RISE' ? rangeHigh - atr * 0.8 : rangeLow + atr * 0.8,
        targets,
        score: clamp(58 + (conf.confirmed ? 14 : 0) + (targets.length ? 8 : 0), 0, 100),
        reasons: [
          `Range ${brokeUp ? 'high' : 'low'} at ${formatPrice(level, precision)} broken with a body close.`,
          regime.transition,
          conf.detail,
        ],
        confirmations: ['Confirmed range breakout'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
        strategy: 'Range breakout',
      });
    }
  }

  // Trend continuation — only in a strong trend regime.
  if (regime.condition === 'STRONG_BULLISH' || regime.condition === 'STRONG_BEARISH') {
    const dir: AiDirection = regime.condition === 'STRONG_BULLISH' ? 'RISE' : 'FALL';
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    const levels = swings.filter((s) => (dir === 'RISE' ? s.type === 'high' : s.type === 'low')).map((s) => s.price);
    const targets = levels.filter((p) => (dir === 'RISE' ? p > price : p < price)).sort((a, b) => (dir === 'RISE' ? a - b : b - a)).slice(0, 3);
    drafts.push({
      modelId: 'REGIME_TREND_CONTINUATION',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? price - atr * 1.8 : price + atr * 1.8,
      targets,
      score: clamp(60 + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 6 : 0), 0, 100),
      reasons: [`${regime.label} regime — pullback continuation is the priority.`, conf.detail],
      confirmations: ['Trend-regime continuation'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Trend continuation',
    });
  }

  // Compression release.
  if (regime.condition === 'VOLATILITY_CONTRACTION' || regime.label === 'Tight consolidation') {
    const dir: AiDirection = price >= (equilibrium ?? price) ? 'RISE' : 'FALL';
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    drafts.push({
      modelId: 'REGIME_COMPRESSION_RELEASE',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? (rangeLow ?? price - atr * 1.6) - atr * 0.2 : (rangeHigh ?? price + atr * 1.6) + atr * 0.2,
      targets: dir === 'RISE' ? [rangeHigh ?? price + atr * 2] : [rangeLow ?? price - atr * 2],
      score: clamp(55 + (conf.confirmed ? 12 : 0), 0, 100),
      reasons: [regime.transition, conf.detail],
      confirmations: ['Compression release'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Compression release',
    });
  }

  const best = drafts.sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = REGIME_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate);

  // ---- Chart zones: range boundaries + equilibrium ----
  const zones: AiZone[] = [];
  if (rangeHigh !== null && rangeLow !== null && equilibrium !== null) {
    zones.push(
      makeZone({
        id: `${symbol}-range-high`,
        direction: 'FALL',
        label: 'Range high',
        upperPrice: rangeHigh + atr * 0.1,
        lowerPrice: rangeHigh - atr * 0.1,
        quality: 60,
        fresh: true,
        watch: price < rangeHigh,
        reason: `Range high at ${formatPrice(rangeHigh, precision)} — reaction/liquidity zone above price.`,
      }),
      makeZone({
        id: `${symbol}-range-low`,
        direction: 'RISE',
        label: 'Range low',
        upperPrice: rangeLow + atr * 0.1,
        lowerPrice: rangeLow - atr * 0.1,
        quality: 60,
        fresh: true,
        watch: price > rangeLow,
        reason: `Range low at ${formatPrice(rangeLow, precision)} — reaction/liquidity zone below price.`,
      }),
      makeZone({
        id: `${symbol}-range-eq`,
        direction: 'RISE',
        label: 'Equilibrium',
        upperPrice: equilibrium + atr * 0.05,
        lowerPrice: equilibrium - atr * 0.05,
        quality: 45,
        fresh: true,
        watch: true,
        reason: `Equilibrium ${formatPrice(equilibrium, precision)} — range midpoint, avoid entries here.`,
      })
    );
  }

  const timeframes: AiTimeframeRead[] = buildTimeframeReads({
    m15: `${regime.label} · ${regime.detail}`,
    m15Tone: regime.bias === 'bullish' ? 'bull' : regime.bias === 'bearish' ? 'bear' : 'neutral',
    m5: regime.rangeHigh !== null && regime.rangeLow !== null
      ? `Range ${formatPrice(regime.rangeLow, precision)}–${formatPrice(regime.rangeHigh, precision)}`
      : 'No established range.',
    m5Tone: 'neutral',
    m1: best ? (best.confirmed ? 'M1 transition confirmed.' : 'M1 transition pending.') : 'No M1 confirmation.',
    m1Tone: best?.confirmed ? 'bull' : 'neutral',
  });

  let signal: AiSignal | null = null;
  if (best && bestScore >= gate && best.confirmed && regime.rating !== 'AVOID_TRADING') {
    const tp = best.targets;
    signal = buildAiSignal({
      id: `${symbol}-${best.modelId}-${best.confirmationTime}`,
      symbol,
      displayName,
      marketFamily,
      precision,
      direction: best.direction,
      modelId: best.modelId,
      modelLabel: REGIME_MODEL_LABELS[best.modelId] ?? best.modelId,
      strategyLabel: best.strategy,
      status: 'CONFIRMED',
      score: Math.round(bestScore),
      condition: regime.condition,
      entryPrice: best.entry,
      entryZoneLow: best.entry - atr * 0.2,
      entryZoneHigh: best.entry + atr * 0.2,
      stopLoss: best.stop,
      takeProfit1: tp[0] ?? best.entry + (best.direction === 'RISE' ? atr * 2 : -atr * 2),
      takeProfit2: tp[1] ?? best.entry + (best.direction === 'RISE' ? atr * 3.5 : -atr * 3.5),
      takeProfit3: tp[2] ?? null,
      invalidationCondition:
        best.direction === 'RISE'
          ? 'A close back inside the range invalidates the breakout.'
          : 'A close back inside the range invalidates the breakdown.',
      reasons: best.reasons,
      confirmations: best.confirmations,
      timeframes,
      confirmedBarTime: best.confirmationTime,
    });
  }

  const statusExplanation = signal
    ? `${signal.direction} confirmed — ${signal.modelLabel}. Trading conditions: ${regime.rating.replace(/_/g, ' ').toLowerCase()}.`
    : `${regime.label} · conditions ${regime.rating.replace(/_/g, ' ').toLowerCase()}. ${regime.transition}`;

  return {
    ...base,
    status: signal ? 'CONFIRMED' : regime.rating === 'AVOID_TRADING' ? 'NO_VALID_SETUP' : status,
    statusExplanation,
    timeframes,
    signal,
    activeZones: zones.filter((z) => !z.watch),
    watchZones: zones.filter((z) => z.watch),
    bestScore: Math.round(bestScore),
    rejectionReason:
      signal || !best ? undefined : `${regime.label} — no confirmed setup (${regime.rating.replace(/_/g, ' ').toLowerCase()}).`,
  };
}

export const marketRegimeEngine = analyzeMarketRegimeInstrument;
