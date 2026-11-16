import {
  aiAtr,
  bodyClosedBeyond,
  buildAiSignal,
  buildTimeframeReads,
  clamp,
  lastConfirmed,
  readAiCondition,
  resolveTargets,
  statusForScore,
} from './aiCommon';
import { computeAdxSeries, computeMacdSeries } from './indicators';
import { buildStructuredTrade } from './structuredReads';

import { computeAtrSeries, detectSwings, getCandleStats } from './swings';
import { detectLiquidityPools, detectSweeps } from './smcTools';
import { confirmedCandles } from './structureEngine';
import type { AiEngineParams } from '../hooks/useAiScanner';
import type { AiInstrumentAnalysis, AiSignal, AiTimeframeRead, AiZone } from '../types/aiModule';
import type { Candle, MarketFamily } from '../types/market';
import type {
  ConsolidationClass,
  ConsolidationRead,
  ConsolidationSignals,
  ExpansionState,
} from '../types/consolidation';

/** Clamp a 0–100 score. */
const clampPct = (v: number) => clamp(v, 0, 100);

/**
 * MARKET CONSOLIDATION & MOMENTUM AI — the sideways / momentum intelligence.
 *
 * It independently scans one index and detects sideways markets, consolidation, candle
 * compression, declining volatility, weak momentum, low price displacement, repeated
 * support/resistance reactions, liquidity sweeps and false breakouts. It distinguishes a
 * GENUINE consolidation from a slow directional trend or a temporary pullback, classifies
 * the market, and only approves a breakout after a confirmed structural break AND momentum
 * expansion. It reuses the shared classifier, swing, pool/sweep and indicator helpers — it
 * never duplicates an indicator stack.
 */

export const CONSOLIDATION_PUBLICATION_MIN_SCORE = 70;

const MIN_BARS = 40;
const CONSOLIDATION_PROB_GATE = 55;

function slope(values: readonly number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const recent = values.slice(-Math.min(8, n));
  return recent[recent.length - 1] - recent[0];
}

