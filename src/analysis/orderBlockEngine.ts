import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  ladderTimeframeReads,
  timeframeConditionRead,
  clamp,
  structurallyValidDrafts,
  makeZone,
  resolveTargets,
  readAiCondition,
  statusForScore,
  m1LevelConfirm,
} from './aiCommon';
import { analyzeMarketStructure } from './structure';
import { computeAtrSeries, detectSwings } from './swings';
import { detectFvgs, detectLiquidityPools, detectOrderBlocks, detectSweeps } from './smcTools';
import { confirmedOnly } from './trendlineDetection';
import type {
  AiDirection,
  AiInstrumentAnalysis,
  AiSignal,
  AiTimeframeRead,
  AiZone,
} from '../types/aiModule';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import { formatPrice } from '../utils/derivParser';

/**
 * ORDER BLOCK & BREAKER BLOCK AI — institutional-zone engine.
 *
 * Independent engine: it identifies where meaningful buying/selling originated, tracks the
 * zone lifecycle (fresh → tested → mitigated → invalidated → role reversal) and only
 * trades a retest that shows confirmation. Breakers require a genuinely invalidated OB.
 */

export const ORDER_BLOCK_PUBLICATION_MIN_SCORE = 85;

export type ObLifecycle =
  | 'FRESH'
  | 'APPROACHING'
  | 'TESTED'
  | 'PARTIALLY_MITIGATED'
  | 'FULLY_MITIGATED'
  | 'INVALIDATED'
  | 'ROLE_REVERSAL';

export const OB_MODEL_LABELS: Record<string, string> = {
  OB_FRESH_RETEST: 'Fresh Order-Block Retest',
  OB_SWEEP_DISPLACEMENT: 'Order Block + Sweep + Displacement',
  OB_FVG_CONFLUENCE: 'Order Block + FVG Confluence',
  BREAKER_RETEST: 'Breaker-Block Retest',
  MITIGATION_MSS: 'Mitigation Block + MSS',
  OB_BOS_CONTINUATION: 'Order Block + BOS Continuation',
  LIQ_RAID_BREAKER: 'Liquidity Raid → Breaker Formation',
  OB_LTF_CHOCH: 'Order Block Rejection + LTF CHOCH',
};

