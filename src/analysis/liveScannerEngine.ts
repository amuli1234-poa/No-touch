import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  clamp,
  emaLast,
  makeZone,
  orderTargets,
  readAiCondition,
  statusForScore,
} from './aiCommon';
import { computeAdxSeries, computeMacdSeries } from './indicators';
import { analyzeMarketStructure } from './structure';
import { computeAtrSeries, detectSwings, getCandleStats } from './swings';
import { detectFvgs, detectLiquidityPools, detectOrderBlocks, detectSweeps } from './smcTools';
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
 * LIVE MARKET SCANNER — multi-market opportunity hunter.
 *
 * It runs a compact composite of the same detection primitives every specialist module
 * uses (structure, liquidity, imbalance, order blocks, momentum, regime) to find and RANK
 * developing + confirmed opportunities across all indices. It verifies each candidate
 * against live candles and applies a strict no-trade filter.
 */

export const LIVE_SCANNER_PUBLICATION_MIN_SCORE = 85;

export const LIVE_MODEL_LABELS: Record<string, string> = {
  LIVE_LIQUIDITY_SWEEP: 'Liquidity Sweep → Displacement',
  LIVE_FVG_RETRACEMENT: 'FVG Retracement',
  LIVE_ORDER_BLOCK: 'Order-Block Retest',
  LIVE_BOS_CONTINUATION: 'BOS Continuation',
  LIVE_CHOCH_REVERSAL: 'CHOCH Reversal',
  LIVE_MOMENTUM_CONTINUATION: 'Momentum Continuation',
  LIVE_COMPRESSION_BREAKOUT: 'Compression Breakout',
  LIVE_RANGE_EXTREME: 'Range Extreme Reversion',
};

export interface LiveScannerEngineParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  structureCandles: readonly Candle[];
  setupCandles: readonly Candle[];
  entryCandles: readonly Candle[];
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
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
      return { confirmed: true, time: bar.time, detail: `M1 confirmed the ${direction === 'RISE' ? 'bullish' : 'bearish'} trigger.` };
    }
  }
  return { confirmed: false, time: 0, detail: 'M1 trigger confirmation pending.' };
}

