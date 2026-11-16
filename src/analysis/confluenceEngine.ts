import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  ladderTimeframeReads,
  timeframeConditionRead,
  makeZone,
  resolveTargets,
  readAiCondition,
} from './aiCommon';
import { verifyPeerEvidence, type PeerEvidence } from './peerValidation';
import { analyzeMarketStructure } from './structure';
import { computeAtrSeries, detectSwings } from './swings';
import { detectFvgs, detectLiquidityPools, detectOrderBlocks, detectSweeps } from './smcTools';
import { confirmedOnly } from './trendlineDetection';
import type { AiInstrumentAnalysis, AiTimeframeRead, AiZone } from '../types/aiModule';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';

/**
 * CONFLUENCE & TRADE VALIDATION AI — decision engine.
 *
 * It consumes other modules' published signals as *evidence*, then INDEPENDENTLY re-verifies
 * each one against the live candles (see `peerValidation`). It does not count modules;
 * correlated evidence is de-duplicated by entry model. If nothing passes it reports
 * NO HIGH-QUALITY TRADE AVAILABLE.
 */

export const CONFLUENCE_PUBLICATION_MIN_SCORE = 88;

export interface ConfluenceEngineParams {
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
  /** Published signals from every other module for THIS index only. */
  peers: readonly PeerEvidence[];
}