export interface OrderBlockEngineParams {
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

function obLifecycle(
  ob: { upperPrice: number; lowerPrice: number; kind: 'BULLISH' | 'BEARISH'; index: number },
  bars: readonly Candle[],
  price: number,
  atr: number
): ObLifecycle {
  const isBull = ob.kind === 'BULLISH';
  let touched = false;
  let partial = false;
  let full = false;
  let invalidated = false;
  for (let i = ob.index + 2; i < bars.length; i++) {
    const bar = bars[i];
    const entered = bar.low <= ob.upperPrice && bar.high >= ob.lowerPrice;
    if (entered) touched = true;
    if (isBull) {
      if (bar.low <= (ob.upperPrice + ob.lowerPrice) / 2) partial = true;
      if (bar.low <= ob.lowerPrice) full = true;
      if (bar.close < ob.lowerPrice - atr * 0.15) invalidated = true;
    } else {
      if (bar.high >= (ob.upperPrice + ob.lowerPrice) / 2) partial = true;
      if (bar.high >= ob.upperPrice) full = true;
      if (bar.close > ob.upperPrice + atr * 0.15) invalidated = true;
    }
  }
  if (invalidated) return 'ROLE_REVERSAL';
  if (full) return 'FULLY_MITIGATED';
  if (partial) return 'PARTIALLY_MITIGATED';
  if (touched) return 'TESTED';
  const approaching = isBull
    ? price > ob.upperPrice && price - ob.upperPrice < atr * 2
    : price < ob.lowerPrice && ob.lowerPrice - price < atr * 2;
  return approaching ? 'APPROACHING' : 'FRESH';
}

function m1Confirm(
  entry: readonly Candle[],
  direction: AiDirection,
  level: number,
  atr: number
): { confirmed: boolean; time: number; detail: string } {
  return m1LevelConfirm(
    entry,
    direction,
    level,
    atr,
    0.1,
    () =>
      `M1 confirmed the ${direction === 'RISE' ? 'bullish' : 'bearish'} reaction at ${formatPrice(
        level,
        2
      )}.`,
    'M1 reaction confirmation pending.'
  );
}

export function analyzeOrderBlockInstrument(params: OrderBlockEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth } = params;
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
    statusExplanation: 'Locating institutional zones…',
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
      statusExplanation: 'Insufficient confirmed candles for the order-block read.',
      rejectionReason: 'Not enough data.',
    };
  }

  const swings = detectSwings(setup, 3, 3);
  const atrs = computeAtrSeries(setup);
  const ms = analyzeMarketStructure(setup, swings, atrs, precision);
  const obs = detectOrderBlocks(setup, atr, precision, price);
  const fvgs = detectFvgs(setup, atr, precision, price);
  const pools = detectLiquidityPools(setup, atr, precision, price);
  const sweeps = detectSweeps(setup, pools, atr, precision);
  const latestBreak = ms.latestBreak;
  const latestSweep = sweeps.find((s) => s.genuine);

  const highs = swings.filter((s) => s.type === 'high').map((s) => s.price);
  const lows = swings.filter((s) => s.type === 'low').map((s) => s.price);

  interface ObRecord {
    ob: (typeof obs)[number];
    lifecycle: ObLifecycle;
  }
  const records: ObRecord[] = obs.map((ob) => ({ ob, lifecycle: obLifecycle(ob, setup, price, atr) }));

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

  // Targets are anchored to the ACTUAL entry (never the current price): the entry is an
  // order-block boundary that can sit far from price, so a price-anchored ladder would
  // place FALL targets above the entry.
  const targetFor = (direction: AiDirection, entry: number): number[] =>
    resolveTargets(direction, entry, direction === 'RISE' ? highs : lows, atr);

  const tradeableObs = records.filter(
    (r) =>
      r.lifecycle === 'FRESH' ||
      r.lifecycle === 'APPROACHING' ||
      r.lifecycle === 'TESTED' ||
      r.lifecycle === 'PARTIALLY_MITIGATED'
  );

  for (const { ob, lifecycle } of tradeableObs) {
    const dir: AiDirection = ob.kind === 'BULLISH' ? 'RISE' : 'FALL';
    const entryLevel = dir === 'RISE' ? ob.upperPrice : ob.lowerPrice;
    const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
    const targets = targetFor(dir, entryLevel);
    const fvgConfluence = fvgs.find(
      (f) => (f.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir && f.upperPrice >= ob.lowerPrice && f.lowerPrice <= ob.upperPrice
    );
    const sweepAgrees = latestSweep && (latestSweep.side === 'SSL' ? 'RISE' : 'FALL') === dir;
    const bosAgrees = latestBreak && latestBreak.kind === 'BOS' && (latestBreak.direction === 'bullish' ? 'RISE' : 'FALL') === dir;
    const mssAgrees = latestBreak && latestBreak.kind === 'CHOCH' && (latestBreak.direction === 'bullish' ? 'RISE' : 'FALL') === dir;

    let modelId = 'OB_FRESH_RETEST';
    if (fvgConfluence) modelId = 'OB_FVG_CONFLUENCE';
    else if (sweepAgrees && latestSweep?.followedByDisplacement) modelId = 'OB_SWEEP_DISPLACEMENT';
    else if (bosAgrees) modelId = 'OB_BOS_CONTINUATION';
    else if (mssAgrees) modelId = 'MITIGATION_MSS';

    const score = clamp(
      52 +
        (lifecycle === 'FRESH' ? 12 : lifecycle === 'APPROACHING' ? 8 : 2) +
        Math.min(10, ob.displacementAtr * 4) +
        (fvgConfluence ? 6 : 0) +
        (sweepAgrees ? 6 : 0) +
        (bosAgrees || mssAgrees ? 6 : 0) +
        (conf.confirmed ? 12 : 0) +
        (targets.length >= 2 ? 6 : 0),
      0,
      100
    );

    drafts.push({
      modelId,
      direction: dir,
      entry: entryLevel,
      stop: dir === 'RISE' ? ob.lowerPrice - atr * 0.6 : ob.upperPrice + atr * 0.6,
      targets,
      score,
      reasons: [
        `${ob.reason} Lifecycle: ${lifecycle.replace(/_/g, ' ').toLowerCase()}.`,
        fvgConfluence ? 'An overlapping FVG adds confluence.' : 'No overlapping FVG.',
        sweepAgrees ? 'A same-direction liquidity sweep preceded the move.' : 'No preceding sweep.',
        conf.detail,
      ],
      confirmations: [
        lifecycle === 'FRESH' ? 'Fresh order block' : `Order block ${lifecycle.toLowerCase()}`,
      ],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || ob.time,
      strategy: OB_MODEL_LABELS[modelId] ?? 'Order-block retest',
    });
  }

  // Breaker-block retest — an invalidated OB that reversed role.
  for (const { ob, lifecycle } of records.filter((r) => r.lifecycle === 'ROLE_REVERSAL')) {
    const dir: AiDirection = ob.kind === 'BULLISH' ? 'FALL' : 'RISE';
    const entryLevel = dir === 'RISE' ? ob.lowerPrice : ob.upperPrice;
    const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
    const targets = targetFor(dir, entryLevel);
    const modelId = latestSweep && latestSweep.followedByDisplacement ? 'LIQ_RAID_BREAKER' : 'BREAKER_RETEST';
    drafts.push({
      modelId,
      direction: dir,
      entry: entryLevel,
      stop: dir === 'RISE' ? ob.lowerPrice - atr * 0.7 : ob.upperPrice + atr * 0.7,
      targets,
      score: clamp(56 + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 6 : 0), 0, 100),
      reasons: [
        `${ob.kind === 'BULLISH' ? 'Bullish' : 'Bearish'} order block failed and reversed role — now a breaker acting as ${
          dir === 'RISE' ? 'support' : 'resistance'
        }.`,
        conf.detail,
      ],
      confirmations: ['Breaker role reversal'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || ob.time,
      strategy: 'Breaker retest',
    });
  }

  const best = structurallyValidDrafts(drafts).sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = ORDER_BLOCK_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate, best?.confirmed === true);

  // ---- Chart zones ----
  const zones: AiZone[] = [];
  for (const { ob, lifecycle } of records.slice(0, 6)) {
    if (lifecycle === 'FULLY_MITIGATED' || lifecycle === 'INVALIDATED') continue;
    const isBull = ob.kind === 'BULLISH';
    zones.push(
      makeZone({
        id: ob.id,
        direction: isBull ? 'RISE' : 'FALL',
        label: lifecycle === 'ROLE_REVERSAL' ? 'Breaker' : isBull ? 'Bullish OB' : 'Bearish OB',
        upperPrice: ob.upperPrice,
        lowerPrice: ob.lowerPrice,
        quality: ob.quality,
        fresh: lifecycle === 'FRESH',
        watch: lifecycle === 'FRESH' || lifecycle === 'APPROACHING',
        reason: `${ob.reason} Lifecycle: ${lifecycle.replace(/_/g, ' ').toLowerCase()}.`,
      })
    );
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
    m5: `${records.filter((r) => r.lifecycle === 'FRESH').length} fresh · ${
      records.filter((r) => r.lifecycle === 'ROLE_REVERSAL').length
    } breaker(s)`,
    m5Tone: tradeableObs.length > 0 ? 'warn' : 'neutral',
    m1: best ? (best.confirmed ? 'M1 confirmed the zone reaction.' : 'M1 reaction pending.') : 'No M1 confirmation.',
    m1Tone: best?.confirmed ? 'bull' : 'neutral',
    ladder: ladderTimeframeReads(params.candlesByTimeframe),
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
      modelLabel: OB_MODEL_LABELS[best.modelId] ?? best.modelId,
      strategyLabel: best.strategy,
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
          ? 'A close below the zone invalidates the bullish order-block setup.'
          : 'A close above the zone invalidates the bearish order-block setup.',
      reasons: best.reasons,
      confirmations: best.confirmations,
      timeframes,
      confirmedBarTime: best.confirmationTime,
    });
  }

  const statusExplanation = signal
    ? `${signal.direction} confirmed — ${signal.modelLabel}.`
    : best
      ? `${best.strategy} developing; score ${Math.round(bestScore)}/100 — ${
          best.confirmed ? 'below the publication gate.' : 'waiting for M1 confirmation.'
        }`
      : records.length > 0
        ? `${records.length} zone(s) tracked; none has produced a confirmed retest yet.`
        : 'No valid institutional zone in play.';

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
      signal || !best ? undefined : `Best order-block setup scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

export const orderBlockEngine = analyzeOrderBlockInstrument;
