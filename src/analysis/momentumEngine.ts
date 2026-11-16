import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  ladderTimeframeReads,
  timeframeConditionRead,
  clamp,
  structurallyValidDrafts,
  emaLast,
  makeZone,
  confluenceBonus,
  resolveTargets,
  rsiLast,
  smaLast,
  stdevLast,
  statusForScore,
  m1BodyConfirm,
} from './aiCommon';
import { computeAdxSeries, computeMacdSeries } from './indicators';
import { detectSwings } from './swings';
import { confirmedOnly } from './trendlineDetection';
import type {
  AiDirection,
  AiInstrumentAnalysis,
  AiMarketCondition,
  AiSignal,
  AiTimeframeRead,
  AiZone,
} from '../types/aiModule';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import { formatPrice } from '../utils/derivParser';

/**
 * MOMENTUM & VOLATILITY AI — independent momentum/volatility regime engine.
 *
 * It classifies the volatility regime and momentum state first, then applies ONLY the
 * model that fits (continuation / compression breakout / expansion / exhaustion reversal).
 * Overbought/oversold is never treated as an automatic reversal, and thresholds adapt to
 * each index's own volatility.
 */

export const MOMENTUM_PUBLICATION_MIN_SCORE = 85;

export type VolatilityRegime =
  | 'LOW'
  | 'NORMAL'
  | 'HIGH'
  | 'COMPRESSION'
  | 'EXPANSION'
  | 'UNSTABLE';

export const MOMENTUM_MODEL_LABELS: Record<string, string> = {
  MOM_CONTINUATION: 'Momentum Continuation',
  MOM_PULLBACK_RECOVERY: 'Momentum Pullback & Recovery',
  MOM_COMPRESSION_BREAKOUT: 'Volatility Compression Breakout',
  MOM_EXPANSION_CONTINUATION: 'Volatility Expansion Continuation',
  MOM_DIVERGENCE_REVERSAL: 'Momentum Divergence Reversal',
  MOM_TREND_STRENGTH: 'Trend-Strength Continuation',
  MOM_EXHAUSTION_REVERSAL: 'Momentum Exhaustion Reversal',
  MOM_BREAKOUT_RETEST: 'Breakout & Retest',
};