export function analyzeLiveInstrument(params: LiveScannerEngineParams): AiInstrumentAnalysis {
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
    statusExplanation: 'Scanning for opportunities…',
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

  if (dataHealth !== 'HEALTHY') {
    return {
      ...base,
      status: 'ANALYSING',
      statusExplanation:
        dataHealth === 'STALE' ? 'Feed stale — market unavailable for ranking.' : 'Feed disconnected — market unavailable.',
      rejectionReason: 'Market data unavailable.',
    };
  }

  if (setup.length < 30 || entry.length < 5 || atr <= 0) {
    return {
      ...base,
      statusExplanation: 'Insufficient confirmed candles for the scan.',
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
  const latestBreak = ms.latestBreak;

  const closes = setup.map((c) => c.close);
  const adx = computeAdxSeries(setup, 14).at(-1) ?? 0;
  const macdHist = computeMacdSeries(closes).histogram.at(-1) ?? 0;
  const ema20 = emaLast(closes, 20);
  const ema50 = emaLast(closes, 50);

  const highs = swings.filter((s) => s.type === 'high').map((s) => s.price);
  const lows = swings.filter((s) => s.type === 'low').map((s) => s.price);
  const bsl = pools.filter((p) => p.side === 'BSL' && !p.swept && p.price > price).sort((a, b) => a.price - b.price);
  const ssl = pools.filter((p) => p.side === 'SSL' && !p.swept && p.price < price).sort((a, b) => b.price - a.price);

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

  const targetFor = (direction: AiDirection): number[] =>
    orderTargets(
      direction,
      price,
      (direction === 'RISE' ? bsl.map((p) => p.price) : ssl.map((p) => p.price)).concat(direction === 'RISE' ? highs : lows)
    ).slice(0, 3);

  const momentumUp = macdHist > 0;
  const momentumDown = macdHist < 0;
  const trendUp = adx >= 22 && ema20 !== null && ema50 !== null && ema20 > ema50 && momentumUp;
  const trendDown = adx >= 22 && ema20 !== null && ema50 !== null && ema20 < ema50 && momentumDown;

  // Liquidity sweep → displacement.
  if (latestSweep && latestSweep.followedByDisplacement) {
    const dir: AiDirection = latestSweep.side === 'SSL' ? 'RISE' : 'FALL';
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    const targets = targetFor(dir);
    drafts.push({
      modelId: 'LIVE_LIQUIDITY_SWEEP',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? latestSweep.extremePrice - atr * 0.6 : latestSweep.extremePrice + atr * 0.6,
      targets,
      score: clamp(60 + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 8 : 0), 0, 100),
      reasons: [latestSweep.reason, conf.detail],
      confirmations: ['Liquidity sweep + displacement'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || latestSweep.time,
      strategy: 'Liquidity sweep',
    });
  }

  // Fresh FVG retracement.
  const freshFvg = fvgs.find((f) => f.state === 'FRESH' || f.state === 'APPROACHING' || f.state === 'TESTED');
  if (freshFvg) {
    const dir: AiDirection = freshFvg.kind === 'BULLISH' ? 'RISE' : 'FALL';
    const entryLevel = dir === 'RISE' ? freshFvg.upperPrice : freshFvg.lowerPrice;
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    drafts.push({
      modelId: 'LIVE_FVG_RETRACEMENT',
      direction: dir,
      entry: entryLevel,
      stop: dir === 'RISE' ? freshFvg.lowerPrice - atr * 0.5 : freshFvg.upperPrice + atr * 0.5,
      targets: targetFor(dir),
      score: clamp(54 + freshFvg.quality / 8 + (conf.confirmed ? 12 : 0) + (targetFor(dir).length >= 2 ? 6 : 0), 0, 100),
      reasons: [freshFvg.reason, conf.detail],
      confirmations: ['Fresh imbalance retracement'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || freshFvg.time,
      strategy: 'FVG retracement',
    });
  }

  // Order-block retest.
  const freshOb = obs.find((o) => !o.invalidated);
  if (freshOb) {
    const dir: AiDirection = freshOb.kind === 'BULLISH' ? 'RISE' : 'FALL';
    const entryLevel = dir === 'RISE' ? freshOb.upperPrice : freshOb.lowerPrice;
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    drafts.push({
      modelId: 'LIVE_ORDER_BLOCK',
      direction: dir,
      entry: entryLevel,
      stop: dir === 'RISE' ? freshOb.lowerPrice - atr * 0.6 : freshOb.upperPrice + atr * 0.6,
      targets: targetFor(dir),
      score: clamp(54 + (conf.confirmed ? 12 : 0) + (freshOb.quality >= 70 ? 8 : 2) + (targetFor(dir).length >= 2 ? 6 : 0), 0, 100),
      reasons: [freshOb.reason, conf.detail],
      confirmations: ['Order-block retest'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || freshOb.time,
      strategy: 'Order-block retest',
    });
  }

  // BOS / CHOCH continuation.
  if (latestBreak) {
    const dir: AiDirection = latestBreak.direction === 'bullish' ? 'RISE' : 'FALL';
    const trendAgrees = dir === 'RISE' ? trendUp : trendDown;
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    drafts.push({
      modelId: latestBreak.kind === 'BOS' ? 'LIVE_BOS_CONTINUATION' : 'LIVE_CHOCH_REVERSAL',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? latestBreak.brokenLevel - atr * 1.2 : latestBreak.brokenLevel + atr * 1.2,
      targets: targetFor(dir),
      score: clamp(52 + (trendAgrees ? 10 : 0) + (latestBreak.momentumConfirmed ? 8 : 0) + (conf.confirmed ? 12 : 0), 0, 100),
      reasons: [latestBreak.reason, trendAgrees ? 'Trend and momentum agree with the break.' : 'Trend alignment is incomplete.', conf.detail],
      confirmations: [latestBreak.kind],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || latestBreak.time,
      strategy: latestBreak.kind === 'BOS' ? 'BOS continuation' : 'CHOCH reversal',
    });
  }

  // Momentum continuation in a trend.
  if (trendUp || trendDown) {
    const dir: AiDirection = trendUp ? 'RISE' : 'FALL';
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    drafts.push({
      modelId: 'LIVE_MOMENTUM_CONTINUATION',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? (ema20 ?? price - atr * 1.5) - atr * 0.4 : (ema20 ?? price + atr * 1.5) + atr * 0.4,
      targets: targetFor(dir),
      score: clamp(55 + (conf.confirmed ? 12 : 0) + (adx >= 28 ? 8 : 2) + (targetFor(dir).length >= 2 ? 6 : 0), 0, 100),
      reasons: [`ADX ${adx.toFixed(1)} with MACD histogram ${macdHist.toFixed(4)} — trend continuation.`, conf.detail],
      confirmations: ['Trend + momentum'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Momentum continuation',
    });
  }

  const best = drafts.sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = LIVE_SCANNER_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate);

  // Developing watch zones: unswept liquidity + fresh imbalances ahead of price.
  const zones: AiZone[] = [];
  for (const p of pools.slice(0, 4)) {
    zones.push(
      makeZone({
        id: p.id,
        direction: p.side === 'BSL' ? 'FALL' : 'RISE',
        label: p.swept ? `${p.side} swept` : p.side,
        upperPrice: p.upperPrice,
        lowerPrice: p.lowerPrice,
        quality: p.touches >= 2 ? 78 : 58,
        fresh: !p.swept,
        watch: !p.swept,
        reason: p.reason,
      })
    );
  }
  for (const f of fvgs.filter((x) => x.state === 'FRESH' || x.state === 'APPROACHING').slice(0, 2)) {
    zones.push(
      makeZone({
        id: f.id,
        direction: f.kind === 'BULLISH' ? 'RISE' : 'FALL',
        label: `${f.kind === 'BULLISH' ? 'Bullish' : 'Bearish'} FVG`,
        upperPrice: f.upperPrice,
        lowerPrice: f.lowerPrice,
        quality: f.quality,
        fresh: true,
        watch: f.kind === 'BULLISH' ? price > f.upperPrice : price < f.lowerPrice,
        reason: f.reason,
      })
    );
  }

  const timeframes: AiTimeframeRead[] = buildTimeframeReads({
    m15: `${condition.condition.replace(/_/g, ' ').toLowerCase()} — ${condition.detail}`,
    m15Tone: condition.bias === 'bullish' ? 'bull' : condition.bias === 'bearish' ? 'bear' : 'neutral',
    m5: `${drafts.length} candidate(s) scanned · ${zones.filter((z) => z.watch).length} watch zone(s)`,
    m5Tone: drafts.length ? 'warn' : 'neutral',
    m1: best ? (best.confirmed ? 'M1 trigger confirmed.' : 'M1 trigger pending.') : 'No M1 confirmation.',
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
      modelLabel: LIVE_MODEL_LABELS[best.modelId] ?? best.modelId,
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
          ? `A close below ${formatPrice(best.stop, precision)} invalidates the setup.`
          : `A close above ${formatPrice(best.stop, precision)} invalidates the setup.`,
      reasons: best.reasons,
      confirmations: best.confirmations,
      timeframes,
      confirmedBarTime: best.confirmationTime,
    });
  }

  const statusExplanation = signal
    ? `${signal.direction} confirmed — ${signal.modelLabel} (${signal.score}/100).`
    : best
      ? `${best.strategy} developing; score ${Math.round(bestScore)}/100 — ${
          best.confirmed ? 'below the ranking gate.' : 'waiting for M1 confirmation.'
        }`
      : 'NO HIGH-QUALITY OPPORTUNITY RIGHT NOW — no candidate cleared the filter.';

  return {
    ...base,
    status: signal ? 'CONFIRMED' : best ? 'DEVELOPING' : 'NO_HIGH_QUALITY_OPPORTUNITY',
    statusExplanation,
    timeframes,
    signal,
    activeZones: zones.filter((z) => !z.watch),
    watchZones: zones.filter((z) => z.watch),
    bestScore: Math.round(bestScore),
    rejectionReason:
      signal || !best ? undefined : `Best candidate scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

export const liveScannerEngine = analyzeLiveInstrument;
