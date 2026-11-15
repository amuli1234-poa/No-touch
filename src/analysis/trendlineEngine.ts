import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type {
  TrendlineCandidate,
  TrendlineInstrumentAnalysis,
  TrendlineRejection,
  TrendlineScanSummary,
  TrendlineSignal,
} from '../types/trendline';
import { TRENDLINE_MODEL_LABELS } from '../types/trendline';
import { assessMomentum } from './momentum';
import { detectRangeAnalysis } from './rangeAnalysis';
import { analyzeMarketStructure } from './structure';
import { detectSupportResistance } from './supportResistance';
import { detectSupplyDemandZones } from './supplyDemand';
import { computeAtrSeries, detectSwings } from './swings';
import { evaluateTrendAlignment } from './trendAlignment';
import { buildTrendSetupZones } from './trendRejection';
import {
  classifyTrendlineCondition,
  confirmedOnly,
  detectTrendlines,
  trendlineAtr,
} from './trendlineDetection';
import { detectTrendlineCandidate, isPublishable } from './trendlineModels';

export interface AnalyzeTrendlineParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  /** Confirmed M15 candles (structural analysis timeframe). */
  structureCandles: readonly Candle[];
  /** Confirmed M5 candles (setup + mandatory rejection confirmation timeframe). */
  entryCandles: readonly Candle[];
  /** Confirmed M1 candles (precise entry confirmation timeframe). */
  m1Candles?: readonly Candle[];
  dataHealth?: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
}

const STRUCTURE_TF: TimeframeKey = 'M15';
const SETUP_TF: TimeframeKey = 'M5';
const ENTRY_TF: TimeframeKey = 'M1';

/**
 * The Trendline Strategy Engine — fully independent of the price-action engine.
 *
 *  - Structure (swings, trendlines, market condition, range) is built on M15.
 *  - Entries and the mandatory rejection confirmation are taken on M5.
 *  - Four models: rejection, breakout, breakout & retest, liquidity sweep & reclaim.
 *  - A signal is only published when a confirmed rejection clears the 85/100 gate.
 */