/** Pure structured consolidation/momentum read for one index. */
export function buildConsolidationRead(params: {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  setupCandles: readonly Candle[];
  structureCandles?: readonly Candle[];
}): ConsolidationRead {
  const bars = confirmedCandles(params.setupCandles);
  const atr = aiAtr(bars);
  const price = bars.length ? bars[bars.length - 1].close : 0;
  const emptySignals: ConsolidationSignals = {
    sideways: false,
    consolidation: false,
    candleCompression: false,
    decliningVolatility: false,
    weakMomentum: false,
    lowDisplacement: false,
    repeatedSupportResistance: false,
    liquiditySweeps: false,
    falseBreakout: false,
    earlyConsolidation: false,
    earlyExpansion: false,
  };

  const base: ConsolidationRead = {
    symbol: params.symbol,
    displayName: params.displayName,
    marketFamily: params.marketFamily,
    timeframe: 'M5',
    direction: null,
    directionalBias: 'neutral',
    alignmentScore: null,
    momentumStrength: 0,
    consolidationProbability: 0,
    preferredStrategy: 'Stand aside — insufficient data.',
    confidence: 0,
    confirmationCondition: 'Wait for enough confirmed candles.',
    invalidationCondition: 'Not applicable.',
    classification: 'UNCERTAIN',
    bullishMomentum: 0,
    bearishMomentum: 0,
    consolidationScore: 0,
    expansionPressure: 0,
    expansion: 'NONE',
    signals: emptySignals,
    continuationSuppressed: false,
    genuineConsolidation: false,
    breakoutApproved: false,
    slowTrend: false,
    invalidationLevel: null,
    trade: null,
  };
  if (bars.length < MIN_BARS || atr <= 0) return base;

  const closes = bars.map((c) => c.close);
  const ema9 = closes.length >= 9 ? closes.slice(-9).reduce((a, b) => a + b, 0) / 9 : price;
  const ema21 = closes.length >= 21 ? closes.slice(-21).reduce((a, b) => a + b, 0) / 21 : price;
  const adx = computeAdxSeries(bars, 14).at(-1) ?? 0;
  const macd = computeMacdSeries(closes);
  const hist = macd.histogram.at(-1) ?? 0;
  const atrSeries = computeAtrSeries(bars, 14).filter((v) => v > 0);
  const atrSlope = slope(atrSeries);
  const atrRising = atrSlope > 0;
  const atrFalling = atrSlope < 0;

  // ---- Window metrics: the consolidation window EXCLUDES the newest bar, so the newest
  // bar can be tested as a breakout of the window it just left. ----
  const last = bars[bars.length - 1];
  const recent = bars.slice(-16, -1);
  const prior = bars.slice(-31, -16);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));
  const recentRange = Math.max(1e-9, recentHigh - recentLow);
  const priorHigh = prior.length ? Math.max(...prior.map((c) => c.high)) : recentHigh;
  const priorLow = prior.length ? Math.min(...prior.map((c) => c.low)) : recentLow;

  const overlap = recent.filter(
    (c, i) => i > 0 && Math.min(c.high, recent[i - 1].high) > Math.max(c.low, recent[i - 1].low)
  ).length;
  const overlapRatio = overlap / Math.max(1, recent.length - 1);

  const avgRange = recent.reduce((a, c) => a + (c.high - c.low), 0) / recent.length;
  const priorAvgRange = prior.length
    ? prior.reduce((a, c) => a + (c.high - c.low), 0) / prior.length
    : avgRange;
  const compression = avgRange < priorAvgRange * 0.8;
  const tightRange = recentRange < atr * 5;

  const netMove = Math.abs(recent[recent.length - 1].close - recent[0].close);
  const pathLength = recent.reduce((a, c) => a + Math.abs(c.close - c.open), 0) || 1e-9;
  const efficiency = netMove / pathLength;
  const lowDisplacement = efficiency < 0.35;

  const swings = detectSwings(bars, 3, 3);
  const swingHighs = swings.filter((s) => s.type === 'high');
  const swingLows = swings.filter((s) => s.type === 'low');
  const tolerance = Math.max(atr * 0.6, recentRange * 0.1);
  const resistanceTouches = swingHighs.filter((s) => recentHigh - s.price <= tolerance).length;
  const supportTouches = swingLows.filter((s) => s.price - recentLow <= tolerance).length;
  const repeatedSR = resistanceTouches >= 2 && supportTouches >= 2;

  const pools = detectLiquidityPools(bars, atr, 2, price);
  const sweeps = detectSweeps(bars, pools, atr, params.precision);
  const recentSweeps = sweeps.filter((s) => s.time >= recent[0].time);
  const liquiditySweeps = recentSweeps.length > 0;

  // False breakout: a recent bar pierced a PRIOR extreme then closed back inside the window.
  let falseBreakout = false;
  for (const bar of [...recent, last]) {
    const piercedUp = bar.high > priorHigh + atr * 0.1 && bar.close < priorHigh - atr * 0.15;
    const piercedDown = bar.low < priorLow - atr * 0.1 && bar.close > priorLow + atr * 0.15;
    if (piercedUp || piercedDown) {
      falseBreakout = true;
      break;
    }
  }

  const weakMomentum = adx < 18 && Math.abs(hist) < atr * 0.2;
  // Sideways requires BOTH heavy bar overlap and low net displacement — a trending market
  // with pullbacks overlaps heavily but still displaces, so efficiency is the discriminator.
  const sideways = overlapRatio >= 0.55 && efficiency < 0.5 && recentRange < atr * 6;

  // ---- Momentum strength (independent bull/bear) ----
  const bodyAtr = Math.abs(getCandleStats(last).body) / atr;
  const bullRaw = clampPct(
    (ema9 > ema21 ? 25 : 0) +
      (hist > 0 ? 20 : 0) +
      clampPct(adx * 1.5) * 0.4 +
      (efficiency > 0.5 && last.close > recent[0].close ? 25 : 0) +
      clampPct(bodyAtr * 20)
  );
  const bearRaw = clampPct(
    (ema9 < ema21 ? 25 : 0) +
      (hist < 0 ? 20 : 0) +
      clampPct(adx * 1.5) * 0.4 +
      (efficiency > 0.5 && last.close < recent[0].close ? 25 : 0) +
      clampPct(bodyAtr * 20)
  );
  const bullishMomentum = Math.round(bullRaw);
  const bearishMomentum = Math.round(bearRaw);
  const momentumStrength = Math.max(bullishMomentum, bearishMomentum);

  // ---- Consolidation probability ----
  let consolidationScore = 0;
  if (sideways) consolidationScore += 20;
  if (compression) consolidationScore += 18;
  if (atrFalling) consolidationScore += 14;
  if (repeatedSR) consolidationScore += 16;
  if (lowDisplacement) consolidationScore += 14;
  if (weakMomentum) consolidationScore += 12;
  if (liquiditySweeps) consolidationScore += 8;
  consolidationScore = clampPct(consolidationScore);

  const slowTrend = efficiency >= 0.45 && adx >= 18 && !sideways;

  // ---- Breakout confirmation: a close beyond the PRE-breakout window + volatility expansion.
  // The window must have actually been coiling (compression / overlap / tight range) so a
  // clean trend that simply prints new highs every bar is never mislabelled a breakout. ----
  const preConsolidated = compression || overlapRatio >= 0.55 || tightRange;
  const breakUp = preConsolidated && atrRising && bodyClosedBeyond(last, recentHigh, 'RISE', atr, 0.25);
  const breakDown = preConsolidated && atrRising && bodyClosedBeyond(last, recentLow, 'FALL', atr, 0.25);
  const breakoutApproved = breakUp || breakDown;

  const genuineConsolidation = consolidationScore >= CONSOLIDATION_PROB_GATE && !slowTrend && !breakoutApproved;
  const earlyConsolidation = !genuineConsolidation && overlapRatio >= 0.5 && compression && atrFalling;
  const earlyExpansion = compression && atrRising && momentumStrength >= 45;
  const expansionPressure = clampPct(
    (compression ? 30 : 0) + (atrFalling ? 15 : 0) + (liquiditySweeps ? 15 : 0) + clampPct(overlapRatio * 30) + (weakMomentum ? 10 : 0)
  );

  const expansion: ExpansionState = breakoutApproved
    ? 'CONFIRMED'
    : earlyExpansion
      ? 'BUILDING'
      : atrRising && !genuineConsolidation
        ? 'FADING'
        : 'NONE';

  // ---- Classification ----
  const strongUp = adx >= 22 && ema9 > ema21 && hist > 0 && bullishMomentum >= 55;
  const strongDown = adx >= 22 && ema9 < ema21 && hist < 0 && bearishMomentum >= 55;
  let classification: ConsolidationClass;
  if (strongUp && !genuineConsolidation) classification = 'STRONG_BULLISH';
  else if (strongDown && !genuineConsolidation) classification = 'STRONG_BEARISH';
  else if (breakoutApproved) classification = 'VOLATILITY_EXPANSION';
  else if (genuineConsolidation && atrFalling && compression) classification = 'VOLATILITY_CONTRACTION';
  else if (genuineConsolidation) classification = 'CONSOLIDATING';
  else if (weakMomentum && (sideways || overlapRatio >= 0.45)) classification = 'RANGING';
  else if (bullishMomentum >= 40 || bearishMomentum >= 40) classification = 'WEAK_MOMENTUM';
  else classification = 'UNCERTAIN';

  const direction: 'RISE' | 'FALL' | null =
    classification === 'STRONG_BULLISH'
      ? 'RISE'
      : classification === 'STRONG_BEARISH'
        ? 'FALL'
        : breakUp
          ? 'RISE'
          : breakDown
            ? 'FALL'
            : null;

  // Suppress weak directional continuation: a lean with weak momentum, or in consolidation.
  const continuationSuppressed =
    (classification === 'WEAK_MOMENTUM' || genuineConsolidation) && direction !== null;

  const invalidationLevel =
    direction === 'RISE' ? recentLow : direction === 'FALL' ? recentHigh : null;

  // ---- Trade: only an approved breakout publishes ----
  let trade = null as ConsolidationRead['trade'];
  if (breakoutApproved && direction !== null) {
    const stop = direction === 'RISE' ? recentLow - atr * 0.4 : recentHigh + atr * 0.4;
    const measured = direction === 'RISE' ? recentHigh + recentRange : recentLow - recentRange;
    const candidates =
      direction === 'RISE'
        ? [measured, ...swingHighs.map((s) => s.price), ...pools.filter((p) => p.side === 'BSL').map((p) => p.price)]
        : [measured, ...swingLows.map((s) => s.price), ...pools.filter((p) => p.side === 'SSL').map((p) => p.price)];
    trade = buildStructuredTrade({ direction, entry: price, stop, candidates, unit: atr });
  }

  const signals: ConsolidationSignals = {
    sideways,
    consolidation: genuineConsolidation,
    candleCompression: compression,
    decliningVolatility: atrFalling,
    weakMomentum,
    lowDisplacement,
    repeatedSupportResistance: repeatedSR,
    liquiditySweeps,
    falseBreakout,
    earlyConsolidation,
    earlyExpansion,
  };

  const directionalBias: ConsolidationRead['directionalBias'] =
    classification === 'STRONG_BULLISH'
      ? 'bullish'
      : classification === 'STRONG_BEARISH'
        ? 'bearish'
        : bullishMomentum >= 55 && bearishMomentum >= 55
          ? 'conflicting'
          : direction === 'RISE'
            ? 'bullish'
            : direction === 'FALL'
              ? 'bearish'
              : 'neutral';

  const preferredStrategy =
    breakoutApproved
      ? 'Confirmed breakout continuation'
      : classification === 'STRONG_BULLISH' || classification === 'STRONG_BEARISH'
        ? 'Trend continuation with momentum'
        : classification === 'VOLATILITY_CONTRACTION'
          ? 'Prepare for the compression release'
          : genuineConsolidation
            ? 'Range extremes only — fade the edges, never the middle'
            : classification === 'RANGING'
              ? 'Range extremes only'
              : 'Stand aside — no reliable momentum';

  const confidence = clampPct(
    (breakoutApproved ? 80 : genuineConsolidation ? 70 : momentumStrength) + (repeatedSR ? 5 : 0) - (falseBreakout ? 5 : 0)
  );

  return {
    ...base,
    direction,
    directionalBias,
    momentumStrength,
    consolidationProbability: Math.round(consolidationScore),
    preferredStrategy,
    confidence,
    confirmationCondition:
      direction !== null
        ? `A ${direction === 'RISE' ? 'bullish' : 'bearish'} close beyond the ${direction === 'RISE' ? 'range high' : 'range low'} with expanding volatility.`
        : 'A confirmed break of the consolidation boundary with momentum expansion.',
    invalidationCondition:
      invalidationLevel !== null
        ? `A close back ${direction === 'RISE' ? 'below' : 'above'} ${invalidationLevel.toFixed(params.precision)}.`
        : 'A close back inside the consolidation range.',
    classification,
    bullishMomentum,
    bearishMomentum,
    consolidationScore: Math.round(consolidationScore),
    expansionPressure: Math.round(expansionPressure),
    expansion,
    signals,
    continuationSuppressed,
    genuineConsolidation,
    breakoutApproved,
    slowTrend,
    invalidationLevel,
    trade,
  };
}

