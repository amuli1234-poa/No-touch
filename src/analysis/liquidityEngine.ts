import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  ladderTimeframeReads,
  timeframeConditionRead,
  clamp,
  structurallyValidDrafts,
  resolveTargets,
  makeZone,
  confluenceBonus,
  readAiCondition,
  statusForScore,
  m1BodyConfirm,
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
 * LIQUIDITY AI — where liquidity sits, what has been swept, and which pools are the
 * relevant future targets. Independent engine: it decides from its OWN liquidity read
 * (pools, sweeps, weak/protected levels) and never copies another module's signal.
 */

export const LIQUIDITY_PUBLICATION_MIN_SCORE = 85;

export const LIQUIDITY_MODEL_LABELS: Record<string, string> = {
  LIQ_SWEEP_MSS: 'Sweep → Displacement → MSS',
  LIQ_SWEEP_CHOCH_FVG: 'Sweep → CHOCH → FVG Retracement',
  LIQ_EQUAL_HIGH_SWEEP: 'Equal-High Sweep → Bearish Confirmation',
  LIQ_EQUAL_LOW_SWEEP: 'Equal-Low Sweep → Bullish Confirmation',
  LIQ_TRENDLINE_RAID: 'Trendline Liquidity Raid → Continuation',
  LIQ_INTERNAL_TO_EXTERNAL: 'Internal Sweep → External Liquidity Target',
  LIQ_SWEEP_OB_RETEST: 'Liquidity Grab → Order-Block Retest',
};

