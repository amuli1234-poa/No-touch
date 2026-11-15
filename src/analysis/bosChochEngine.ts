import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  clamp,
  makeZone,
  orderTargets,
  readAiCondition,
  statusForScore,
} from './aiCommon';
import { analyzeMarketStructure, type StructureAnalysisResult } from './structure';
import { computeAtrSeries, detectSwings, getCandleStats } from './swings';
import { confirmedOnly } from './trendlineDetection';
import type {
  AiDirection,
  AiInstrumentAnalysis,
  AiSignal,
  AiTimeframeRead,
  AiZone,
} from '../types/aiModule';
import type { Candle, MarketFamily } from '../types/market';
import { formatPrice } from '../utils/derivParser';

/**
 * BOS & CHOCH AI — market-structure intelligence module.
 *
 * Independent engine: it reads M15 structure (BOS / CHOCH / protected levels / swing
 * sequence), develops the retest on M5 and confirms on M1. It never copies another
 * module's signal — structure is read here, from the candles, every pass.
 */

export const BOS_CHOCH_PUBLICATION_MIN_SCORE = 85;

export const BOS_CHOCH_MODEL_LABELS: Record<string, string> = {
  BOS_CONTINUATION_RETEST: 'BOS Continuation Retest',
  CHOCH_REVERSAL_RETEST: 'CHOCH Reversal Retest',
  M1_BOS_CONFIRMATION: 'M1 BOS Confirmation',
  PROTECTED_LEVEL_BREAK: 'Protected Level Break',
  RANGE_BREAK_RETEST: 'Range Break & Retest',
};

export interface BosChochEngineParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  structureCandles: readonly Candle[];
  setupCandles: readonly Candle[];
  entryCandles: readonly Candle[];
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
}

interface SetupDraft {
  modelId: string;
  direction: AiDirection;
  level: number;
  levelTime: number;
  entry: number;
  stop: number;
  targets: number[];
  score: number;
  reasons: string[];
  confirmations: string[];
  confirmed: boolean;
  confirmationTime: number;
}

/** Body-close confirmation on the entry timeframe (M1). */
function m1Confirmation(
  entry: readonly Candle[],
  direction: AiDirection,
  level: number,
  atr: number
): { confirmed: boolean; time: number; detail: string } {
  for (let i = entry.length - 1; i >= Math.max(0, entry.length - 6); i--) {
    const bar = entry[i];
    const stats = getCandleStats(bar);
    const beyond = direction === 'RISE' ? bar.close - level : level - bar.close;
    const bodyOk = direction === 'RISE' ? stats.isBullish : stats.isBearish;
    if (bodyOk && beyond >= atr * 0.05) {
      return {
        confirmed: true,
        time: bar.time,
        detail: `M1 body closed ${
          direction === 'RISE' ? 'above' : 'below'
        } ${formatPrice(level, 2)} with ${
          direction === 'RISE' ? 'bullish' : 'bearish'
        } conviction.`,
      };
    }
  }
  return { confirmed: false, time: 0, detail: 'M1 has not yet closed beyond the level.' };
}

function protectedLevels(ms: StructureAnalysisResult): { high: number | null; low: number | null } {
  return {
    high: ms.lastSwingHigh?.price ?? null,
    low: ms.lastSwingLow?.price ?? null,
  };
}