function toTimeframeReads(read: ConsolidationRead): AiTimeframeRead[] {
  const tone = (v: boolean): AiTimeframeRead['tone'] => (v ? 'warn' : 'neutral');
  return buildTimeframeReads({
    m15: `Consolidation probability ${read.consolidationScore}/100 · ${read.classification.replace(/_/g, ' ').toLowerCase()}.`,
    m5: `Bull ${read.bullishMomentum} · Bear ${read.bearishMomentum} · expansion ${read.expansion.toLowerCase()}.`,
    m1: read.breakoutApproved
      ? 'Breakout confirmed — structural break + momentum expansion.'
      : read.signals.falseBreakout
        ? 'Recent false breakout detected — fade the failed edge.'
        : 'Awaiting a confirmed breakout.',
    m15Tone: tone(read.genuineConsolidation),
    m5Tone: (read.momentumStrength ?? 0) >= 55 ? (read.bullishMomentum >= read.bearishMomentum ? 'bull' : 'bear') : 'neutral',
    m1Tone: read.breakoutApproved ? (read.direction === 'RISE' ? 'bull' : 'bear') : 'neutral',
  });
}

/** The Market Consolidation & Momentum AI engine (shared orchestrator contract). */
export function analyzeConsolidationInstrument(params: AiEngineParams): AiInstrumentAnalysis {
  const setupCandles = params.candlesByTimeframe?.['M5'] ?? params.setupCandles ?? params.structureCandles;
  const read = buildConsolidationRead({
    symbol: params.symbol,
    displayName: params.displayName,
    marketFamily: params.marketFamily,
    precision: params.precision,
    setupCandles,
    structureCandles: params.candlesByTimeframe?.['M15'] ?? params.structureCandles,
  });

  const atr = aiAtr(confirmedCandles(setupCandles));
  const price = lastConfirmed(setupCandles)?.close ?? 0;
  const condition = readAiCondition(confirmedCandles(setupCandles), atr).condition;

  const publishable =
    read.breakoutApproved &&
    read.direction !== null &&
    read.trade !== null &&
    read.confidence >= CONSOLIDATION_PUBLICATION_MIN_SCORE;

  let signal: AiSignal | null = null;
  if (publishable && read.trade && read.direction !== null) {
    const t = read.trade;
    signal = buildAiSignal({
      id: `${params.symbol}-consol-${read.direction}-${Date.now()}`,
      symbol: params.symbol,
      displayName: params.displayName,
      marketFamily: params.marketFamily,
      precision: params.precision,
      direction: read.direction,
      modelId: 'CONSOL_BREAKOUT',
      modelLabel: 'Consolidation Breakout & Expansion',
      strategyLabel: read.preferredStrategy,
      status: statusForScore(read.confidence, CONSOLIDATION_PUBLICATION_MIN_SCORE, true),
      score: Math.round(read.confidence),
      condition,
      entryPrice: t.entry,
      entryZoneLow: t.entry - atr * 0.2,
      entryZoneHigh: t.entry + atr * 0.2,
      stopLoss: t.stop,
      takeProfit1: t.tp1,
      takeProfit2: t.tp2,
      takeProfit3: t.tp3,
      invalidationCondition: read.invalidationCondition,
      reasons: [
        `Confirmed breakout out of a consolidation (probability ${read.consolidationScore}/100).`,
        `Momentum expansion — bull ${read.bullishMomentum} / bear ${read.bearishMomentum}.`,
        read.confirmationCondition,
      ],
      confirmations: ['Structural break + volatility expansion'],
      timeframes: toTimeframeReads(read),
      confirmedBarTime: lastConfirmed(setupCandles)?.time ?? 0,
    });
  }

  const zones: AiZone[] = [];
  if (read.invalidationLevel !== null && read.direction) {
    zones.push({
      id: `${params.symbol}-consol-zone`,
      direction: read.direction,
      label: read.direction === 'RISE' ? 'BREAKOUT LONG' : 'BREAKOUT SHORT',
      upperPrice: read.direction === 'RISE' ? read.invalidationLevel + atr * 0.4 : read.invalidationLevel + atr * 0.2,
      lowerPrice: read.direction === 'RISE' ? read.invalidationLevel - atr * 0.2 : read.invalidationLevel - atr * 0.4,
      quality: Math.round(read.confidence),
      fresh: true,
      watch: !read.breakoutApproved,
      reason: read.confirmationCondition,
    });
  }

  const status = signal
    ? signal.status
    : read.classification === 'CONSOLIDATING'
      ? 'CONSOLIDATING'
      : read.classification === 'VOLATILITY_CONTRACTION'
        ? 'COMPRESSION'
        : read.classification === 'VOLATILITY_EXPANSION'
          ? 'CONFIRMED_BREAKOUT'
          : read.classification === 'STRONG_BULLISH' || read.classification === 'STRONG_BEARISH'
            ? 'TRENDING'
            : read.classification === 'RANGING'
              ? 'RANGING'
              : read.signals.weakMomentum
                ? 'MOMENTUM_WEAKENING'
                : 'UNCLEAR';

  return {
    symbol: params.symbol,
    displayName: params.displayName,
    marketFamily: params.marketFamily,
    precision: params.precision,
    price,
    status,
    statusExplanation: `${read.classification.replace(/_/g, ' ').toLowerCase()} · consolidation ${read.consolidationScore}/100 · bull ${read.bullishMomentum} / bear ${read.bearishMomentum}${
      read.continuationSuppressed ? ' · weak continuation suppressed' : ''
    }.`,
    condition,
    timeframes: toTimeframeReads(read),
    signal,
    activeZones: read.breakoutApproved ? zones : [],
    watchZones: read.breakoutApproved ? [] : zones,
    bestScore: Math.round(read.confidence),
    atr,
    dataHealth: params.dataHealth,
    lastUpdated: Date.now(),
    rejectionReason: signal
      ? undefined
      : read.genuineConsolidation
        ? 'Market is consolidating — no directional continuation approved.'
        : read.continuationSuppressed
          ? 'Directional continuation suppressed — momentum is too weak.'
          : 'No confirmed breakout (structural break + momentum expansion required).',
    intelligence: read,
  };
}
