import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  ladderTimeframeReads,
  timeframeConditionRead,
  makeZone,
  readAiCondition,
} from './aiCommon';
import { evaluateBosRetracement, type BosRetracementResult } from './bosRetracement';
import { BOS_SETUP_STATE_LABELS } from '../types/bosRetracement';
import { confirmedOnly } from './trendlineDetection';
import { computeAtrSeries, detectSwings } from './swings';
import { analyzeMarketStructure } from './structure';
import type {
  AiDirection,
  AiInstrumentAnalysis,
  AiSignal,
  AiSignalStatus,
  AiTimeframeRead,
  AiZone,
} from '../types/aiModule';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import { formatPrice } from '../utils/derivParser';

/**
 * BOS RETRACEMENT & REJECTION AI — market-structure intelligence module.
 *
 * A BOS is a SETUP DETECTOR, never an automatic entry trigger. This module validates the
 * external break (confirmed swings, decisive closes, displacement — wick-only breaks are
 * ignored), separates continuation BOS from reversal CHoCH/MSS, locks the dealing range to
 * the protected swing, then waits for a discount/premium retracement, a genuine liquidity
 * sweep, a decisive rejection and a lower-timeframe MSS before publishing ONE entry.
 *
 * The module owns its own decision path (`bosRetracement.ts`); the shared scanner only
 * supplies the five synchronized candle series. It never copies another module's signal.
 */

export const BOS_CHOCH_PUBLICATION_MIN_SCORE = 85;

export const BOS_CHOCH_MODEL_LABELS: Record<string, string> = {
  BOS_RETRACEMENT_REJECTION: 'BOS Retracement & Rejection',
};

export interface BosChochEngineParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  structureCandles: readonly Candle[];
  setupCandles: readonly Candle[];
  entryCandles: readonly Candle[];
  /** M7 (trend & structure) candles — optional. */
  trendCandles?: readonly Candle[];
  /** M3 (entry confirmation) candles — optional. */
  confirmCandles?: readonly Candle[];
  /** ALL TEN analysis timeframes for this index (M30/M15/M10/M7/M6/M5/M4/M3/M2/M1). */
  candlesByTimeframe?: Partial<Record<TimeframeKey, readonly Candle[]>>;
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
}

/** Maps the module's lifecycle state onto the shared status vocabulary. */
function statusFromState(state: BosRetracementResult['state']): AiSignalStatus {
  switch (state) {
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'WAITING_FOR_PULLBACK':
      return 'WAITING_FOR_PULLBACK';
    case 'IN_ZONE':
      return 'IN_ZONE';
    case 'REJECTION':
      return 'REJECTION';
    case 'CONFIRMATION':
      return 'CONFIRMATION';
    case 'BOS_DETECTED':
      return 'BOS_DETECTED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'NO_VALID_SETUP';
  }
}

/** The HTF (M7 when supplied, else M15) directional read that gates the setup. */
function htfDirectionOf(candles: readonly Candle[]): AiDirection | null {
  const read = readAiCondition(confirmedOnly(candles), aiAtr(candles));
  if (read.bias === 'bullish') return 'RISE';
  if (read.bias === 'bearish') return 'FALL';
  return null;
}