export function analyzeTrendlineInstrument(
  params: AnalyzeTrendlineParams
): TrendlineInstrumentAnalysis {
  const {
    symbol,
    displayName,
    precision,
    marketFamily,
    structureCandles,
    entryCandles,
    m1Candles = [],
    dataHealth = 'HEALTHY',
  } = params;

  const structure = confirmedOnly(structureCandles);
  const entry = confirmedOnly(entryCandles);
  const m1 = confirmedOnly(m1Candles);
  const liveEntryBar = entryCandles.length > 0 ? entryCandles[entryCandles.length - 1] : null;
  const price = liveEntryBar
    ? liveEntryBar.close
    : structure.length > 0
      ? structure[structure.length - 1].close
      : 0;
  const now = Date.now();

  const noEntryConfirmation: TrendlineInstrumentAnalysis['entryConfirmation'] = {
    confirmed: false,
    kind: 'NONE',
    timeframe: 'M1',
    time: 0,
    close: 0,
    strength: 0,
    agreesWithTrend: false,
    reason: 'Awaiting M1 data for a precise entry trigger.',
  };

  const empty: TrendlineInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    condition: 'CHOPPY',
    conditionExplanation: 'Insufficient confirmed M15 structure.',
    structureLabel: 'Awaiting data',
    alignment: {
      dominantTrend: 'RANGING',
      structureLabel: 'Awaiting data',
      tradableDirection: null,
      trendConfirmed: false,
      reversalConfirmed: false,
      reason: 'Awaiting sufficient M15 structure before a dominant trend can be established.',
      continuationBos: null,
    },
    setupZones: [],
    trendlines: [],
    range: null,
    bestCandidate: null,
    signal: null,
    allCandidates: [],
    rejection: { confirmed: false, kind: 'NONE', time: 0, wickPrice: 0, close: 0, strength: 0, reason: 'No data.' },
    entryConfirmation: noEntryConfirmation,
    structureTimeframe: STRUCTURE_TF,
    setupTimeframe: SETUP_TF,
    entryTimeframe: ENTRY_TF,
    atr: 0,
    dataHealth,
    lastUpdated: now,
    rejectionReason:
      dataHealth !== 'HEALTHY'
        ? `Live market data feed is ${dataHealth.toLowerCase()}.`
        : 'Insufficient confirmed M15 / M5 candles for trendline analysis.',
  };

  if (structure.length < 30 || entry.length < 12 || !liveEntryBar || dataHealth !== 'HEALTHY') {
    return empty;
  }

  const structureAtr = trendlineAtr(structure, 14);
  const entryAtr = trendlineAtr(entry, 14);
  const m1Atr = m1.length >= 4 ? trendlineAtr(m1, 14) : 0;
  const swings = detectSwings(structure, 3, 3);
  const marketStructure = analyzeMarketStructure(
    structure,
    swings,
    computeAtrSeries(structure, 14),
    precision
  );
  const trendlines = detectTrendlines(structure, swings, structureAtr, precision);

  // Sideways range (reused from the shared range module) informs the condition and
  // supplies opposing boundaries for target resolution.
  const rangeAnalysis = detectRangeAnalysis(structureCandles, price);
  const rangeValid = rangeAnalysis?.valid ?? false;
  const rangeZone = rangeAnalysis?.zone ?? null;

  const sr = detectSupportResistance(structure, swings, structureAtr, precision);
  const supplyDemand = detectSupplyDemandZones(structure, computeAtrSeries(structure, 14), precision);
  const momentum = assessMomentum({
    candles: entry.length >= 20 ? entry : structure,
    atr: entryAtr,
    supportResistance: sr,
    supplyDemand,
  });

  const { condition, explanation } = classifyTrendlineCondition({
    candles: structure,
    trendlines,
    structureDirection: marketStructure.direction,
    structureSequence: marketStructure.swingStructureSequence,
    overlapRatio: overlapRatio(entry),
    rangeZone,
    rangeValid,
  });

  // TREND ALIGNMENT runs first: it decides whether the module may search at all and, if
  // so, in which direction. An uptrend searches RISE only, a downtrend FALL only, and a
  // range / unclear direction produces WAIT.
  const alignment = evaluateTrendAlignment({
    structureCandles: structure,
    structureDirection: marketStructure.direction,
    structureSequence: marketStructure.swingStructureSequence,
    breaks: marketStructure.breaks,
    atr: structureAtr,
    precision,
  });

  const lastStructureTime = structure[structure.length - 1].time;
  const setupZones = buildTrendSetupZones({
    price,
    atr: structureAtr,
    precision,
    alignment,
    trendlines,
    supportResistance: sr,
    supplyDemand,
    lastTime: lastStructureTime,
  });

  const ctx = {
    symbol,
    precision,
    condition,
    alignment,
    setupZones,
    structureCandles: structure,
    entryCandles,
    m1Candles,
    structureAtr,
    entryAtr,
    m1Atr,
    trendlines,
    structureSwings: swings,
    structureDirection: marketStructure.direction,
    supportResistance: sr,
    supplyDemand,
    range:
      rangeAnalysis && rangeValid
        ? { support: rangeAnalysis.support, resistance: rangeAnalysis.resistance }
        : null,
    momentumStrongBullish: momentum.state === 'STRONG_BULLISH',
    momentumStrongBearish: momentum.state === 'STRONG_BEARISH',
  };

  const candidate = detectTrendlineCandidate(ctx);
  const allCandidates: TrendlineCandidate[] = candidate ? [candidate] : [];
  const publishable = candidate ? isPublishable(candidate) : false;

  let signal: TrendlineSignal | null = null;
  if (candidate && publishable) {
    signal = buildSignal({
      candidate,
      symbol,
      displayName,
      marketFamily,
      precision,
      condition,
      confirmedBarTime: liveEntryBar.time,
      now,
    });
  }

  const rejection: TrendlineRejection =
    candidate?.rejection ?? {
      confirmed: false,
      kind: 'NONE',
      time: 0,
      wickPrice: 0,
      close: 0,
      strength: 0,
      reason: 'No confirmed rejection on the current M5 bars.',
    };

  const entryConfirmation: TrendlineInstrumentAnalysis['entryConfirmation'] =
    candidate?.entryConfirmation ?? noEntryConfirmation;

  const rejectionReason = publishable
    ? undefined
    : candidate
      ? `Best trendline candidate scored ${candidate.scores.total}/100 — below the 85 publication minimum.`
      : alignment.tradableDirection === null
        ? `WAIT — ${alignment.reason}`
        : condition === 'CHOPPY'
          ? 'Choppy / low-quality market — no valid trendline setup.'
          : `No trend-aligned ${alignment.tradableDirection} rejection at a valid boundary — waiting for confirmation.`;

  return {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    condition,
    conditionExplanation: explanation,
    structureLabel: marketStructure.structureLabel,
    alignment,
    setupZones,
    trendlines,
    range:
      rangeAnalysis && rangeValid
        ? {
            support: rangeAnalysis.support,
            resistance: rangeAnalysis.resistance,
            equilibrium: rangeAnalysis.equilibrium,
            zone: rangeAnalysis.zone,
          }
        : null,
    bestCandidate: candidate,
    signal,
    allCandidates,
    rejection,
    entryConfirmation,
    structureTimeframe: STRUCTURE_TF,
    setupTimeframe: SETUP_TF,
    entryTimeframe: ENTRY_TF,
    atr: structureAtr,
    dataHealth,
    lastUpdated: now,
    rejectionReason,
  };
}

