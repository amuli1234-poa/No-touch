import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  clamp,
  emaLast,
  makeZone,
  orderTargets,
  readAiCondition,
  rsiLast,
  smaLast,
  stdevLast,
  statusForScore,
} from './aiCommon';
import { computeAdxSeries, computeMacdSeries, computeRsiSeries } from './indicators';
import { detectSwings, getCandleStats } from './swings';
import { confirmedOnly } from './trendlineDetection';
import type {
  AiDirection,
  AiInstrumentAnalysis,
  AiMarketCondition,
  AiSignal,
  AiTimeframeRead,
  AiZone,
} from '../types/aiModule';
import type { Candle, MarketFamily } from '../types/market';
import { formatPrice } from '../utils/derivParser';

/**
 * TECHNICAL AI — adaptive indicator engine.
 *
 * Independent engine: it classifies the market condition first, then applies ONLY the
 * strategy appropriate to that condition (trend continuation / range mean-reversion /
 * breakout / reversal). Indicators confirm price action — they never create a signal on
 * their own, and overbought/oversold is never treated as an automatic reversal.
 */

export const TECHNICAL_PUBLICATION_MIN_SCORE = 85;

export const TECH_MODEL_LABELS: Record<string, string> = {
  TECH_EMA_PULLBACK: 'EMA Pullback Continuation',
  TECH_MOMENTUM_CONTINUATION: 'Momentum Continuation',
  TECH_MACD_SHIFT: 'MACD Momentum Shift',
  TECH_RSI_DIVERGENCE: 'RSI Divergence + Confirmation',
  TECH_BB_BREAKOUT: 'Bollinger Breakout',
  TECH_BB_MEAN_REVERSION: 'Bollinger Mean Reversion',
  TECH_ADX_CONTINUATION: 'ADX Trend Continuation',
  TECH_VOLATILITY_EXPANSION: 'Volatility Expansion Breakout',
  TECH_CONFLUENCE: 'Technical Confluence Entry',
};

export interface TechnicalEngineParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  structureCandles: readonly Candle[];
  setupCandles: readonly Candle[];
  entryCandles: readonly Candle[];
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
}

interface TechRead {
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  sma20: number | null;
  rsi: number | null;
  stochRsi: number | null;
  cci: number | null;
  roc: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  macdHistPrev: number | null;
  adx: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  kcUpper: number | null;
  kcLower: number | null;
  atr: number;
}

function computeCci(candles: readonly Candle[], period = 20): number | null {
  const bars = confirmedOnly(candles);
  if (bars.length < period) return null;
  const typical = bars.map((c) => (c.high + c.low + c.close) / 3);
  const window = typical.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  let dev = 0;
  for (const t of window) dev += Math.abs(t - mean);
  const meanDev = dev / period;
  if (meanDev === 0) return 0;
  return (typical[typical.length - 1] - mean) / (0.015 * meanDev);
}

function computeStochRsi(candles: readonly Candle[], period = 14): number | null {
  const bars = confirmedOnly(candles);
  const rsi = computeRsiSeries(
    bars.map((c) => c.close),
    period
  ).filter((v): v is number => v !== null);
  if (rsi.length < period) return null;
  const window = rsi.slice(-period);
  const high = Math.max(...window);
  const low = Math.min(...window);
  if (high === low) return 50;
  return ((rsi[rsi.length - 1] - low) / (high - low)) * 100;
}

function computeRoc(candles: readonly Candle[], period = 10): number | null {
  const bars = confirmedOnly(candles);
  if (bars.length <= period) return null;
  const now = bars[bars.length - 1].close;
  const then = bars[bars.length - 1 - period].close;
  if (then === 0) return null;
  return ((now - then) / then) * 100;
}

function readIndicators(candles: readonly Candle[]): TechRead {
  const bars = confirmedOnly(candles);
  const closes = bars.map((c) => c.close);
  const atr = aiAtr(bars);
  const macd = computeMacdSeries(closes);
  const adxSeries = computeAdxSeries(bars, 14);
  const bbMid = smaLast(closes, 20);
  const sd = stdevLast(closes, 20);
  const bbWidth = bbMid && sd ? (sd * 4) / bbMid : null;
  return {
    ema9: emaLast(closes, 9),
    ema20: emaLast(closes, 20),
    ema50: emaLast(closes, 50),
    ema200: emaLast(closes, 200),
    sma20: bbMid,
    rsi: rsiLast(bars, 14),
    stochRsi: computeStochRsi(bars, 14),
    cci: computeCci(bars, 20),
    roc: computeRoc(bars, 10),
    macd: macd.macd[macd.macd.length - 1] ?? null,
    macdSignal: macd.signal[macd.signal.length - 1] ?? null,
    macdHist: macd.histogram[macd.histogram.length - 1] ?? null,
    macdHistPrev: macd.histogram[macd.histogram.length - 2] ?? null,
    adx: adxSeries[adxSeries.length - 1] ?? null,
    bbUpper: bbMid && sd ? bbMid + sd * 2 : null,
    bbLower: bbMid && sd ? bbMid - sd * 2 : null,
    bbWidth,
    kcUpper: bbMid ? bbMid + atr * 1.5 : null,
    kcLower: bbMid ? bbMid - atr * 1.5 : null,
    atr,
  };
}

