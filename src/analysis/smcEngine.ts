import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  clamp,
  dealingRange,
  makeZone,
  orderTargets,
  readAiCondition,
  statusForScore,
} from './aiCommon';
import { analyzeMarketStructure } from './structure';
import { computeAtrSeries, detectSwings, getCandleStats } from './swings';
import {
  detectFvgs,
  detectLiquidityPools,
  detectOrderBlocks,
  detectSweeps,
} from './smcTools';
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
 * SMC, ICT & PRICE ACTION AI — institutional order-flow engine.
 *
 * Independent engine: it sequences liquidity → displacement → structure shift → point of
 * interest and only publishes when the FULL sequence is validated. It shares the pure
 * detection primitives in `smcTools.ts` but makes its own decisions.
 */

export const SMC_PUBLICATION_MIN_SCORE = 85;

export const SMC_MODEL_LABELS: Record<string, string> = {
  SMC_SWEEP_MSS_FVG: 'Sweep → MSS → FVG Retracement',
  SMC_SWEEP_CHOCH_OB: 'Sweep → CHOCH → Order-Block Retest',
  SMC_BOS_FVG_CONTINUATION: 'BOS → Displacement → FVG Continuation',
  SMC_BREAKER_RETEST: 'Breaker-Block Retest',
  SMC_OB_FVG_CONFLUENCE: 'Order Block + FVG Confluence',
  SMC_OTE_RETRACEMENT: 'OTE Retracement',
  SMC_TURTLE_SOUP: 'Turtle Soup / Liquidity Raid',
  SMC_BREAKOUT_RETEST: 'Breakout → Retest → Continuation',
};

export interface SmcEngineParams {
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
  level: number,
  atr: number
): { confirmed: boolean; time: number; detail: string } {
  const bars = confirmedOnly(entry);
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--) {
    const bar = bars[i];
    const stats = getCandleStats(bar);
    const dirOk = direction === 'RISE' ? stats.isBullish : stats.isBearish;
    const beyond = direction === 'RISE' ? bar.close - level : level - bar.close;
    if (dirOk && beyond > -atr * 0.05) {
      return {
        confirmed: true,
        time: bar.time,
        detail: `M1 confirmed a ${direction === 'RISE' ? 'bullish' : 'bearish'} reaction at ${formatPrice(
          level,
          2
        )}.`,
      };
    }
  }
  return { confirmed: false, time: 0, detail: 'M1 reaction confirmation pending.' };
}