function overlapRatio(candles: readonly Candle[]): number {
  const window = candles.slice(-12);
  if (window.length === 0) return 0;
  const avgRange = window.reduce((a, c) => a + Math.max(1e-9, c.high - c.low), 0) / window.length;
  const avgBody = window.reduce((a, c) => a + Math.abs(c.close - c.open), 0) / window.length;
  return avgRange > 0 ? Number((avgBody / avgRange).toFixed(2)) : 0;
}

function buildSignal(params: {
  candidate: TrendlineCandidate;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  condition: TrendlineInstrumentAnalysis['condition'];
  confirmedBarTime: number;
  now: number;
}): TrendlineSignal {
  const { candidate, symbol, displayName, marketFamily, precision, condition, confirmedBarTime, now } =
    params;
  return {
    id: `tl-${symbol}-${candidate.model}-${candidate.direction}-${confirmedBarTime}`,
    symbol,
    displayName,
    marketFamily,
    precision,
    direction: candidate.direction,
    model: candidate.model,
    modelLabel: candidate.modelLabel,
    condition,
    structureTimeframe: STRUCTURE_TF,
    entryTimeframe: ENTRY_TF,
    score: candidate.scores.total,
    entryPrice: candidate.entryPrice,
    stopLoss: candidate.stopLoss,
    takeProfit: candidate.takeProfit,
    invalidationPrice: candidate.invalidationPrice,
    invalidationCondition: candidate.invalidationCondition,
    riskRewardRatio: candidate.riskRewardRatio,
    trendline: candidate.trendline,
    rejection: candidate.rejection,
    zone: candidate.zone,
    entryConfirmation: candidate.entryConfirmation,
    continuationBos: candidate.continuationBos,
    reasons: candidate.reasons,
    confirmations: candidate.confirmations,
    m15Context: candidate.m15Context,
    m5Confirmation: candidate.m5Confirmation,
    m1Confirmation: candidate.m1Confirmation,
    status: 'CONFIRMED',
    createdAt: now,
    confirmedBarTime,
    lastUpdated: now,
  };
}

/**
 * Compares qualifying opportunities across the scanned markets and selects the
 * SINGLE strongest confirmed trendline signal (highest score, then best R:R).
 */
export function selectStrongestTrendline(
  analyses: readonly TrendlineInstrumentAnalysis[]
): TrendlineScanSummary {
  const confirmed = analyses.filter((a) => a.signal !== null);
  const opportunities = confirmed
    .map((a) => a.signal as TrendlineSignal)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.riskRewardRatio - a.riskRewardRatio;
    });

  const winner = opportunities[0] ?? null;
  const winnerAnalysis = winner
    ? confirmed.find((a) => a.signal?.id === winner.id) ?? null
    : null;

  return {
    winner,
    winnerAnalysis,
    opportunities,
    scannedCount: analyses.length,
    confirmedCount: confirmed.length,
    scannedAt: Date.now(),
    statusBanner: winner
      ? `TRENDLINE SIGNAL CONFIRMED — ${winner.displayName} ${winner.direction} · ${winner.modelLabel}`
      : analyses.length > 0 && analyses.every((a) => a.alignment.tradableDirection === null)
        ? 'WAIT — NO DOMINANT TREND ACROSS SCANNED MARKETS.'
        : 'NO TREND-ALIGNED REJECTION CONFIRMED — WAITING FOR CONFIRMATION.',
    structureTimeframe: STRUCTURE_TF,
    setupTimeframe: SETUP_TF,
    entryTimeframe: ENTRY_TF,
  };
}

/** Status derived from price action for a managed trendline signal (invalidation). */
export function trendlineSignalStatus(
  signal: TrendlineSignal,
  candles: readonly Candle[]
): TrendlineSignal['status'] {
  if (candles.length === 0) return signal.status;
  const isRise = signal.direction === 'RISE';
  for (const bar of candles) {
    if (bar.time < signal.confirmedBarTime) continue;
    const hitStop = isRise ? bar.close < signal.stopLoss : bar.close > signal.stopLoss;
    if (hitStop) return 'INVALIDATED';
    const hitTarget = isRise ? bar.high >= signal.takeProfit : bar.low <= signal.takeProfit;
    if (hitTarget) return 'COMPLETED';
  }
  return signal.status === 'CONFIRMED' ? 'ACTIVE' : signal.status;
}

export { TRENDLINE_MODEL_LABELS };