export interface LiquidityEngineParams {
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

function m1Confirm(
  entry: readonly Candle[],
  direction: AiDirection,
  atr: number
): { confirmed: boolean; time: number; detail: string } {
  return m1BodyConfirm(
    entry,
    direction,
    atr,
    0.35,
    (stats) =>
      `M1 confirmed the ${direction === 'RISE' ? 'bullish' : 'bearish'} reaction with a ${(
        stats.body / atr
      ).toFixed(2)}× ATR body.`,
    'M1 reaction confirmation pending.'
  );
}

export function analyzeLiquidityInstrument(params: LiquidityEngineParams): AiInstrumentAnalysis {
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
    statusExplanation: 'Mapping liquidity pools…',
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
      statusExplanation: 'Insufficient confirmed candles for the liquidity read.',
      rejectionReason: 'Not enough data.',
    };
  }

  const swings = detectSwings(setup, 3, 3);
  const atrs = computeAtrSeries(setup);
  const ms = analyzeMarketStructure(setup, swings, atrs, precision);
  const pools = detectLiquidityPools(setup, atr, precision, price);
  const sweeps = detectSweeps(setup, pools, atr, precision);
  const obs = detectOrderBlocks(setup, atr, precision, price);
  const fvgs = detectFvgs(setup, atr, precision, price);

  const bsl = pools.filter((p) => p.side === 'BSL' && !p.swept).sort((a, b) => a.price - b.price);
  const ssl = pools.filter((p) => p.side === 'SSL' && !p.swept).sort((a, b) => b.price - a.price);
  const nearestBsl = bsl.find((p) => p.price > price) ?? null;
  const nearestSsl = ssl.find((p) => p.price < price) ?? null;
  const drawTarget: 'BSL' | 'SSL' | null = nearestBsl && nearestSsl
    ? nearestBsl.price - price < price - nearestSsl.price
      ? 'BSL'
      : 'SSL'
    : nearestBsl
      ? 'BSL'
      : nearestSsl
        ? 'SSL'
        : null;

  const latestGenuine = sweeps.find((s) => s.genuine);
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

  const poolTargets = (direction: AiDirection, entryRef: number = price): number[] =>
    resolveTargets(
      direction,
      entryRef,
      (direction === 'RISE' ? bsl : ssl).map((p) => p.price),
      atr
    );

  // 1. Sweep → displacement → MSS.
  if (latestGenuine && latestBreak && latestGenuine.followedByDisplacement) {
    const dir: AiDirection = latestGenuine.side === 'SSL' ? 'RISE' : 'FALL';
    const agrees = (latestBreak.direction === 'bullish' ? 'RISE' : 'FALL') === dir;
    if (agrees) {
      const conf = m1Confirm(entry, dir, aiAtr(entry));
      const targets = poolTargets(dir);
      drafts.push({
        modelId: 'LIQ_SWEEP_MSS',
        direction: dir,
        entry: price,
        stop: dir === 'RISE' ? latestGenuine.extremePrice - atr * 0.6 : latestGenuine.extremePrice + atr * 0.6,
        targets,
        score: clamp(
          62 +
            (conf.confirmed ? 12 : 0) +
            (targets.length >= 2 ? 8 : 0) +
            confluenceBonus({
              obQuality: obs.find((o) => (o.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir)?.quality,
              fvgQuality: fvgs.find((f) => (f.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir)?.quality,
              momentumConfirmed: latestBreak.momentumConfirmed,
              poolTouches: latestGenuine.poolTouches,
              trendAligned: condition.bias === (dir === 'RISE' ? 'bullish' : 'bearish'),
              displacement: latestGenuine.followedByDisplacement,
            }),
          0,
          100
        ),
        reasons: [latestGenuine.reason, latestBreak.reason, conf.detail],
        confirmations: ['Sweep → displacement → MSS'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time || latestBreak.time,
        strategy: 'Sweep → MSS',
      });
    }
  }

  // 2. Sweep → CHOCH → FVG retracement.
  if (latestGenuine && latestBreak && latestBreak.kind === 'CHOCH') {
    const dir: AiDirection = latestBreak.direction === 'bullish' ? 'RISE' : 'FALL';
    const fvg = fvgs.find((f) => (f.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir);
    if (fvg) {
      const entryLevel = dir === 'RISE' ? fvg.upperPrice : fvg.lowerPrice;
      const conf = m1Confirm(entry, dir, aiAtr(entry));
      drafts.push({
        modelId: 'LIQ_SWEEP_CHOCH_FVG',
        direction: dir,
        entry: entryLevel,
        stop: dir === 'RISE' ? fvg.lowerPrice - atr * 0.5 : fvg.upperPrice + atr * 0.5,
        targets: poolTargets(dir, entryLevel),
        score: clamp(
          60 + (conf.confirmed ? 12 : 0) + 6 + confluenceBonus({ fvgQuality: fvg.quality, momentumConfirmed: latestBreak.momentumConfirmed, displacement: latestGenuine.followedByDisplacement }),
          0,
          100
        ),
        reasons: [latestGenuine.reason, latestBreak.reason, fvg.reason, conf.detail],
        confirmations: ['Sweep → CHOCH → FVG'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time || latestBreak.time,
        strategy: 'Sweep → CHOCH → FVG',
      });
    }
  }

  // 3/4. Equal-high / equal-low sweep.
  const equalHighPool = pools.find((p) => p.side === 'BSL' && p.touches >= 2);
  const equalLowPool = pools.find((p) => p.side === 'SSL' && p.touches >= 2);
  const sweptEqualHigh = sweeps.find((s) => s.side === 'BSL' && s.genuine && equalHighPool && Math.abs(s.level - equalHighPool.upperPrice) < atr * 0.5);
  const sweptEqualLow = sweeps.find((s) => s.side === 'SSL' && s.genuine && equalLowPool && Math.abs(s.level - equalLowPool.lowerPrice) < atr * 0.5);
  if (sweptEqualHigh) {
    const conf = m1Confirm(entry, 'FALL', aiAtr(entry));
    drafts.push({
      modelId: 'LIQ_EQUAL_HIGH_SWEEP',
      direction: 'FALL',
      entry: price,
      stop: sweptEqualHigh.extremePrice + atr * 0.5,
      targets: poolTargets('FALL'),
      score: clamp(56 + (conf.confirmed ? 12 : 0) + confluenceBonus({ poolTouches: equalHighPool?.touches, displacement: sweptEqualHigh.followedByDisplacement }), 0, 100),
      reasons: [sweptEqualHigh.reason, 'Equal highs swept — bearish confirmation expected.', conf.detail],
      confirmations: ['Equal-high sweep'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || sweptEqualHigh.time,
      strategy: 'Equal-high sweep',
    });
  }
  if (sweptEqualLow) {
    const conf = m1Confirm(entry, 'RISE', aiAtr(entry));
    drafts.push({
      modelId: 'LIQ_EQUAL_LOW_SWEEP',
      direction: 'RISE',
      entry: price,
      stop: sweptEqualLow.extremePrice - atr * 0.5,
      targets: poolTargets('RISE'),
      score: clamp(56 + (conf.confirmed ? 12 : 0) + confluenceBonus({ poolTouches: equalLowPool?.touches, displacement: sweptEqualLow.followedByDisplacement }), 0, 100),
      reasons: [sweptEqualLow.reason, 'Equal lows swept — bullish confirmation expected.', conf.detail],
      confirmations: ['Equal-low sweep'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || sweptEqualLow.time,
      strategy: 'Equal-low sweep',
    });
  }

  // 5. Trendline liquidity raid → continuation (approximated by a sweep that agrees with bias).
  if (latestGenuine && condition.bias !== 'neutral') {
    const dir: AiDirection = condition.bias === 'bullish' ? 'RISE' : 'FALL';
    const agrees = (latestGenuine.side === 'SSL' ? 'RISE' : 'FALL') === dir;
    if (agrees) {
      const conf = m1Confirm(entry, dir, aiAtr(entry));
      drafts.push({
        modelId: 'LIQ_TRENDLINE_RAID',
        direction: dir,
        entry: price,
        stop: dir === 'RISE' ? latestGenuine.extremePrice - atr * 0.6 : latestGenuine.extremePrice + atr * 0.6,
        targets: poolTargets(dir),
        score: clamp(57 + (conf.confirmed ? 12 : 0) + confluenceBonus({ trendAligned: true, momentumConfirmed: latestBreak?.momentumConfirmed, displacement: latestGenuine.followedByDisplacement }), 0, 100),
        reasons: [latestGenuine.reason, `Sweep agrees with the dominant ${condition.bias} bias — continuation favoured.`, conf.detail],
        confirmations: ['Trend-aligned liquidity raid'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time || latestGenuine.time,
        strategy: 'Trendline raid',
      });
    }
  }

  // 6. Internal sweep → external liquidity target.
  if (latestGenuine && drawTarget) {
    const dir: AiDirection = drawTarget === 'BSL' ? 'RISE' : 'FALL';
    const external = dir === 'RISE' ? nearestBsl : nearestSsl;
    if (external) {
      const conf = m1Confirm(entry, dir, aiAtr(entry));
      drafts.push({
        modelId: 'LIQ_INTERNAL_TO_EXTERNAL',
        direction: dir,
        entry: price,
        stop: dir === 'RISE' ? latestGenuine.extremePrice - atr * 0.6 : latestGenuine.extremePrice + atr * 0.6,
        targets: [external.price],
        score: clamp(56 + (conf.confirmed ? 12 : 0) + confluenceBonus({ poolTouches: (dir === 'RISE' ? nearestBsl : nearestSsl)?.touches, displacement: latestGenuine.followedByDisplacement }), 0, 100),
        reasons: [
          `Internal liquidity taken; external ${dir === 'RISE' ? 'buy-side' : 'sell-side'} liquidity at ${formatPrice(external.price, precision)} is the draw.`,
          conf.detail,
        ],
        confirmations: ['Internal → external liquidity'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time || latestGenuine.time,
        strategy: 'Internal → external',
      });
    }
  }

  // 7. Liquidity grab → order-block retest.
  if (latestGenuine) {
    const dir: AiDirection = latestGenuine.side === 'SSL' ? 'RISE' : 'FALL';
    const ob = obs.find((o) => (o.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir && !o.invalidated);
    if (ob) {
      const entryLevel = dir === 'RISE' ? ob.upperPrice : ob.lowerPrice;
      const conf = m1Confirm(entry, dir, aiAtr(entry));
      drafts.push({
        modelId: 'LIQ_SWEEP_OB_RETEST',
        direction: dir,
        entry: entryLevel,
        stop: dir === 'RISE' ? ob.lowerPrice - atr * 0.6 : ob.upperPrice + atr * 0.6,
        targets: poolTargets(dir, entryLevel),
        score: clamp(56 + (conf.confirmed ? 12 : 0) + confluenceBonus({ obQuality: ob.quality, poolTouches: latestGenuine.poolTouches, displacement: latestGenuine.followedByDisplacement }), 0, 100),
        reasons: [latestGenuine.reason, ob.reason, conf.detail],
        confirmations: ['Liquidity grab → OB retest'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
        strategy: 'Grab → OB retest',
      });
    }
  }

  const best = structurallyValidDrafts(drafts).sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = LIQUIDITY_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate, best?.confirmed === true);

  // ---- Chart zones: unswept pools (future targets) + swept pools (dimmer) ----
  const zones: AiZone[] = [];
  for (const p of pools.slice(0, 6)) {
    zones.push(
      makeZone({
        id: p.id,
        direction: p.side === 'BSL' ? 'FALL' : 'RISE',
        label: p.swept ? `${p.side} swept` : p.side,
        upperPrice: p.upperPrice,
        lowerPrice: p.lowerPrice,
        quality: p.touches >= 2 ? 80 : 60,
        fresh: !p.swept,
        watch: !p.swept,
        reason: p.reason,
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
    m5: `${pools.filter((p) => !p.swept).length} unswept pool(s) · ${
      sweeps.filter((s) => s.genuine).length
    } genuine sweep(s)`,
    m5Tone: latestGenuine ? 'warn' : 'neutral',
    m1: best ? (best.confirmed ? 'M1 reaction confirmed.' : 'M1 reaction pending.') : 'No M1 confirmation.',
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
      modelLabel: LIQUIDITY_MODEL_LABELS[best.modelId] ?? best.modelId,
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
          ? 'A close back below the swept low invalidates the bullish liquidity setup.'
          : 'A close back above the swept high invalidates the bearish liquidity setup.',
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
      : drawTarget
        ? `No genuine sweep to trade yet; the relevant draw is ${drawTarget} liquidity.`
        : 'No meaningful liquidity event in play.';

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
      signal || !best ? undefined : `Best liquidity setup scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

export const liquidityEngine = analyzeLiquidityInstrument;