export function analyzeSmcInstrument(params: SmcEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth } = params;
  const structure = confirmedOnly(params.structureCandles);
  const setup = confirmedOnly(params.setupCandles);
  const entry = confirmedOnly(params.entryCandles);

  const lastOf = (arr: readonly Candle[]) => (arr.length ? arr[arr.length - 1] : null);
  const price = lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastOf(structure)?.close ?? 0;
  const atr = aiAtr(setup.length ? setup : structure);
  const condition = readAiCondition(structure, aiAtr(structure));
  const bias = condition.bias;

  const base: AiInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status: 'ANALYSING',
    statusExplanation: 'Sequencing liquidity, displacement and structure…',
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

  if (structure.length < 30 || setup.length < 30 || entry.length < 5 || atr <= 0) {
    return {
      ...base,
      statusExplanation: 'Insufficient confirmed candles for the SMC read.',
      rejectionReason: 'Not enough data.',
    };
  }

  const swings = detectSwings(setup, 3, 3);
  const atrs = computeAtrSeries(setup);
  const ms = analyzeMarketStructure(setup, swings, atrs, precision);
  const fvgs = detectFvgs(setup, atr, precision, price);
  const obs = detectOrderBlocks(setup, atr, precision, price);
  const pools = detectLiquidityPools(setup, atr, precision, price);
  const sweeps = detectSweeps(setup, pools, atr, precision);
  const range = dealingRange(setup, 40);

  const highs = swings.filter((s) => s.type === 'high').map((s) => s.price);
  const lows = swings.filter((s) => s.type === 'low').map((s) => s.price);

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

  const latestSweep = sweeps.find((s) => s.genuine);
  const latestBreak = ms.latestBreak;
  const freshFvg = fvgs.find((f) => f.state === 'FRESH' || f.state === 'APPROACHING' || f.state === 'TESTED');
  const freshOb = obs.find((o) => !o.invalidated);

  const targetFor = (direction: AiDirection): number[] => {
    const opposing = pools.filter((p) => (direction === 'RISE' ? p.side === 'BSL' : p.side === 'SSL'));
    return orderTargets(direction, price, [...opposing.map((p) => p.price), ...(direction === 'RISE' ? highs : lows)]).slice(0, 3);
  };

  // 1. Sweep → MSS → FVG retracement.
  if (latestSweep && latestBreak) {
    const dir: AiDirection = latestSweep.side === 'SSL' ? 'RISE' : 'FALL';
    const breakAgrees = (latestBreak.direction === 'bullish' ? 'RISE' : 'FALL') === dir;
    if (breakAgrees) {
      const zone = freshFvg && (freshFvg.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir ? freshFvg : null;
      const entryLevel = zone ? (dir === 'RISE' ? zone.upperPrice : zone.lowerPrice) : latestSweep.level;
      const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
      const targets = targetFor(dir);
      drafts.push({
        modelId: 'SMC_SWEEP_MSS_FVG',
        direction: dir,
        entry: entryLevel,
        stop: dir === 'RISE' ? entryLevel - atr * 1.4 : entryLevel + atr * 1.4,
        targets,
        score: clamp(
          62 +
            (zone ? 10 : 0) +
            (latestSweep.followedByDisplacement ? 10 : 0) +
            (conf.confirmed ? 10 : 0) +
            (targets.length >= 2 ? 6 : 0),
          0,
          100
        ),
        reasons: [
          latestSweep.reason,
          latestBreak.reason,
          zone ? `Retracement into the ${zone.kind.toLowerCase()} FVG at ${formatPrice(zone.ce, precision)}.` : 'Retracement to the swept level.',
          conf.detail,
        ],
        confirmations: [zone ? 'Sweep + MSS + FVG sequence' : 'Sweep + MSS sequence'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time || latestSweep.time,
        strategy: 'Sweep → MSS → FVG',
      });
    }
  }

  // 2. Sweep → CHOCH → order-block retest.
  if (latestSweep && latestBreak && latestBreak.kind === 'CHOCH') {
    const dir: AiDirection = latestBreak.direction === 'bullish' ? 'RISE' : 'FALL';
    const ob = obs.find((o) => (o.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir);
    if (ob) {
      const entryLevel = dir === 'RISE' ? ob.upperPrice : ob.lowerPrice;
      const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
      const targets = targetFor(dir);
      drafts.push({
        modelId: 'SMC_SWEEP_CHOCH_OB',
        direction: dir,
        entry: entryLevel,
        stop: dir === 'RISE' ? ob.lowerPrice - atr * 0.6 : ob.upperPrice + atr * 0.6,
        targets,
        score: clamp(60 + (conf.confirmed ? 12 : 0) + (ob.quality >= 70 ? 8 : 2) + (targets.length >= 2 ? 6 : 0), 0, 100),
        reasons: [
          latestSweep.reason,
          latestBreak.reason,
          ob.reason,
          conf.detail,
        ],
        confirmations: ['Sweep + CHOCH + order block'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time || latestBreak.time,
        strategy: 'Sweep → CHOCH → OB retest',
      });
    }
  }

  // 3. BOS → displacement → FVG continuation.
  if (latestBreak && latestBreak.kind === 'BOS') {
    const dir: AiDirection = latestBreak.direction === 'bullish' ? 'RISE' : 'FALL';
    const fvg = freshFvg && (freshFvg.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir ? freshFvg : null;
    if (fvg) {
      const entryLevel = dir === 'RISE' ? fvg.upperPrice : fvg.lowerPrice;
      const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
      const targets = targetFor(dir);
      drafts.push({
        modelId: 'SMC_BOS_FVG_CONTINUATION',
        direction: dir,
        entry: entryLevel,
        stop: dir === 'RISE' ? fvg.lowerPrice - atr * 0.5 : fvg.upperPrice + atr * 0.5,
        targets,
        score: clamp(58 + (latestBreak.momentumConfirmed ? 10 : 0) + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 6 : 0), 0, 100),
        reasons: [latestBreak.reason, fvg.reason, conf.detail],
        confirmations: ['BOS + FVG continuation'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time || latestBreak.time,
        strategy: 'BOS → FVG continuation',
      });
    }
  }

  // 4. Breaker-block retest (invalidated OB that reversed role).
  const breaker = obs.find((o) => o.roleReversed);
  if (breaker) {
    const dir: AiDirection = breaker.kind === 'BULLISH' ? 'FALL' : 'RISE';
    const entryLevel = dir === 'RISE' ? breaker.lowerPrice : breaker.upperPrice;
    const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
    const targets = targetFor(dir);
    drafts.push({
      modelId: 'SMC_BREAKER_RETEST',
      direction: dir,
      entry: entryLevel,
      stop: dir === 'RISE' ? breaker.lowerPrice - atr * 0.7 : breaker.upperPrice + atr * 0.7,
      targets,
      score: clamp(58 + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 6 : 0), 0, 100),
      reasons: [`${breaker.reason} Role reversed — the failed block now acts as a breaker.`, conf.detail],
      confirmations: ['Breaker role reversal'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Breaker retest',
    });
  }

  // 5. Order block + FVG confluence.
  if (freshOb && freshFvg) {
    const dir: AiDirection = freshOb.kind === 'BULLISH' ? 'RISE' : 'FALL';
    const fvgAgrees = (freshFvg.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir;
    const overlap = fvgAgrees && freshFvg.lowerPrice <= freshOb.upperPrice && freshFvg.upperPrice >= freshOb.lowerPrice;
    if (overlap) {
      const entryLevel = dir === 'RISE' ? freshOb.upperPrice : freshOb.lowerPrice;
      const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
      const targets = targetFor(dir);
      drafts.push({
        modelId: 'SMC_OB_FVG_CONFLUENCE',
        direction: dir,
        entry: entryLevel,
        stop: dir === 'RISE' ? freshOb.lowerPrice - atr * 0.6 : freshOb.upperPrice + atr * 0.6,
        targets,
        score: clamp(60 + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 6 : 0), 0, 100),
        reasons: ['Order block and fair value gap overlap — high-confluence point of interest.', freshOb.reason, freshFvg.reason, conf.detail],
        confirmations: ['OB + FVG confluence'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
        strategy: 'OB + FVG confluence',
      });
    }
  }

  // 6. OTE retracement within the dealing range.
  if (range && latestBreak) {
    const dir: AiDirection = latestBreak.direction === 'bullish' ? 'RISE' : 'FALL';
    const inDiscount = range.position === 'DISCOUNT';
    const inPremium = range.position === 'PREMIUM';
    if ((dir === 'RISE' && inDiscount) || (dir === 'FALL' && inPremium)) {
      const legLow = range.low;
      const legHigh = range.high;
      const ote = dir === 'RISE' ? legHigh - (legHigh - legLow) * 0.71 : legLow + (legHigh - legLow) * 0.71;
      const conf = m1Confirm(entry, dir, price, aiAtr(entry));
      const targets = targetFor(dir);
      drafts.push({
        modelId: 'SMC_OTE_RETRACEMENT',
        direction: dir,
        entry: ote,
        stop: dir === 'RISE' ? legLow - atr * 0.5 : legHigh + atr * 0.5,
        targets,
        score: clamp(56 + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 6 : 0), 0, 100),
        reasons: [
          `Price is in ${range.position.toLowerCase()} of the dealing range (${formatPrice(range.low, precision)}–${formatPrice(range.high, precision)}).`,
          `OTE retracement level ${formatPrice(ote, precision)} aligns with the ${dir} bias.`,
          conf.detail,
        ],
        confirmations: ['Premium/discount OTE'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
        strategy: 'OTE retracement',
      });
    }
  }

  // 7. Turtle Soup / liquidity raid reversal.
  if (latestSweep && !latestBreak) {
    const dir: AiDirection = latestSweep.side === 'SSL' ? 'RISE' : 'FALL';
    const conf = m1Confirm(entry, dir, latestSweep.level, aiAtr(entry));
    const targets = targetFor(dir);
    drafts.push({
      modelId: 'SMC_TURTLE_SOUP',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? latestSweep.extremePrice - atr * 0.5 : latestSweep.extremePrice + atr * 0.5,
      targets,
      score: clamp(55 + (latestSweep.followedByDisplacement ? 10 : 0) + (conf.confirmed ? 12 : 0), 0, 100),
      reasons: [
        latestSweep.reason,
        'A liquidity raid against the prior extreme — a Turtle Soup reversal while the level holds.',
        conf.detail,
      ],
      confirmations: ['Liquidity raid reversal'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || latestSweep.time,
      strategy: 'Turtle Soup',
    });
  }

  const best = drafts.sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = SMC_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate);

  // ---- Chart zones: fresh FVGs, order blocks, liquidity pools (unswept) ----
  const zones: AiZone[] = [];
  for (const f of fvgs.slice(0, 3)) {
    zones.push(
      makeZone({
        id: f.id,
        direction: f.kind === 'BULLISH' ? 'RISE' : 'FALL',
        label: `${f.kind === 'BULLISH' ? 'Bullish' : 'Bearish'} FVG`,
        upperPrice: f.upperPrice,
        lowerPrice: f.lowerPrice,
        quality: f.quality,
        fresh: f.state === 'FRESH',
        watch: price > f.upperPrice || price < f.lowerPrice,
        reason: f.reason,
      })
    );
  }
  for (const o of obs.slice(0, 3)) {
    zones.push(
      makeZone({
        id: o.id,
        direction: o.kind === 'BULLISH' ? 'RISE' : 'FALL',
        label: o.roleReversed ? 'Breaker' : 'Order block',
        upperPrice: o.upperPrice,
        lowerPrice: o.lowerPrice,
        quality: o.quality,
        fresh: !o.mitigated,
        watch: price > o.upperPrice || price < o.lowerPrice,
        reason: o.reason,
      })
    );
  }
  for (const p of pools.filter((x) => !x.swept).slice(0, 2)) {
    zones.push(
      makeZone({
        id: p.id,
        direction: p.side === 'BSL' ? 'FALL' : 'RISE',
        label: p.side === 'BSL' ? 'Buy-side liquidity' : 'Sell-side liquidity',
        upperPrice: p.upperPrice,
        lowerPrice: p.lowerPrice,
        quality: p.touches >= 2 ? 75 : 55,
        fresh: true,
        watch: p.side === 'BSL' ? price < p.price : price > p.price,
        reason: p.reason,
      })
    );
  }

  const timeframes: AiTimeframeRead[] = buildTimeframeReads({
    m15: `${condition.condition.replace(/_/g, ' ').toLowerCase()} — ${condition.detail}`,
    m15Tone: bias === 'bullish' ? 'bull' : bias === 'bearish' ? 'bear' : 'neutral',
    m5: ms.structureLabel || 'No clear M5 structure',
    m5Tone: ms.direction === 'BULLISH' ? 'bull' : ms.direction === 'BEARISH' ? 'bear' : 'neutral',
    m1: best ? (best.confirmed ? 'M1 entry confirmed.' : 'M1 confirmation pending.') : 'No M1 confirmation.',
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
      modelLabel: SMC_MODEL_LABELS[best.modelId] ?? best.modelId,
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
          ? 'A close below the point of interest invalidates the bullish sequence.'
          : 'A close above the point of interest invalidates the bearish sequence.',
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
      : `${condition.condition.replace(/_/g, ' ').toLowerCase()} — no validated SMC/ICT sequence.`;

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
      signal || !best ? undefined : `Best SMC setup scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

export const smcEngine = analyzeSmcInstrument;
