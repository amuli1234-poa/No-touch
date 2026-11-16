import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  ladderTimeframeReads,
  timeframeConditionRead,
  clamp,
  structurallyValidDrafts,
  dealingRange,
  makeZone,
  resolveTargets,
  readAiCondition,
  statusForScore,
  m1LevelConfirm,
} from './aiCommon';
import { analyzeMarketStructure } from './structure';
import { computeAtrSeries, detectSwings } from './swings';
import { detectFvgs, detectOrderBlocks, detectSweeps, detectLiquidityPools } from './smcTools';
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
 * FVG & IMBALANCE AI — displacement-imbalance engine.
 *
 * Independent engine: it validates genuine three-candle imbalances, tracks their
 * freshness/mitigation lifecycle and only trades a retracement with structural
 * confirmation. Fully-mitigated / invalidated imbalances are never shown as fresh.
 */

export const FVG_PUBLICATION_MIN_SCORE = 85;

export const FVG_MODEL_LABELS: Record<string, string> = {
  FVG_FRESH_RETEST: 'Fresh FVG Retest',
  FVG_WITH_SWEEP: 'FVG + Liquidity Sweep',
  FVG_BOS_CONTINUATION: 'FVG + BOS Continuation',
  FVG_CHOCH_REVERSAL: 'FVG + CHOCH Reversal',
  FVG_OB_CONFLUENCE: 'FVG + Order-Block Confluence',
  FVG_DISPLACEMENT: 'FVG + Displacement',
  IFVG_RETEST: 'Inverse FVG Retest',
  FVG_CE_ENTRY: 'Consequent-Encroachment Entry',
};

export interface FvgEngineParams {
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
  level: number,
  atr: number
): { confirmed: boolean; time: number; detail: string } {
  return m1LevelConfirm(
    entry,
    direction,
    level,
    atr,
    0.1,
    (stats) =>
      `M1 rejected from the imbalance at ${formatPrice(level, 2)} with a ${(
        stats.body / atr
      ).toFixed(2)}× ATR body.`,
    'M1 reaction at the imbalance pending.'
  );
}