export interface MomentumEngineParams {
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

interface MomentumRead {
  rsi: number | null;
  rsiPrev: number | null;
  macdHist: number | null;
  macdHistPrev: number | null;
  adx: number | null;
  atr: number;
  atrAvg: number;
  bbWidth: number | null;
  bbWidthAvg: number | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  stdev: number | null;
  avgRange: number;
  recentRange: number;
}

function bbWidthSeries(candles: readonly Candle[]): number[] {
  const out: number[] = [];
  const closes = candles.map((c) => c.close);
  for (let i = 20; i <= closes.length; i++) {
    const slice = closes.slice(i - 20, i);
    const mean = slice.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    out.push(mean === 0 ? 0 : (sd * 4) / mean);
  }
  return out;
}

function readMomentum(candles: readonly Candle[]): MomentumRead {
  const bars = confirmedOnly(candles);
  const closes = bars.map((c) => c.close);
  const atr = aiAtr(bars);
  const macd = computeMacdSeries(closes);
  const adxSeries = computeAdxSeries(bars, 14);
  const rsiSeries = closes.length ? rsiLast(bars, 14) : null;
  const rsiPrevSeries = bars.length > 2 ? rsiLast(bars.slice(0, -1), 14) : null;
  const widths = bbWidthSeries(bars);
  const atrSeries = bars.map((_, i) => aiAtr(bars.slice(0, i + 1)));
  const atrAvg = atrSeries.length > 20 ? atrSeries.slice(-20).reduce((a, b) => a + b, 0) / 20 : atr;
  const ranges = bars.slice(-14).map((c) => c.high - c.low);
  return {
    rsi: rsiSeries,
    rsiPrev: rsiPrevSeries,
    macdHist: macd.histogram[macd.histogram.length - 1] ?? null,
    macdHistPrev: macd.histogram[macd.histogram.length - 2] ?? null,
    adx: adxSeries[adxSeries.length - 1] ?? null,
    atr,
    atrAvg,
    bbWidth: widths[widths.length - 1] ?? null,
    bbWidthAvg: widths.length > 20 ? widths.slice(-20).reduce((a, b) => a + b, 0) / 20 : null,
    ema9: emaLast(closes, 9),
    ema20: emaLast(closes, 20),
    ema50: emaLast(closes, 50),
    stdev: stdevLast(closes, 20),
    avgRange: ranges.reduce((a, b) => a + b, 0) / Math.max(1, ranges.length),
    recentRange: bars.length ? bars[bars.length - 1].high - bars[bars.length - 1].low : 0,
  };
}

function classifyVolatility(read: MomentumRead): VolatilityRegime {
  if (read.bbWidth === null || read.bbWidthAvg === null || read.bbWidthAvg === 0) return 'NORMAL';
  const ratio = read.bbWidth / read.bbWidthAvg;
  const atrRatio = read.atrAvg > 0 ? read.atr / read.atrAvg : 1;
  if (ratio < 0.6) return 'COMPRESSION';
  if (ratio > 1.6 || atrRatio > 1.6) return read.recentRange > read.avgRange * 2.4 ? 'UNSTABLE' : 'EXPANSION';
  if (ratio > 1.25) return 'HIGH';
  if (ratio < 0.8) return 'LOW';
  return 'NORMAL';
}

function momentumState(read: MomentumRead): {
  state: 'ACCELERATING_UP' | 'ACCELERATING_DOWN' | 'WEAKENING' | 'EXHAUSTED' | 'NEUTRAL';
  direction: 'bullish' | 'bearish' | 'neutral';
  detail: string;
} {
  const { macdHist, macdHistPrev, rsi } = read;
  if (macdHist === null || macdHistPrev === null || rsi === null) {
    return { state: 'NEUTRAL', direction: 'neutral', detail: 'Momentum indicators not yet available.' };
  }
  const rising = macdHist > macdHistPrev;
  if (macdHist > 0 && rising && rsi >= 50) {
    return { state: 'ACCELERATING_UP', direction: 'bullish', detail: `MACD histogram rising (${macdHist.toFixed(4)}), RSI ${rsi.toFixed(1)}.` };
  }
  if (macdHist < 0 && !rising && rsi <= 50) {
    return { state: 'ACCELERATING_DOWN', direction: 'bearish', detail: `MACD histogram falling (${macdHist.toFixed(4)}), RSI ${rsi.toFixed(1)}.` };
  }
  if ((macdHist > 0 && !rising) || (macdHist < 0 && rising)) {
    return { state: 'WEAKENING', direction: macdHist > 0 ? 'bullish' : 'bearish', detail: 'Momentum histogram is contracting — follow-through fading.' };
  }
  return { state: 'NEUTRAL', direction: 'neutral', detail: 'Momentum is flat.' };
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
      `M1 confirmed the ${direction === 'RISE' ? 'bullish' : 'bearish'} momentum with a ${(
        stats.body / atr
      ).toFixed(2)}× ATR body.`,
    'M1 momentum confirmation pending.'
  );
}