export function analyzeBosChochInstrument(params: BosChochEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth } = params;
  const structure = confirmedOnly(params.structureCandles);
  const setup = confirmedOnly(params.setupCandles);
  const entry = confirmedOnly(params.entryCandles);

  const lastOf = (arr: readonly Candle[]) => (arr.length ? arr[arr.length - 1] : null);
  const price =
    lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastOf(structure)?.close ?? 0;
  const atr = aiAtr(structure.length ? structure : setup);
  const condition = readAiCondition(structure, atr);

  const swings = detectSwings(structure, 3, 3);
  const atrs = computeAtrSeries(structure);
  const ms = analyzeMarketStructure(structure, swings, atrs, precision);

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

  const { high: protectedHigh, low: protectedLow } = protectedLevels(ms);
  const latest = ms.latestBreak;
  const structureBias =
    ms.direction === 'BULLISH' ? 'bullish' : ms.direction === 'BEARISH' ? 'bearish' : 'neutral';

  // ---- Chart zones: the broken level (retest zone) + the next protected level ----
  const zones: AiZone[] = [];
  if (latest) {
    const dir: AiDirection = latest.direction === 'bullish' ? 'RISE' : 'FALL';
    const half = atr * 0.3;
    const isBos = latest.kind === 'BOS';
    zones.push(
      makeZone({
        id: `bos-choch-${latest.id}`,
        direction: dir,
        label: isBos ? `${latest.kind} retest` : `${latest.kind} reversal`,
        upperPrice: latest.brokenLevel + half,
        lowerPrice: latest.brokenLevel - half,
        quality: clamp(70 + (latest.momentumConfirmed ? 15 : 0), 0, 100),
        fresh: true,
        watch: price > latest.brokenLevel + half || price < latest.brokenLevel - half,
        reason: latest.reason,
      })
    );
  }
  if (protectedHigh !== null) {
    zones.push(
      makeZone({
        id: `bos-protected-high-${protectedHigh}`,
        direction: 'FALL',
        label: 'Protected high',
        upperPrice: protectedHigh + atr * 0.15,
        lowerPrice: protectedHigh - atr * 0.15,
        quality: 60,
        fresh: true,
        watch: price < protectedHigh,
        reason: `Protected high at ${formatPrice(
          protectedHigh,
          precision
        )} — a break here flips structure bullish; rejection keeps the downside.`,
      })
    );
  }
  if (protectedLow !== null) {
    zones.push(
      makeZone({
        id: `bos-protected-low-${protectedLow}`,
        direction: 'RISE',
        label: 'Protected low',
        upperPrice: protectedLow + atr * 0.15,
        lowerPrice: protectedLow - atr * 0.15,
        quality: 60,
        fresh: true,
        watch: price > protectedLow,
        reason: `Protected low at ${formatPrice(
          protectedLow,
          precision
        )} — a break here flips structure bearish; a hold supports the upside.`,
      })
    );
  }

  // ---- Setup search ----
  const drafts: SetupDraft[] = [];
  const swingTargets = (direction: AiDirection): number[] => {
    const highs = swings.filter((s) => s.type === 'high').map((s) => s.price);
    const lows = swings.filter((s) => s.type === 'low').map((s) => s.price);
    return direction === 'RISE' ? [...highs, protectedHigh ?? 0].filter(Boolean) : [...lows, protectedLow ?? 0].filter(Boolean);
  };

  if (latest) {
    const direction: AiDirection = latest.direction === 'bullish' ? 'RISE' : 'FALL';
    const conf = m1Confirmation(entry, direction, latest.brokenLevel, atr);
    const entryPrice = latest.brokenLevel;
    const stop = direction === 'RISE' ? latest.brokenLevel - atr * 1.1 : latest.brokenLevel + atr * 1.1;
    const targets = orderTargets(direction, entryPrice, swingTargets(direction)).slice(0, 3);
    const continuation = structureBias === (direction === 'RISE' ? 'bullish' : 'bearish');
    const score = clamp(
      55 +
        (latest.momentumConfirmed ? 12 : 0) +
        (continuation ? 12 : 0) +
        (latest.kind === 'CHOCH' ? 6 : 8) +
        (conf.confirmed ? 12 : 0) +
        (targets.length >= 2 ? 6 : 2),
      0,
      100
    );
    drafts.push({
      modelId: latest.kind === 'BOS' ? 'BOS_CONTINUATION_RETEST' : 'CHOCH_REVERSAL_RETEST',
      direction,
      level: latest.brokenLevel,
      levelTime: latest.time,
      entry: entryPrice,
      stop,
      targets,
      score,
      reasons: [
        latest.reason,
        continuation
          ? `Break agrees with the M15 ${structureBias} structure — continuation favoured.`
          : 'Break runs counter to the dominant M15 structure — treat as a reversal attempt.',
        conf.detail,
      ],
      confirmations: [latest.momentumConfirmed ? 'Momentum-confirmed displacement' : 'Moderate displacement'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || latest.time,
    });
  }

  // Protected-level break model.
  if (protectedHigh !== null && price > protectedHigh && structureBias !== 'bearish') {
    const conf = m1Confirmation(entry, 'RISE', protectedHigh, atr);
    const targets = orderTargets('RISE', price, swingTargets('RISE')).slice(0, 3);
    drafts.push({
      modelId: 'PROTECTED_LEVEL_BREAK',
      direction: 'RISE',
      level: protectedHigh,
      levelTime: latest?.time ?? structure[structure.length - 1].time,
      entry: price,
      stop: protectedHigh - atr * 1.1,
      targets,
      score: clamp(58 + (conf.confirmed ? 14 : 0) + (targets.length >= 2 ? 8 : 2), 0, 100),
      reasons: [
        `Price is trading above the protected high at ${formatPrice(protectedHigh, precision)}.`,
        'A break of the protected high is bullish while it holds as support.',
        conf.detail,
      ],
      confirmations: ['Protected-level break'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
    });
  }
  if (protectedLow !== null && price < protectedLow && structureBias !== 'bullish') {
    const conf = m1Confirmation(entry, 'FALL', protectedLow, atr);
    const targets = orderTargets('FALL', price, swingTargets('FALL')).slice(0, 3);
    drafts.push({
      modelId: 'PROTECTED_LEVEL_BREAK',
      direction: 'FALL',
      level: protectedLow,
      levelTime: latest?.time ?? structure[structure.length - 1].time,
      entry: price,
      stop: protectedLow + atr * 1.1,
      targets,
      score: clamp(58 + (conf.confirmed ? 14 : 0) + (targets.length >= 2 ? 8 : 2), 0, 100),
      reasons: [
        `Price is trading below the protected low at ${formatPrice(protectedLow, precision)}.`,
        'A break of the protected low is bearish while it holds as resistance.',
        conf.detail,
      ],
      confirmations: ['Protected-level break'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
    });
  }

  // Range break & retest model.
  if (condition.condition === 'RANGING' || condition.condition === 'CONSOLIDATION') {
    const window = structure.slice(-40);
    const rangeHigh = Math.max(...window.map((c) => c.high));
    const rangeLow = Math.min(...window.map((c) => c.low));
    if (price > rangeHigh) {
      const conf = m1Confirmation(entry, 'RISE', rangeHigh, atr);
      drafts.push({
        modelId: 'RANGE_BREAK_RETEST',
        direction: 'RISE',
        level: rangeHigh,
        levelTime: structure[structure.length - 1].time,
        entry: price,
        stop: rangeHigh - atr * 1.2,
        targets: orderTargets('RISE', price, swingTargets('RISE')).slice(0, 3),
        score: clamp(60 + (conf.confirmed ? 12 : 0), 0, 100),
        reasons: [
          `Range high ${formatPrice(rangeHigh, precision)} broken — breakout continuation.`,
          conf.detail,
        ],
        confirmations: ['Range break'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
      });
    } else if (price < rangeLow) {
      const conf = m1Confirmation(entry, 'FALL', rangeLow, atr);
      drafts.push({
        modelId: 'RANGE_BREAK_RETEST',
        direction: 'FALL',
        level: rangeLow,
        levelTime: structure[structure.length - 1].time,
        entry: price,
        stop: rangeLow + atr * 1.2,
        targets: orderTargets('FALL', price, swingTargets('FALL')).slice(0, 3),
        score: clamp(60 + (conf.confirmed ? 12 : 0), 0, 100),
        reasons: [
          `Range low ${formatPrice(rangeLow, precision)} broken — breakdown continuation.`,
          conf.detail,
        ],
        confirmations: ['Range break'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
      });
    }
  }

  const best = drafts.sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = BOS_CHOCH_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate);

  const timeframes: AiTimeframeRead[] = buildTimeframeReads({
    m15: ms.structureLabel
      ? `${ms.structureLabel}${latest ? ` · latest ${latest.kind} (${latest.direction})` : ''}`
      : 'No clear M15 structure.',
    m15Tone: structureBias === 'bullish' ? 'bull' : structureBias === 'bearish' ? 'bear' : 'neutral',
    m5: best
      ? `Setup developing at ${formatPrice(best.level, precision)} — ${
          best.confirmed ? 'confirmation present.' : 'awaiting confirmation.'
        }`
      : 'No structure retest in play.',
    m5Tone: best ? (best.confirmed ? 'bull' : 'warn') : 'neutral',
    m1: best ? (best.confirmed ? 'M1 confirmed the structural break.' : 'M1 confirmation pending.') : 'No M1 confirmation.',
    m1Tone: best?.confirmed ? 'bull' : 'neutral',
  });

  let signal: AiSignal | null = null;
  if (best && bestScore >= gate && best.confirmed) {
    const tp = best.targets;
    signal = buildAiSignal({
      id: `${symbol}-${best.modelId}-${best.confirmationTime}`,
      symbol,
      displayName,
      marketFamily,
      precision,
      direction: best.direction,
      modelId: best.modelId,
      modelLabel: BOS_CHOCH_MODEL_LABELS[best.modelId] ?? best.modelId,
      strategyLabel: 'Structure break & retest',
      status: 'CONFIRMED',
      score: Math.round(bestScore),
      condition: condition.condition,
      entryPrice: best.entry,
      entryZoneLow: best.entry - atr * 0.2,
      entryZoneHigh: best.entry + atr * 0.2,
      stopLoss: best.stop,
      takeProfit1: tp[0] ?? best.entry + (best.direction === 'RISE' ? atr * 2 : -atr * 2),
      takeProfit2: tp[1] ?? best.entry + (best.direction === 'RISE' ? atr * 3.5 : -atr * 3.5),
      takeProfit3: tp[2] ?? null,
      invalidationCondition:
        best.direction === 'RISE'
          ? `A close back below the broken level at ${formatPrice(best.level, precision)} invalidates the bullish structure.`
          : `A close back above the broken level at ${formatPrice(best.level, precision)} invalidates the bearish structure.`,
      reasons: best.reasons,
      confirmations: best.confirmations,
      timeframes,
      confirmedBarTime: best.confirmationTime,
    });
  }

  const statusExplanation = signal
    ? `${signal.direction} confirmed — ${signal.modelLabel} at ${formatPrice(
        signal.entryPrice,
        precision
      )}.`
    : best
      ? `Structure break detected at ${formatPrice(
          best.level,
          precision
        )}; score ${Math.round(bestScore)}/100 — ${
          best.confirmed ? 'awaiting the publication gate.' : 'waiting for M1 confirmation.'
        }`
      : `${ms.structureLabel || 'No clear structure'} — no valid structural retest to trade.`;

  return {
    ...base,
    status: signal ? 'CONFIRMED' : status,
    statusExplanation,
    timeframes,
    signal,
    activeZones: zones.filter((z) => !z.watch),
    watchZones: zones.filter((z) => z.watch),
    bestScore: Math.round(bestScore),
    rejectionReason:
      signal || !best
        ? undefined
        : `Best structure setup scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

/** Engine factory bound to the shared scanner. */
export const bosChochEngine = analyzeBosChochInstrument;