export function analyzeFvgInstrument(params: FvgEngineParams): AiInstrumentAnalysis {
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
    statusExplanation: 'Validating displacement imbalances…',
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
      statusExplanation: 'Insufficient confirmed candles for the imbalance read.',
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
  const latestBreak = ms.latestBreak;
  const latestSweep = sweeps.find((s) => s.genuine);

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

  // Targets are anchored to the ACTUAL entry (the FVG boundary), never the current price.
  const targetFor = (direction: AiDirection, entry: number): number[] =>
    resolveTargets(direction, entry, direction === 'RISE' ? highs : lows, atr);

  const tradeable = fvgs.filter(
    (f) => f.state === 'FRESH' || f.state === 'APPROACHING' || f.state === 'TESTED'
  );

  for (const f of tradeable) {
    const dir: AiDirection = f.kind === 'BULLISH' ? 'RISE' : 'FALL';
    const entryLevel = dir === 'RISE' ? f.upperPrice : f.lowerPrice;
    const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
    const targets = targetFor(dir, entryLevel);
    const inDiscount = range
      ? dir === 'RISE'
        ? range.position === 'DISCOUNT'
        : range.position === 'PREMIUM'
      : false;
    const obConfluence = obs.find(
      (o) => (o.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir && o.upperPrice >= f.lowerPrice && o.lowerPrice <= f.upperPrice
    );
    const bosAgrees = latestBreak && (latestBreak.direction === 'bullish' ? 'RISE' : 'FALL') === dir;
    const sweepAgrees = latestSweep && (latestSweep.side === 'SSL' ? 'RISE' : 'FALL') === dir;

    let modelId = 'FVG_FRESH_RETEST';
    if (sweepAgrees && latestBreak?.kind === 'CHOCH') modelId = 'FVG_CHOCH_REVERSAL';
    else if (sweepAgrees) modelId = 'FVG_WITH_SWEEP';
    else if (bosAgrees) modelId = 'FVG_BOS_CONTINUATION';
    else if (obConfluence) modelId = 'FVG_OB_CONFLUENCE';
    else if (f.displacementAtr >= 1.6) modelId = 'FVG_DISPLACEMENT';

    const score = clamp(
      52 +
        Math.min(12, f.quality / 8) +
        (inDiscount ? 8 : 0) +
        (sweepAgrees ? 8 : 0) +
        (bosAgrees ? 6 : 0) +
        (obConfluence ? 6 : 0) +
        (conf.confirmed ? 12 : 0) +
        (targets.length >= 2 ? 6 : 0),
      0,
      100
    );

    drafts.push({
      modelId,
      direction: dir,
      entry: entryLevel,
      stop: dir === 'RISE' ? f.lowerPrice - atr * 0.5 : f.upperPrice + atr * 0.5,
      targets,
      score,
      reasons: [
        f.reason,
        inDiscount
          ? `Imbalance sits in ${range?.position.toLowerCase()} of the dealing range.`
          : 'Imbalance outside the discount/premium extreme.',
        sweepAgrees ? 'Preceded by a liquidity sweep in the same direction.' : 'No same-direction sweep preceding the imbalance.',
        obConfluence ? 'Order block overlaps the imbalance — high confluence.' : 'No overlapping order block.',
        conf.detail,
      ],
      confirmations: [
        modelId === 'FVG_OB_CONFLUENCE' ? 'FVG + OB confluence' : 'Validated three-candle imbalance',
      ],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || f.time,
      strategy: FVG_MODEL_LABELS[modelId] ?? 'FVG retracement',
    });
  }

  // IFVG retest — a broken FVG whose role has reversed.
  for (const f of fvgs.filter((x) => x.state === 'IFVG')) {
    const dir: AiDirection = f.kind === 'BULLISH' ? 'FALL' : 'RISE';
    const entryLevel = f.kind === 'BULLISH' ? f.lowerPrice : f.upperPrice;
    const conf = m1Confirm(entry, dir, entryLevel, aiAtr(entry));
    drafts.push({
      modelId: 'IFVG_RETEST',
      direction: dir,
      entry: entryLevel,
      stop: f.kind === 'BULLISH' ? f.upperPrice + atr * 0.5 : f.lowerPrice - atr * 0.5,
      targets: targetFor(dir, entryLevel),
      score: clamp(54 + (conf.confirmed ? 12 : 0) + (targetFor(dir, entryLevel).length >= 2 ? 6 : 0), 0, 100),
      reasons: [
        `${f.kind === 'BULLISH' ? 'Bullish' : 'Bearish'} imbalance was broken — now an inverse FVG acting as ${
          dir === 'RISE' ? 'support' : 'resistance'
        }.`,
        conf.detail,
      ],
      confirmations: ['Inverse FVG role reversal'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time || f.time,
      strategy: 'IFVG retest',
    });
  }

  const best = structurallyValidDrafts(drafts).sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = FVG_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate, best?.confirmed === true);

  // ---- Chart zones: fresh / approaching imbalances (future if ahead of price) ----
  const zones: AiZone[] = [];
  for (const f of fvgs.slice(0, 6)) {
    if (f.state === 'FULLY_MITIGATED') continue;
    const isBull = f.kind === 'BULLISH';
    zones.push(
      makeZone({
        id: f.id,
        direction: isBull ? 'RISE' : 'FALL',
        label: f.state === 'IFVG' ? 'IFVG' : `${isBull ? 'Bullish' : 'Bearish'} FVG`,
        upperPrice: f.upperPrice,
        lowerPrice: f.lowerPrice,
        quality: f.quality,
        fresh: f.state === 'FRESH',
        watch: isBull ? price > f.upperPrice : price < f.lowerPrice,
        reason: f.reason,
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
    m5: `${tradeable.length} tradeable imbalance(s) · ${fvgs.filter((f) => f.state === 'IFVG').length} IFVG(s)`,
    m5Tone: tradeable.length > 0 ? 'warn' : 'neutral',
    m1: best ? (best.confirmed ? 'M1 rejection confirmed at the imbalance.' : 'M1 rejection pending.') : 'No M1 confirmation.',
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
      modelLabel: FVG_MODEL_LABELS[best.modelId] ?? best.modelId,
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
          ? 'A close below the imbalance invalidates the bullish retracement setup.'
          : 'A close above the imbalance invalidates the bearish retracement setup.',
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
          best.confirmed ? 'below the publication gate.' : 'waiting for M1 rejection.'
        }`
      : tradeable.length > 0
        ? `${tradeable.length} imbalance(s) tracked; none has produced a confirmed rejection yet.`
        : 'No genuine displacement imbalance in play.';

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
      signal || !best ? undefined : `Best FVG setup scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

export const fvgEngine = analyzeFvgInstrument;