export function analyzeMomentumInstrument(params: MomentumEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth } = params;
  const structure = confirmedOnly(params.structureCandles);
  const setup = confirmedOnly(params.setupCandles);
  const entry = confirmedOnly(params.entryCandles);

  const lastOf = (arr: readonly Candle[]) => (arr.length ? arr[arr.length - 1] : null);
  const price = lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastOf(structure)?.close ?? 0;
  const read = readMomentum(setup.length ? setup : structure);
  const atr = read.atr;
  const volRegime = classifyVolatility(read);
  const mom = momentumState(read);

  const condition: AiMarketCondition =
    volRegime === 'COMPRESSION'
      ? 'VOLATILITY_CONTRACTION'
      : volRegime === 'EXPANSION' || volRegime === 'UNSTABLE'
        ? 'VOLATILITY_EXPANSION'
        : mom.state === 'EXHAUSTED'
          ? 'POTENTIAL_REVERSAL'
          : mom.direction === 'bullish' && (read.adx ?? 0) >= 22
            ? 'STRONG_BULLISH'
            : mom.direction === 'bearish' && (read.adx ?? 0) >= 22
              ? 'STRONG_BEARISH'
              : mom.direction === 'neutral'
                ? 'RANGING'
                : 'WEAK_TREND';

  const base: AiInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status: 'ANALYSING',
    statusExplanation: 'Measuring momentum and volatility…',
    condition,
    timeframes: [],
    signal: null,
    activeZones: [],
    watchZones: [],
    bestScore: 0,
    atr,
    dataHealth,
    lastUpdated: Date.now(),
  };

  if (setup.length < 60 || entry.length < 5 || atr <= 0) {
    return {
      ...base,
      statusExplanation: 'Insufficient confirmed candles for the momentum read.',
      rejectionReason: 'Not enough data.',
    };
  }

  const swings = detectSwings(setup, 3, 3);
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

  const targetFor = (direction: AiDirection): number[] =>
    resolveTargets(direction, price, direction === 'RISE' ? highs : lows, atr);

  const bullStack =
    read.ema9 !== null && read.ema20 !== null && read.ema50 !== null && read.ema9 > read.ema20 && read.ema20 > read.ema50;
  const bearStack =
    read.ema9 !== null && read.ema20 !== null && read.ema50 !== null && read.ema9 < read.ema20 && read.ema20 < read.ema50;

  // 1/2. Momentum continuation / pullback recovery in a trending regime.
  if ((mom.state === 'ACCELERATING_UP' || mom.state === 'ACCELERATING_DOWN') && (bullStack || bearStack)) {
    const dir: AiDirection = bullStack ? 'RISE' : 'FALL';
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    const targets = targetFor(dir);
    const volatilityOk = volRegime === 'NORMAL' || volRegime === 'HIGH' || volRegime === 'EXPANSION';
    // The EMA pullback stop must stay on the invalidation side of the market entry; when
    // the EMA sits beyond price the stop is clamped so it can never invert the trade.
    const emaStop = dir === 'RISE' ? (read.ema20 ?? price - atr * 1.5) - atr * 0.5 : (read.ema20 ?? price + atr * 1.5) + atr * 0.5;
    const stop = dir === 'RISE' ? Math.min(emaStop, price - atr * 0.5) : Math.max(emaStop, price + atr * 0.5);
    drafts.push({
      modelId: volRegime === 'EXPANSION' ? 'MOM_EXPANSION_CONTINUATION' : 'MOM_CONTINUATION',
      direction: dir,
      entry: price,
      stop,
      targets,
      score: clamp(
        56 + (volatilityOk ? 10 : 0) + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 8 : 0) + ((read.adx ?? 0) >= 25 ? 6 : 0) + confluenceBonus({ trendAligned: bullStack || bearStack, momentumConfirmed: true, displacement: volRegime === 'EXPANSION' }),
        0,
        100
      ),
      reasons: [mom.detail, `Volatility regime: ${volRegime.toLowerCase()}.`, conf.detail],
      confirmations: ['Momentum acceleration + EMA alignment'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: volRegime === 'EXPANSION' ? 'Expansion continuation' : 'Momentum continuation',
    });
  }

  // 3. Volatility compression breakout.
  if (volRegime === 'COMPRESSION') {
    const dir: AiDirection = price >= (read.ema20 ?? price) ? 'RISE' : 'FALL';
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    const targets = targetFor(dir);
    const strongBody = read.recentRange > read.avgRange * 1.2;
    drafts.push({
      modelId: strongBody ? 'MOM_COMPRESSION_BREAKOUT' : 'MOM_BREAKOUT_RETEST',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? price - atr * 1.6 : price + atr * 1.6,
      targets,
      score: clamp(
        55 + (strongBody ? 12 : 4) + (conf.confirmed ? 12 : 0) + (targets.length >= 2 ? 6 : 0) + confluenceBonus({ displacement: strongBody }),
        0,
        100
      ),
      reasons: [
        'Volatility is compressing — a breakout is developing.',
        strongBody ? 'The latest candle shows expansion out of the compression.' : 'Awaiting displacement out of compression.',
        conf.detail,
      ],
      confirmations: ['Volatility compression'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Compression breakout',
    });
  }

  // 7. Momentum exhaustion reversal (requires weakening momentum + RSI divergence).
  const exhaustion =
    mom.state === 'WEAKENING' &&
    read.rsi !== null &&
    read.rsiPrev !== null &&
    ((mom.direction === 'bullish' && read.rsi < read.rsiPrev && read.rsi > 65) ||
      (mom.direction === 'bearish' && read.rsi > read.rsiPrev && read.rsi < 35));
  if (exhaustion) {
    const dir: AiDirection = mom.direction === 'bullish' ? 'FALL' : 'RISE';
    const conf = m1Confirm(entry, dir, aiAtr(entry));
    const targets = targetFor(dir);
    drafts.push({
      modelId: 'MOM_DIVERGENCE_REVERSAL',
      direction: dir,
      entry: price,
      stop: dir === 'RISE' ? price - atr * 1.4 : price + atr * 1.4,
      targets,
      score: clamp(54 + (conf.confirmed ? 14 : 0) + confluenceBonus({ displacement: true }), 0, 100),
      reasons: [
        `Momentum is weakening while RSI ${(read.rsi ?? 0).toFixed(1)} diverges from price — exhaustion.`,
        conf.detail,
      ],
      confirmations: ['Momentum divergence'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Exhaustion reversal',
    });
  }

  const best = structurallyValidDrafts(drafts).sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = MOMENTUM_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate, best?.confirmed === true);

  const zones: AiZone[] = [];
  if (read.ema20 !== null) {
    zones.push(
      makeZone({
        id: `${symbol}-ema20`,
        direction: price > read.ema20 ? 'RISE' : 'FALL',
        label: 'EMA20 pullback',
        upperPrice: read.ema20 + atr * 0.25,
        lowerPrice: read.ema20 - atr * 0.25,
        quality: 60,
        fresh: true,
        watch: true,
        reason: `EMA20 at ${formatPrice(read.ema20, precision)} — dynamic pullback/recovery level.`,
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
    m15: `${condition.replace(/_/g, ' ').toLowerCase()} · volatility ${volRegime.toLowerCase()}`,
    m15Tone: mom.direction === 'bullish' ? 'bull' : mom.direction === 'bearish' ? 'bear' : 'neutral',
    m5: `${mom.state.replace(/_/g, ' ').toLowerCase()} — ${mom.detail}`,
    m5Tone: mom.direction === 'bullish' ? 'bull' : mom.direction === 'bearish' ? 'bear' : 'neutral',
    m1: best ? (best.confirmed ? 'M1 momentum confirmed.' : 'M1 momentum confirmation pending.') : 'No M1 confirmation.',
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
      modelLabel: MOMENTUM_MODEL_LABELS[best.modelId] ?? best.modelId,
      strategyLabel: best.strategy,
      status: 'CONFIRMED',
      score: Math.round(bestScore),
      condition,
      entryPrice: best.entry,
      entryZoneLow: best.entry - atr * 0.2,
      entryZoneHigh: best.entry + atr * 0.2,
      stopLoss: best.stop,
      takeProfit1: tp[0] ?? best.entry + (best.direction === 'RISE' ? atr * 2 : -atr * 2),
      takeProfit2: tp[1] ?? best.entry + (best.direction === 'RISE' ? atr * 3.5 : -atr * 3.5),
      takeProfit3: tp[2] ?? null,
      invalidationCondition:
        best.direction === 'RISE'
          ? 'A close below the invalidation level signals momentum failure.'
          : 'A close above the invalidation level signals momentum failure.',
      reasons: best.reasons,
      confirmations: best.confirmations,
      timeframes,
      confirmedBarTime: best.confirmationTime,
    });
  }

  const statusExplanation = signal
    ? `${signal.direction} confirmed — ${signal.modelLabel} (volatility ${volRegime.toLowerCase()}).`
    : best
      ? `${best.strategy} developing; score ${Math.round(bestScore)}/100 — ${
          best.confirmed ? 'below the publication gate.' : 'waiting for M1 confirmation.'
        }`
      : `Momentum ${mom.state.replace(/_/g, ' ').toLowerCase()} · volatility ${volRegime.toLowerCase()} — no qualifying setup.`;

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
      signal || !best ? undefined : `Best momentum setup scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

export const momentumEngine = analyzeMomentumInstrument;