/** Recent swing highs/lows for structural targets. */
function structuralLevels(candles: readonly Candle[]): { highs: number[]; lows: number[] } {
  const bars = confirmedOnly(candles);
  const swings = detectSwings(bars, 3, 3);
  return {
    highs: swings.filter((s) => s.type === 'high').map((s) => s.price),
    lows: swings.filter((s) => s.type === 'low').map((s) => s.price),
  };
}

/** M1 entry confirmation: a directional body close with momentum agreement. */
function m1TechConfirm(
  entry: readonly Candle[],
  direction: AiDirection,
  atr: number
): { confirmed: boolean; time: number; detail: string } {
  const bars = confirmedOnly(entry);
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--) {
    const bar = bars[i];
    const stats = getCandleStats(bar);
    const dirOk = direction === 'RISE' ? stats.isBullish : stats.isBearish;
    if (dirOk && stats.body >= atr * 0.35 && stats.closePosition > 0.55 === (direction === 'RISE')) {
      return {
        confirmed: true,
        time: bar.time,
        detail: `M1 confirmed with a ${
          direction === 'RISE' ? 'bullish' : 'bearish'
        } body (${(stats.body / atr).toFixed(2)}× ATR) and a ${
          direction === 'RISE' ? 'strong' : 'weak'
        } close.`,
      };
    }
  }
  return { confirmed: false, time: 0, detail: 'M1 entry confirmation pending.' };
}