export function analyzeBosChochInstrument(params: BosChochEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth } = params;
  const structure = confirmedOnly(params.structureCandles);
  const setup = confirmedOnly(params.setupCandles);
  const entry = confirmedOnly(params.entryCandles);

  const lastOf = (arr: readonly Candle[]) => (arr.length ? arr[arr.length - 1] : null);
  const price = lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastOf(structure)?.close ?? 0;
  const atr = aiAtr(structure.length ? structure : setup);
  const condition = readAiCondition(structure, atr);

  const swings = detectSwings(structure, 3, 3);
  const ms = analyzeMarketStructure(structure, swings, computeAtrSeries(structure), precision);
  const structureBias =
    ms.direction === 'BULLISH' ? 'bullish' : ms.direction === 'BEARISH' ? 'bearish' : 'neutral';

  const base: AiInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status: 'ANALYSING',
    statusExplanation: 'Reading market structure…',
    condition: condition.condition,
    timeframes: [],
    signal: null,
    activeZones: [],
    watchZones: [],
    bestScore: 0,
    atr,
    dataHealth,
    lastUpdated: Date.now(),
  };

  if (structure.length < 30 || entry.length < 5 || atr <= 0) {
    return {
      ...base,
      status: 'ANALYSING',
      statusExplanation: 'Insufficient confirmed candles for a structure read.',
      rejectionReason: 'Not enough data.',
    };
  }

  const htfSource =
    params.trendCandles && params.trendCandles.length >= 30 ? params.trendCandles : structure;
  const htfDirection = htfDirectionOf(htfSource);

  const result = evaluateBosRetracement({
    symbol,
    precision,
    marketFamily,
    // The evaluator applies `confirmedOnly` itself — pass the raw series so a bar is never
    // stripped twice (which would hide the rejection / MSS candle the setup depends on).
    structureCandles: params.structureCandles,
    setupCandles: params.setupCandles,
    entryCandles: params.entryCandles,
    trendCandles: params.trendCandles,
    confirmCandles: params.confirmCandles,
    htfDirection,
  });

  const readout = result.readout;
  const direction: AiDirection =
    readout?.direction ?? (structureBias === 'bearish' ? 'FALL' : 'RISE');
  const gate = BOS_CHOCH_PUBLICATION_MIN_SCORE;
  const bestScore = result.score;
  const state = result.state;
  const signalReady = result.trade !== null && bestScore >= gate;

  const trendRead = params.trendCandles
    ? timeframeConditionRead(params.trendCandles, 'M7 trend & structure')
    : null;
  const confirmRead = params.confirmCandles
    ? timeframeConditionRead(params.confirmCandles, 'M3 confirmation')
    : null;

  const timeframes: AiTimeframeRead[] = buildTimeframeReads({
    m7: trendRead?.detail,
    m7Tone: trendRead?.tone,
    m3: confirmRead?.detail,
    m3Tone: confirmRead?.tone,
    m15: ms.structureLabel
      ? `${ms.structureLabel}${
          result.event
            ? ` · ${result.event.kind === 'REVERSAL' ? 'reversal CHoCH/MSS' : 'continuation BOS'} at ${formatPrice(result.event.brokenLevel, precision)}`
            : ''
        }`
      : 'No clear M15 structure.',
    m15Tone: structureBias === 'bullish' ? 'bull' : structureBias === 'bearish' ? 'bear' : 'neutral',
    m5: readout
      ? `${BOS_SETUP_STATE_LABELS[state]}${
          readout.entryZone
            ? ` — zone ${formatPrice(readout.entryZone.low, precision)}–${formatPrice(readout.entryZone.high, precision)}`
            : ''
        }.`
      : 'No structure retest in play.',
    m5Tone:
      state === 'CONFIRMED'
        ? 'bull'
        : state === 'IN_ZONE' || state === 'REJECTION' || state === 'CONFIRMATION'
          ? 'warn'
          : 'neutral',
    m1: readout?.ltf
      ? readout.ltf.reason
      : readout?.rejection
        ? 'Rejection printed; awaiting the lower-timeframe MSS.'
        : 'No lower-timeframe confirmation yet.',
    m1Tone: readout?.ltf ? 'bull' : 'neutral',
    ladder: ladderTimeframeReads(params.candlesByTimeframe),
  });

  let signal: AiSignal | null = null;
  if (signalReady && result.trade) {
    const t = result.trade;
    signal = buildAiSignal({
      id: `${symbol}-BOS_RETRACEMENT_REJECTION-${t.confirmedBarTime}`,
      symbol,
      displayName,
      marketFamily,
      precision,
      direction: t.direction,
      modelId: 'BOS_RETRACEMENT_REJECTION',
      modelLabel: BOS_CHOCH_MODEL_LABELS.BOS_RETRACEMENT_REJECTION,
      strategyLabel: 'BOS retracement & rejection',
      status: 'CONFIRMED',
      score: Math.round(bestScore),
      condition: condition.condition,
      entryPrice: t.entry,
      entryZoneLow: readout?.entryZone ? readout.entryZone.low : t.entry - atr * 0.2,
      entryZoneHigh: readout?.entryZone ? readout.entryZone.high : t.entry + atr * 0.2,
      stopLoss: t.stop,
      takeProfit1: t.tp1,
      takeProfit2: t.tp2,
      takeProfit3: t.tp3,
      invalidationCondition:
        t.direction === 'RISE'
          ? `A close back below the protected swing at ${formatPrice(readout?.range.low ?? t.stop, precision)} invalidates the bullish BOS retracement.`
          : `A close back above the protected swing at ${formatPrice(readout?.range.high ?? t.stop, precision)} invalidates the bearish BOS retracement.`,
      reasons: t.reasons,
      confirmations: t.confirmations,
      timeframes,
      confirmedBarTime: t.confirmedBarTime,
    });
  }

  const zones = result.zones;
  const status = signal ? 'CONFIRMED' : statusFromState(state);
  const statusExplanation = signal
    ? `${signal.direction} confirmed — ${signal.modelLabel} at ${formatPrice(signal.entryPrice, precision)}.`
    : result.statusExplanation;

  return {
    ...base,
    status,
    statusExplanation,
    timeframes,
    signal,
    activeZones: zones.filter((z) => !z.watch),
    watchZones: zones.filter((z) => z.watch),
    bestScore: Math.round(bestScore),
    detail: readout ?? undefined,
    rejectionReason: signal
      ? undefined
      : result.rejectionReason ??
        (readout
          ? `Setup state ${BOS_SETUP_STATE_LABELS[state]} — score ${Math.round(bestScore)}/100.`
          : 'No valid structure setup.'),
  };
}

/** Engine factory bound to the shared scanner. */
export const bosChochEngine = analyzeBosChochInstrument;