export function analyzeConfluenceInstrument(params: ConfluenceEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth, peers } = params;
  const structure = confirmedOnly(params.structureCandles);
  const setup = confirmedOnly(params.setupCandles);
  const entry = confirmedOnly(params.entryCandles);

  const lastOf = (arr: readonly Candle[]) => (arr.length ? arr[arr.length - 1] : null);
  const price = lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastOf(structure)?.close ?? 0;
  const atr = aiAtr(setup.length ? setup : structure);
  const condition = readAiCondition(structure, aiAtr(structure));

  const base: AiInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status: 'ANALYSING',
    statusExplanation: 'Collecting and verifying evidence…',
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

  if (setup.length < 30 || entry.length < 5 || atr <= 0) {
    return {
      ...base,
      statusExplanation: 'Insufficient confirmed candles for validation.',
      rejectionReason: 'Not enough data.',
    };
  }

  const swings = detectSwings(setup, 3, 3);
  const ms = analyzeMarketStructure(setup, swings, computeAtrSeries(setup), precision);
  const fvgs = detectFvgs(setup, atr, precision, price);
  const obs = detectOrderBlocks(setup, atr, precision, price);
  const pools = detectLiquidityPools(setup, atr, precision, price);
  const sweeps = detectSweeps(setup, pools, atr, precision);
  const latestSweep = sweeps.find((s) => s.genuine) ?? null;

  const result = verifyPeerEvidence({
    peers,
    price,
    atr,
    precision,
    condition: condition.condition,
    bias: condition.bias,
    fvgs,
    obs,
    latestSweep,
    latestBreak: ms.latestBreak,
    opposingPools: pools,
  });

  const { verified, conflicts, chosen, confluenceScore, grade, best } = result;

  // ---- Build the trade from the best peer's levels, re-derived structurally ----
  let signal: AiInstrumentAnalysis['signal'] = null;
  if (chosen && confluenceScore >= CONFLUENCE_PUBLICATION_MIN_SCORE && verified.some((v) => v.direction === chosen)) {
    const chosenEvidence = verified.filter((v) => v.direction === chosen).sort((a, b) => b.score - a.score);
    const entryPrice = best ? best.entryPrice : price;
    const stop = best ? best.stopLoss : chosen === 'RISE' ? price - atr * 1.5 : price + atr * 1.5;
    // Anchor targets to the actual entry (a peer's entry can be a zone boundary ≠ price).
    const structuralTargets = resolveTargets(
      chosen,
      entryPrice,
      (chosen === 'RISE'
        ? pools.filter((p) => p.side === 'BSL').map((p) => p.price)
        : pools.filter((p) => p.side === 'SSL').map((p) => p.price)
      ).concat(swings.filter((s) => (chosen === 'RISE' ? s.type === 'high' : s.type === 'low')).map((s) => s.price)),
      atr
    );

    const tp1 = structuralTargets[0] ?? (chosen === 'RISE' ? entryPrice + atr * 2 : entryPrice - atr * 2);
    const tp2 = structuralTargets[1] ?? (chosen === 'RISE' ? entryPrice + atr * 3.5 : entryPrice - atr * 3.5);
    const tp3 = structuralTargets[2] ?? null;
    const rr = Math.abs(tp1 - entryPrice) / Math.max(1e-9, Math.abs(entryPrice - stop));

    if (rr >= 1.2) {
      signal = buildAiSignal({
        id: `${symbol}-confluence-${chosen}-${Date.now()}`,
        symbol,
        displayName,
        marketFamily,
        precision,
        direction: chosen,
        modelId: chosenEvidence[0]?.modelId ?? 'CONFLUENCE_PRIMARY',
        modelLabel: `Validated ${chosenEvidence[0]?.modelLabel ?? 'confluence'}`,
        strategyLabel: 'Independent multi-module validation',
        status: 'CONFIRMED',
        score: Math.round(confluenceScore),
        condition: condition.condition,
        entryPrice,
        entryZoneLow: entryPrice - atr * 0.2,
        entryZoneHigh: entryPrice + atr * 0.2,
        stopLoss: stop,
        takeProfit1: tp1,
        takeProfit2: tp2,
        takeProfit3: tp3,
        invalidationCondition:
          chosen === 'RISE'
            ? 'A close below the structural invalidation removes all confluence support.'
            : 'A close above the structural invalidation removes all confluence support.',
        reasons: [
          `Grade ${grade} — ${chosenEvidence.length} independently verified evidence item(s).`,
          ...chosenEvidence.slice(0, 4).map((v) => v.note),
          ...(conflicts.length ? [`Conflicting evidence: ${conflicts.slice(0, 2).join(' ')}`] : []),
        ],
        confirmations: chosenEvidence.slice(0, 4).map((v) => v.module),
        timeframes: [],
        confirmedBarTime: best?.confirmedBarTime ?? entry[entry.length - 1].time,
      });
    }
  }

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
    m15: `${condition.condition.replace(/_/g, ' ').toLowerCase()} — ${condition.detail}`,
    m15Tone: condition.bias === 'bullish' ? 'bull' : condition.bias === 'bearish' ? 'bear' : 'neutral',
    m5: `${verified.length} verified evidence item(s) · ${conflicts.length} rejected`,
    m5Tone: verified.length ? 'warn' : 'neutral',
    m1: signal ? 'Validated entry levels derived from structure.' : 'No validated trade.',
    m1Tone: signal ? 'bull' : 'neutral',
    ladder: ladderTimeframeReads(params.candlesByTimeframe),
  });

  const zones: AiZone[] = signal
    ? [
        makeZone({
          id: `${signal.id}-entry`,
          direction: signal.direction,
          label: 'Validated entry',
          upperPrice: signal.entryZoneHigh,
          lowerPrice: signal.entryZoneLow,
          quality: signal.score,
          fresh: true,
          watch: false,
          reason: `Validated ${signal.direction} entry zone — grade ${grade}.`,
        }),
      ]
    : [];

  const statusExplanation = signal
    ? `${signal.direction} — grade ${grade}, confluence score ${Math.round(confluenceScore)}/100.`
    : verified.length === 0
      ? 'NO HIGH-QUALITY TRADE AVAILABLE — no module signal passed independent validation.'
      : `NO HIGH-QUALITY TRADE AVAILABLE — best confluence scored ${Math.round(confluenceScore)}/100, below the ${CONFLUENCE_PUBLICATION_MIN_SCORE} gate.`;

  return {
    ...base,
    status: signal ? 'CONFIRMED' : 'NO_VALID_SETUP',
    statusExplanation,
    timeframes,
    signal,
    activeZones: zones,
    watchZones: [],
    bestScore: Math.round(confluenceScore),
    rejectionReason: signal
      ? undefined
      : verified.length === 0
        ? 'No evidence passed independent verification.'
        : `Confluence score ${Math.round(confluenceScore)}/100 is below the gate.`,
  };
}

export const confluenceEngine = analyzeConfluenceInstrument;