export function analyzeTechnicalInstrument(params: TechnicalEngineParams): AiInstrumentAnalysis {
  const { symbol, displayName, precision, marketFamily, dataHealth } = params;
  const structure = confirmedOnly(params.structureCandles);
  const setup = confirmedOnly(params.setupCandles);
  const entry = confirmedOnly(params.entryCandles);

  const lastOf = (arr: readonly Candle[]) => (arr.length ? arr[arr.length - 1] : null);
  const price = lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastOf(structure)?.close ?? 0;
  const atr = aiAtr(setup.length ? setup : structure);
  const condition = readAiCondition(structure, aiAtr(structure));
  const read = readIndicators(setup.length ? setup : structure);

  const base: AiInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status: 'ANALYSING',
    statusExplanation: 'Classifying the market condition…',
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

  if (setup.length < 60 || entry.length < 5 || atr <= 0) {
    return {
      ...base,
      statusExplanation: 'Insufficient confirmed candles for the technical read.',
      rejectionReason: 'Not enough data.',
    };
  }

  const { highs, lows } = structuralLevels(setup);
  const conditionLabel = condition.condition;

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

  const momentumUp = (read.macdHist ?? 0) > 0 && (read.rsi ?? 50) >= 50;
  const momentumDown = (read.macdHist ?? 0) < 0 && (read.rsi ?? 50) <= 50;
  const bullStack =
    read.ema9 !== null && read.ema20 !== null && read.ema50 !== null && read.ema9 > read.ema20 && read.ema20 > read.ema50;
  const bearStack =
    read.ema9 !== null && read.ema20 !== null && read.ema50 !== null && read.ema9 < read.ema20 && read.ema20 < read.ema50;

  const trending = conditionLabel === 'STRONG_BULLISH' || conditionLabel === 'STRONG_BEARISH' || conditionLabel === 'WEAK_TREND';
  const expansion = conditionLabel === 'VOLATILITY_EXPANSION';
  const ranging = conditionLabel === 'RANGING' || conditionLabel === 'CONSOLIDATION';

  if (trending && (bullStack || bearStack)) {
    const direction: AiDirection = bullStack ? 'RISE' : 'FALL';
    const pullbackLevel = direction === 'RISE' ? read.ema20 ?? price : read.ema20 ?? price;
    const conf = m1TechConfirm(entry, direction, aiAtr(entry));
    const targets = orderTargets(direction, price, direction === 'RISE' ? highs : lows).slice(0, 3);
    const aligned = (direction === 'RISE' ? momentumUp : momentumDown) && (read.adx ?? 0) >= 20;
    const score = clamp(
      55 +
        (aligned ? 14 : 4) +
        (conf.confirmed ? 12 : 0) +
        (targets.length >= 2 ? 8 : 2) +
        (read.ema200 !== null && (direction === 'RISE' ? price > read.ema200 : price < read.ema200) ? 6 : 0),
      0,
      100
    );
    drafts.push({
      modelId: aligned ? 'TECH_ADX_CONTINUATION' : 'TECH_EMA_PULLBACK',
      direction,
      entry: pullbackLevel,
      stop: direction === 'RISE' ? pullbackLevel - atr * 1.5 : pullbackLevel + atr * 1.5,
      targets,
      score,
      reasons: [
        `M15 ${condition.bias} structure with EMA stack ${
          direction === 'RISE' ? 'bullish' : 'bearish'
        } aligned.`,
        `ADX ${(read.adx ?? 0).toFixed(1)} · MACD histogram ${(read.macdHist ?? 0).toFixed(4)} · RSI ${(read.rsi ?? 0).toFixed(1)}.`,
        conf.detail,
      ],
      confirmations: [aligned ? 'Momentum + ADX agree' : 'Momentum not yet aligned'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Trend continuation',
    });
  }

  if (expansion && read.bbUpper !== null && read.bbLower !== null) {
    const direction: AiDirection = price > read.bbUpper ? 'RISE' : price < read.bbLower ? 'FALL' : 'RISE';
    const conf = m1TechConfirm(entry, direction, aiAtr(entry));
    const targets = orderTargets(direction, price, direction === 'RISE' ? highs : lows).slice(0, 3);
    drafts.push({
      modelId: 'TECH_VOLATILITY_EXPANSION',
      direction,
      entry: price,
      stop: direction === 'RISE' ? read.bbLower ?? price - atr * 1.5 : read.bbUpper ?? price + atr * 1.5,
      targets,
      score: clamp(58 + (conf.confirmed ? 14 : 0) + (targets.length >= 2 ? 8 : 2), 0, 100),
      reasons: [
        'Volatility is expanding — range broke out of the Bollinger envelope.',
        `BB width ${(read.bbWidth ?? 0).toFixed(4)} · ROC ${(read.roc ?? 0).toFixed(2)}%.`,
        conf.detail,
      ],
      confirmations: ['Volatility expansion'],
      confirmed: conf.confirmed,
      confirmationTime: conf.time,
      strategy: 'Breakout / expansion',
    });
  }

  if (ranging && read.bbUpper !== null && read.bbLower !== null && read.rsi !== null) {
    if (price >= read.bbUpper - atr * 0.2 && read.rsi >= 60) {
      const conf = m1TechConfirm(entry, 'FALL', aiAtr(entry));
      const targets = orderTargets('FALL', price, [read.bbLower, ...lows]).slice(0, 3);
      drafts.push({
        modelId: 'TECH_BB_MEAN_REVERSION',
        direction: 'FALL',
        entry: price,
        stop: (read.bbUpper ?? price) + atr * 0.6,
        targets,
        score: clamp(56 + (conf.confirmed ? 14 : 0) + (targets.length >= 2 ? 8 : 2), 0, 100),
        reasons: [
          'Ranging market — price at the upper Bollinger band with RSI elevated.',
          'Mean-reversion toward the range mid is favoured while the range holds.',
          conf.detail,
        ],
        confirmations: ['Range extreme + RSI'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
        strategy: 'Range mean reversion',
      });
    } else if (price <= read.bbLower + atr * 0.2 && read.rsi <= 40) {
      const conf = m1TechConfirm(entry, 'RISE', aiAtr(entry));
      const targets = orderTargets('RISE', price, [read.bbUpper, ...highs]).slice(0, 3);
      drafts.push({
        modelId: 'TECH_BB_MEAN_REVERSION',
        direction: 'RISE',
        entry: price,
        stop: (read.bbLower ?? price) - atr * 0.6,
        targets,
        score: clamp(56 + (conf.confirmed ? 14 : 0) + (targets.length >= 2 ? 8 : 2), 0, 100),
        reasons: [
          'Ranging market — price at the lower Bollinger band with RSI depressed.',
          'Mean-reversion toward the range mid is favoured while the range holds.',
          conf.detail,
        ],
        confirmations: ['Range extreme + RSI'],
        confirmed: conf.confirmed,
        confirmationTime: conf.time,
        strategy: 'Range mean reversion',
      });
    }
  }

  if (conditionLabel === 'POTENTIAL_REVERSAL' || conditionLabel === 'UNCLEAR') {
    // Momentum shift model — MACD histogram flip with price confirmation.
    if (read.macdHist !== null && read.macdHistPrev !== null) {
      const flippedUp = read.macdHistPrev < 0 && read.macdHist > 0;
      const flippedDown = read.macdHistPrev > 0 && read.macdHist < 0;
      if (flippedUp || flippedDown) {
        const direction: AiDirection = flippedUp ? 'RISE' : 'FALL';
        const conf = m1TechConfirm(entry, direction, aiAtr(entry));
        const targets = orderTargets(direction, price, direction === 'RISE' ? highs : lows).slice(0, 3);
        drafts.push({
          modelId: 'TECH_MACD_SHIFT',
          direction,
          entry: price,
          stop: direction === 'RISE' ? price - atr * 1.4 : price + atr * 1.4,
          targets,
          score: clamp(55 + (conf.confirmed ? 14 : 0), 0, 100),
          reasons: [
            `MACD histogram flipped ${direction === 'RISE' ? 'positive' : 'negative'} — momentum shifting.`,
            conf.detail,
          ],
          confirmations: ['MACD momentum shift'],
          confirmed: conf.confirmed,
          confirmationTime: conf.time,
          strategy: 'Momentum shift',
        });
      }
    }
  }

  const best = drafts.sort((a, b) => b.score - a.score)[0] ?? null;
  const bestScore = best?.score ?? 0;
  const gate = TECHNICAL_PUBLICATION_MIN_SCORE;
  const status = statusForScore(bestScore, gate);

  const timeframes: AiTimeframeRead[] = buildTimeframeReads({
    m15: `${conditionLabel.replace(/_/g, ' ').toLowerCase()} — ${condition.detail}`,
    m15Tone: condition.bias === 'bullish' ? 'bull' : condition.bias === 'bearish' ? 'bear' : 'neutral',
    m5: best
      ? `${best.strategy}: MACD hist ${(read.macdHist ?? 0).toFixed(4)}, RSI ${(read.rsi ?? 0).toFixed(
          1
        )}, ADX ${(read.adx ?? 0).toFixed(1)}.`
      : 'No indicator confluence at the gate.',
    m5Tone: best ? (best.confirmed ? 'bull' : 'warn') : 'neutral',
    m1: best ? (best.confirmed ? 'M1 entry confirmed.' : 'M1 entry confirmation pending.') : 'No M1 confirmation.',
    m1Tone: best?.confirmed ? 'bull' : 'neutral',
  });

  const zones: AiZone[] = [];
  if (read.bbUpper !== null && read.bbLower !== null) {
    zones.push(
      makeZone({
        id: `${symbol}-bb-upper`,
        direction: 'FALL',
        label: 'Upper band',
        upperPrice: read.bbUpper + atr * 0.1,
        lowerPrice: read.bbUpper - atr * 0.1,
        quality: 55,
        fresh: true,
        watch: price < read.bbUpper,
        reason: `Upper Bollinger band at ${formatPrice(read.bbUpper, precision)} — mean-reversion reaction zone.`,
      }),
      makeZone({
        id: `${symbol}-bb-lower`,
        direction: 'RISE',
        label: 'Lower band',
        upperPrice: read.bbLower + atr * 0.1,
        lowerPrice: read.bbLower - atr * 0.1,
        quality: 55,
        fresh: true,
        watch: price > read.bbLower,
        reason: `Lower Bollinger band at ${formatPrice(read.bbLower, precision)} — mean-reversion reaction zone.`,
      })
    );
  }

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
      modelLabel: TECH_MODEL_LABELS[best.modelId] ?? best.modelId,
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
          ? 'A close below the invalidation level negates the bullish momentum setup.'
          : 'A close above the invalidation level negates the bearish momentum setup.',
      reasons: best.reasons,
      confirmations: best.confirmations,
      timeframes,
      confirmedBarTime: best.confirmationTime,
    });
  }

  const statusExplanation = signal
    ? `${signal.direction} confirmed — ${signal.modelLabel} (${signal.strategyLabel}).`
    : best
      ? `${best.strategy} developing; score ${Math.round(bestScore)}/100 — ${
          best.confirmed ? 'below the publication gate.' : 'waiting for M1 confirmation.'
        }`
      : `${conditionLabel.replace(/_/g, ' ').toLowerCase()} — no indicator confluence to trade.`;

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
      signal || !best ? undefined : `Best technical setup scored ${Math.round(bestScore)}/100 — below the ${gate} gate.`,
  };
}

export const technicalEngine = analyzeTechnicalInstrument;
