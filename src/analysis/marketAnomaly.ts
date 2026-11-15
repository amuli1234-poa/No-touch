import { computeAdxSeries, computeRsiSeries } from './indicators';
import { computeAtrSeries, detectSwings, getCandleStats, type SwingPoint } from './swings';
import { confirmedOnly } from './trendlineDetection';
import type { Candle, TimeframeKey } from '../types/market';

/**
 * MARKET INTELLIGENCE & ANOMALY DETECTION ENGINE (independent, duration-free).
 *
 * It reads ONLY real candles. It never fabricates data, never predicts with certainty and
 * never conflates unusual-but-legitimate market behaviour with a data-feed failure. Every
 * threshold adapts to the instrument's OWN historical baseline (robust median + MAD), so the
 * same detector behaves sensibly on Volatility 10 and Volatility 250 alike.
 */

export type AnomalySeverity = 'NORMAL' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL_DATA';
export type AnomalyClass = 'PRICE' | 'VOLATILITY' | 'STRUCTURAL' | 'DATA';

export const ANOMALY_SEVERITY_ORDER: readonly AnomalySeverity[] = [
  'NORMAL',
  'LOW',
  'MODERATE',
  'HIGH',
  'CRITICAL_DATA',
];

export const ANOMALY_SEVERITY_LABELS: Record<AnomalySeverity, string> = {
  NORMAL: 'Normal',
  LOW: 'Low anomaly',
  MODERATE: 'Moderate anomaly',
  HIGH: 'High anomaly',
  CRITICAL_DATA: 'Critical data issue',
};

export interface AnomalyFinding {
  id: string;
  symbol: string;
  displayName: string;
  class: AnomalyClass;
  kind: string;
  severity: AnomalySeverity;
  timeframe: TimeframeKey;
  detectedAt: number;
  evidence: string;
  impact: string;
  action: string;
  metric: number | null;
  baseline: number | null;
  /** Robust z-score against the instrument's own baseline (null for absolute facts). */
  zScore: number | null;
}

export interface AdaptiveBaseline {
  atr: number;
  atrRatio: number;
  rangeMedianAtr: number;
  bodyRatioMedian: number;
  volatilityDispersion: number;
  consecutiveMedian: number;
  sampleSize: number;
}

export interface EarlyWarning {
  id: string;
  kind: string;
  severity: AnomalySeverity;
  evidence: string;
  /** Early warnings are NOT confirmed events; this is always false. */
  confirmed: false;
}

export type RegimeKind =
  | 'STRONG_BULLISH'
  | 'STRONG_BEARISH'
  | 'WEAK_TREND'
  | 'SIDEWAYS'
  | 'CONSOLIDATION'
  | 'VOLATILITY_COMPRESSION'
  | 'VOLATILITY_EXPANSION'
  | 'POTENTIAL_REVERSAL'
  | 'TRANSITIONAL';

export interface RegimeRead {
  regime: RegimeKind;
  detail: string;
  confidence: number;
}

export interface DataHealth {
  stale: boolean;
  missingCandles: number;
  duplicateTimes: number;
  outOfOrder: number;
  lastBarAgeSec: number;
  healthy: boolean;
}

export interface StrategySuitability {
  module: string;
  verdict: 'SUITABLE' | 'CAUTION' | 'WAIT';
  reason: string;
}

export interface AnomalyReport {
  symbol: string;
  displayName: string;
  timeframe: TimeframeKey;
  price: number;
  severity: AnomalySeverity;
  findings: AnomalyFinding[];
  earlyWarnings: EarlyWarning[];
  regime: RegimeRead;
  baseline: AdaptiveBaseline;
  dataHealth: DataHealth;
  suitability: StrategySuitability[];
  summary: string;
  analyzedAt: number;
}

export interface AnalyzeAnomalyParams {
  symbol: string;
  displayName: string;
  timeframe: TimeframeKey;
  granularitySec: number;
  candles: readonly Candle[];
  /** Wall-clock seconds used for the staleness check. */
  nowSec?: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function medianAbsoluteDeviation(values: readonly number[], med: number): number {
  if (values.length === 0) return 0;
  return median(values.map((v) => Math.abs(v - med)));
}

/** Robust z-score: 0.6745 normalises the MAD to a standard-deviation equivalent. */
function robustZ(value: number, med: number, mad: number): number | null {
  if (mad <= 0) return null;
  return (0.6745 * (value - med)) / mad;
}

export function severityFromZ(z: number | null): AnomalySeverity {
  if (z === null) return 'NORMAL';
  const a = Math.abs(z);
  if (a >= 5) return 'HIGH';
  if (a >= 3.5) return 'MODERATE';
  if (a >= 2.5) return 'LOW';
  return 'NORMAL';
}

export function computeBaseline(candles: readonly Candle[]): AdaptiveBaseline {
  const bars = confirmedOnly(candles);
  if (bars.length < 10) {
    return {
      atr: 0,
      atrRatio: 0,
      rangeMedianAtr: 0,
      bodyRatioMedian: 0,
      volatilityDispersion: 0,
      consecutiveMedian: 1,
      sampleSize: bars.length,
    };
  }
  const atrs = computeAtrSeries(bars, 14);
  const atr = atrs[atrs.length - 1] || 0;
  const ranges = bars.map((c) => c.high - c.low);
  const bodyRatios = bars.map((c) => getCandleStats(c).bodyRatio);
  const rangeMedian = median(ranges);
  const rangeMedianAtr = atr > 0 ? rangeMedian / atr : 0;
  const bodyRatioMedian = median(bodyRatios);

  // Dispersion of the range distribution → how volatile volatility itself is.
  const mad = medianAbsoluteDeviation(ranges, rangeMedian);
  const volatilityDispersion = rangeMedian > 0 ? mad / rangeMedian : 0;

  // Median run length of same-direction candles.
  const runs: number[] = [];
  let run = 1;
  for (let i = 1; i < bars.length; i++) {
    const same =
      (bars[i].close >= bars[i].open) === (bars[i - 1].close >= bars[i - 1].open);
    if (same) run += 1;
    else {
      runs.push(run);
      run = 1;
    }
  }
  runs.push(run);

  return {
    atr,
    atrRatio: bars[bars.length - 1].close > 0 ? atr / bars[bars.length - 1].close : 0,
    rangeMedianAtr,
    bodyRatioMedian,
    volatilityDispersion,
    consecutiveMedian: median(runs),
    sampleSize: bars.length,
  };
}

/** DATA anomalies are ABSOLUTE facts — never inferred from unusual price behaviour. */
export function detectDataAnomalies(params: {
  candles: readonly Candle[];
  granularitySec: number;
  nowSec: number;
}): DataHealth {
  const { candles, granularitySec, nowSec } = params;
  if (candles.length === 0) {
    return {
      stale: true,
      missingCandles: 0,
      duplicateTimes: 0,
      outOfOrder: 0,
      lastBarAgeSec: Number.POSITIVE_INFINITY,
      healthy: false,
    };
  }
  let duplicateTimes = 0;
  let outOfOrder = 0;
  let missingCandles = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta === 0) duplicateTimes += 1;
    else if (delta < 0) outOfOrder += 1;
    else if (granularitySec > 0) {
      const expected = Math.round(delta / granularitySec);
      if (expected > 1) missingCandles += expected - 1;
    }
  }
  const lastBarAgeSec = nowSec - candles[candles.length - 1].time;
  // A feed is stale only when it is genuinely behind (a few periods late), never merely
  // because the current candle is still forming.
  const stale = lastBarAgeSec > Math.max(90, granularitySec * 3);
  return {
    stale,
    missingCandles,
    duplicateTimes,
    outOfOrder,
    lastBarAgeSec,
    healthy: !stale && duplicateTimes === 0 && outOfOrder === 0,
  };
}

function makeFinding(
  base: { symbol: string; displayName: string; timeframe: TimeframeKey; now: number },
  f: Omit<AnomalyFinding, 'id' | 'symbol' | 'displayName' | 'timeframe' | 'detectedAt'>
): AnomalyFinding {
  return {
    id: `${base.symbol}-${f.class}-${f.kind}`,
    symbol: base.symbol,
    displayName: base.displayName,
    timeframe: base.timeframe,
    detectedAt: base.now,
    ...f,
  };
}

export function detectPriceAnomalies(
  candles: readonly Candle[],
  baseline: AdaptiveBaseline
): { kind: string; severity: AnomalySeverity; evidence: string; metric: number; z: number | null }[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 20 || baseline.atr <= 0) return [];
  const out: { kind: string; severity: AnomalySeverity; evidence: string; metric: number; z: number | null }[] = [];

  const ranges = bars.map((c) => c.high - c.low);
  const rangeMedian = median(ranges);
  const rangeMad = medianAbsoluteDeviation(ranges, rangeMedian);
  const last = bars[bars.length - 1];
  const lastRange = last.high - last.low;
  const lastBody = Math.abs(last.close - last.open);
  const stats = getCandleStats(last);

  const largeZ = robustZ(lastRange, rangeMedian, rangeMad);
  if (severityFromZ(largeZ) !== 'NORMAL' && largeZ !== null && largeZ > 0) {
    out.push({
      kind: 'UNUSUALLY_LARGE_CANDLE',
      severity: severityFromZ(largeZ),
      evidence: `Latest candle range ${lastRange.toFixed(5)} is ${(lastRange / (rangeMedian || 1)).toFixed(2)}× the median range.`,
      metric: lastRange,
      z: largeZ,
    });
  }
  const smallZ = robustZ(lastRange, rangeMedian, rangeMad);
  if (severityFromZ(smallZ) !== 'NORMAL' && smallZ !== null && smallZ < 0) {
    out.push({
      kind: 'ABNORMALLY_SMALL_CANDLE',
      severity: severityFromZ(smallZ),
      evidence: `Latest candle range is ${(lastRange / (rangeMedian || 1)).toFixed(2)}× the median — abnormal contraction.`,
      metric: lastRange,
      z: smallZ,
    });
  }

  // Sudden price jump: close-to-close gap in ATR units.
  const gap = Math.abs(last.close - bars[bars.length - 2].close);
  const gapAtr = gap / baseline.atr;
  if (gapAtr >= 2.5) {
    out.push({
      kind: 'SUDDEN_PRICE_JUMP',
      severity: gapAtr >= 4 ? 'HIGH' : gapAtr >= 3 ? 'MODERATE' : 'LOW',
      evidence: `Close-to-close move of ${gapAtr.toFixed(2)}× ATR — an unexpected price jump.`,
      metric: gap,
      z: null,
    });
  }

  // Wick-to-body ratio anomaly (rejection signature or unstable print).
  const wickRatio = lastBody > 0 ? (lastRange - lastBody) / lastBody : Number.POSITIVE_INFINITY;
  if (lastBody > 0 && wickRatio >= 6) {
    out.push({
      kind: 'UNUSUAL_WICK_TO_BODY',
      severity: wickRatio >= 12 ? 'MODERATE' : 'LOW',
      evidence: `Wick-to-body ratio ${wickRatio.toFixed(1)} — a rejection/extreme print.`,
      metric: wickRatio,
      z: null,
    });
  }

  // Abnormal consecutive same-direction sequence.
  let run = 1;
  for (let i = bars.length - 1; i > 0; i--) {
    const same = (bars[i].close >= bars[i].open) === (bars[i - 1].close >= bars[i - 1].open);
    if (!same) break;
    run += 1;
  }
  if (run >= Math.max(6, baseline.consecutiveMedian * 4)) {
    out.push({
      kind: 'ABNORMAL_CONSECUTIVE_SEQUENCE',
      severity: run >= 9 ? 'MODERATE' : 'LOW',
      evidence: `${run} consecutive ${stats.isBullish ? 'bullish' : 'bearish'} candles (median run ${baseline.consecutiveMedian}).`,
      metric: run,
      z: null,
    });
  }

  return out;
}

export function detectVolatilityAnomalies(
  candles: readonly Candle[],
  baseline: AdaptiveBaseline
): { kind: string; severity: AnomalySeverity; evidence: string; metric: number; z: number | null }[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 30 || baseline.atr <= 0) return [];
  const out: { kind: string; severity: AnomalySeverity; evidence: string; metric: number; z: number | null }[] = [];

  const atrs = computeAtrSeries(bars, 14);
  const recent = atrs.slice(-10).filter((v) => v > 0);
  const history = atrs.slice(-60, -10).filter((v) => v > 0);
  if (recent.length < 5 || history.length < 10) return [];

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const historyMed = median(history);
  const historyMad = medianAbsoluteDeviation(history, historyMed);
  const z = robustZ(recentAvg, historyMed, historyMad);
  const ratio = historyMed > 0 ? recentAvg / historyMed : 1;

  if (ratio >= 1.5) {
    out.push({
      kind: 'VOLATILITY_EXPANSION',
      severity: severityFromZ(z) === 'NORMAL' ? 'LOW' : severityFromZ(z),
      evidence: `Recent ATR is ${ratio.toFixed(2)}× the prior baseline — volatility expanding.`,
      metric: recentAvg,
      z,
    });
  } else if (ratio <= 0.65) {
    out.push({
      kind: 'VOLATILITY_CONTRACTION',
      severity: severityFromZ(z) === 'NORMAL' ? 'LOW' : severityFromZ(z),
      evidence: `Recent ATR is ${ratio.toFixed(2)}× the prior baseline — volatility compressing.`,
      metric: recentAvg,
      z,
    });
  }

  // Volatility spike: latest ATR far outside its own recent dispersion.
  const lastAtr = atrs[atrs.length - 1];
  const spikeZ = robustZ(lastAtr, historyMed, historyMad);
  if (spikeZ !== null && spikeZ >= 4) {
    out.push({
      kind: 'VOLATILITY_SPIKE',
      severity: spikeZ >= 6 ? 'HIGH' : 'MODERATE',
      evidence: `Latest ATR is a ${spikeZ.toFixed(1)}σ spike against the instrument's own baseline.`,
      metric: lastAtr,
      z: spikeZ,
    });
  }

  return out;
}

export function detectStructuralAnomalies(
  candles: readonly Candle[],
  baseline: AdaptiveBaseline
): { kind: string; severity: AnomalySeverity; evidence: string; metric: number | null; z: number | null }[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 40 || baseline.atr <= 0) return [];
  const out: { kind: string; severity: AnomalySeverity; evidence: string; metric: number | null; z: number | null }[] = [];
  const swings = detectSwings(bars, 3, 3);
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');
  if (highs.length < 2 || lows.length < 2) return [];

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const lastBar = bars[bars.length - 1];
  const buffer = baseline.atr * 0.25;

  // Failed breakout: a swing high was exceeded but price closed back below it.
  const brokeHigh = bars.some((c, i) => i > lastHigh.index && c.high > lastHigh.price);
  const closedBackBelow = lastBar.close < lastHigh.price - buffer;
  if (brokeHigh && closedBackBelow) {
    out.push({
      kind: 'FALSE_BREAKOUT',
      severity: 'MODERATE',
      evidence: `Price exceeded the last swing high ${lastHigh.price.toFixed(5)} then closed back below it — a failed breakout.`,
      metric: lastHigh.price,
      z: null,
    });
  }
  const brokeLow = bars.some((c, i) => i > lastLow.index && c.low < lastLow.price);
  const closedBackAbove = lastBar.close > lastLow.price + buffer;
  if (brokeLow && closedBackAbove) {
    out.push({
      kind: 'FAILED_BREAKDOWN',
      severity: 'MODERATE',
      evidence: `Price broke the last swing low ${lastLow.price.toFixed(5)} then reclaimed it — a failed breakdown.`,
      metric: lastLow.price,
      z: null,
    });
  }

  // Abnormal liquidity sweep: a deep wick beyond a swing that closes back inside.
  const sweptHigh = lastBar.high > lastHigh.price + buffer && lastBar.close < lastHigh.price;
  const sweptLow = lastBar.low < lastLow.price - buffer && lastBar.close > lastLow.price;
  if (sweptHigh || sweptLow) {
    out.push({
      kind: 'ABNORMAL_LIQUIDITY_SWEEP',
      severity: 'LOW',
      evidence: `Latest candle swept liquidity beyond a swing ${sweptHigh ? 'high' : 'low'} and closed back inside — a sharp reversal print.`,
      metric: sweptHigh ? lastHigh.price : lastLow.price,
      z: null,
    });
  }

  // Sudden change in swing structure (higher highs turning into lower highs).
  if (highs.length >= 3) {
    const [h1, h2, h3] = highs.slice(-3);
    const rising = h2.price > h1.price && h3.price > h2.price;
    const falling = h2.price < h1.price && h3.price < h2.price;
    const transition = (h2.price > h1.price && h3.price < h2.price) || (h2.price < h1.price && h3.price > h2.price);
    if (transition && !rising && !falling) {
      out.push({
        kind: 'SWING_STRUCTURE_SHIFT',
        severity: 'LOW',
        evidence: 'Swing-high sequence just reversed direction — a sudden change in structure.',
        metric: null,
        z: null,
      });
    }
  }

  return out;
}

export function classifyRegime(
  candles: readonly Candle[],
  baseline: AdaptiveBaseline
): RegimeRead {
  const bars = confirmedOnly(candles);
  if (bars.length < 40 || baseline.atr <= 0) {
    return { regime: 'TRANSITIONAL', detail: 'Not enough confirmed candles for a regime read.', confidence: 0 };
  }
  const closes = bars.map((c) => c.close);
  const adxSeries = computeAdxSeries(bars, 14).filter((v): v is number => v !== null);
  const rsiSeries = computeRsiSeries(closes, 14).filter((v): v is number => v !== null);
  const adx = adxSeries[adxSeries.length - 1] ?? 0;
  const rsi = rsiSeries[rsiSeries.length - 1] ?? 50;

  const window = bars.slice(-30);
  const first = window[0].close;
  const last = window[window.length - 1].close;
  const netMove = last - first;
  const netAtr = Math.abs(netMove) / baseline.atr;
  const rangeHigh = Math.max(...window.map((c) => c.high));
  const rangeLow = Math.min(...window.map((c) => c.low));
  const heightAtr = (rangeHigh - rangeLow) / baseline.atr;

  const atrs = computeAtrSeries(bars, 14);
  const recentAtr = atrs.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const priorAtr = atrs.slice(-30, -8).reduce((a, b) => a + b, 0) / Math.max(1, atrs.slice(-30, -8).length);
  const volRatio = priorAtr > 0 ? recentAtr / priorAtr : 1;

  if (volRatio <= 0.7) {
    return {
      regime: 'VOLATILITY_COMPRESSION',
      detail: `Recent ATR is ${volRatio.toFixed(2)}× the prior baseline — a squeeze is building.`,
      confidence: 70,
    };
  }
  if (volRatio >= 1.5 && adx < 25) {
    return {
      regime: 'VOLATILITY_EXPANSION',
      detail: `ATR expanded ${volRatio.toFixed(2)}× without trend strength — unstable expansion.`,
      confidence: 65,
    };
  }
  if (adx >= 25 && netAtr >= 3 && Math.abs(netMove) > 0) {
    const bullish = netMove > 0;
    return {
      regime: bullish ? 'STRONG_BULLISH' : 'STRONG_BEARISH',
      detail: `ADX ${adx.toFixed(0)} with a ${netAtr.toFixed(1)}× ATR directional move over 30 bars.`,
      confidence: 80,
    };
  }
  if (adx >= 18 && netAtr >= 1.5) {
    return {
      regime: netMove > 0 ? 'WEAK_TREND' : 'WEAK_TREND',
      detail: `ADX ${adx.toFixed(0)} — a directional bias exists but the trend is not strong.`,
      confidence: 55,
    };
  }
  if (heightAtr <= 4) {
    return {
      regime: 'CONSOLIDATION',
      detail: `The last 30 bars span only ${heightAtr.toFixed(1)}× ATR — tight consolidation.`,
      confidence: 70,
    };
  }
  if (rsi >= 72 || rsi <= 28) {
    return {
      regime: 'POTENTIAL_REVERSAL',
      detail: `RSI at ${rsi.toFixed(0)} with a range-bound structure — a reversal risk is elevated.`,
      confidence: 50,
    };
  }
  return {
    regime: 'SIDEWAYS',
    detail: `Range height ${heightAtr.toFixed(1)}× ATR with ADX ${adx.toFixed(0)} — sideways conditions.`,
    confidence: 60,
  };
}

export function detectEarlyWarnings(
  candles: readonly Candle[],
  baseline: AdaptiveBaseline
): EarlyWarning[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 30 || baseline.atr <= 0) return [];
  const out: EarlyWarning[] = [];

  const ranges = bars.slice(-24).map((c) => c.high - c.low);
  const firstHalf = median(ranges.slice(0, 12));
  const secondHalf = median(ranges.slice(12));
  if (firstHalf > 0 && secondHalf / firstHalf >= 1.3) {
    out.push({
      id: 'early-range-expansion',
      kind: 'INCREASING_CANDLE_RANGES',
      severity: 'LOW',
      evidence: `Median candle range grew ${(secondHalf / firstHalf).toFixed(2)}× over the last 24 bars.`,
      confirmed: false,
    });
  }

  const closes = bars.map((c) => c.close);
  const rsi = computeRsiSeries(closes, 14).filter((v): v is number => v !== null);
  if (rsi.length >= 8) {
    const recent = rsi.slice(-4).reduce((a, b) => a + b, 0) / 4;
    const prior = rsi.slice(-8, -4).reduce((a, b) => a + b, 0) / 4;
    if (prior - recent >= 8) {
      out.push({
        id: 'early-momentum-decline',
        kind: 'DECLINING_MOMENTUM',
        severity: 'LOW',
        evidence: `RSI fell from ${prior.toFixed(0)} to ${recent.toFixed(0)} — momentum is fading.`,
        confirmed: false,
      });
    } else if (recent - prior >= 8) {
      out.push({
        id: 'early-momentum-acceleration',
        kind: 'MOMENTUM_ACCELERATION',
        severity: 'LOW',
        evidence: `RSI rose from ${prior.toFixed(0)} to ${recent.toFixed(0)} — momentum is accelerating.`,
        confirmed: false,
      });
    }
  }

  const atrs = computeAtrSeries(bars, 14);
  const recentAtr = atrs.slice(-6).reduce((a, b) => a + b, 0) / 6;
  const priorAtr = atrs.slice(-18, -6).reduce((a, b) => a + b, 0) / Math.max(1, atrs.slice(-18, -6).length);
  if (priorAtr > 0 && recentAtr / priorAtr <= 0.7) {
    out.push({
      id: 'early-volatility-compression',
      kind: 'VOLATILITY_COMPRESSION',
      severity: 'LOW',
      evidence: `ATR contracted to ${(recentAtr / priorAtr).toFixed(2)}× — a squeeze often precedes expansion.`,
      confirmed: false,
    });
  }

  // Repeated failed breakouts near the same level.
  const swings = detectSwings(bars, 3, 3).filter((s) => s.type === 'high');
  if (swings.length >= 2) {
    const target = swings[swings.length - 1].price;
    const attempts = bars.filter((c) => c.high >= target - baseline.atr * 0.2 && c.close < target);
    if (attempts.length >= 2) {
      out.push({
        id: 'early-repeated-failed-breakouts',
        kind: 'REPEATED_FAILED_BREAKOUTS',
        severity: 'LOW',
        evidence: `${attempts.length} failed attempts to hold above ${target.toFixed(5)} — supply is absorbing demand.`,
        confirmed: false,
      });
    }
  }

  return out;
}

/**
 * Connects anomaly intelligence to the existing AI modules: it never disables a strategy,
 * it only states whether the current conditions still support that module's assumptions.
 */
export function assessStrategySuitability(params: {
  findings: readonly { kind: string; severity: AnomalySeverity }[];
  regime: RegimeKind;
  dataHealthy: boolean;
}): StrategySuitability[] {
  const { findings, regime, dataHealthy } = params;
  const has = (kind: string) => findings.some((f) => f.kind === kind);
  const high = findings.some((f) => f.severity === 'HIGH');
  const out: StrategySuitability[] = [];

  if (!dataHealthy) {
    return [
      {
        module: 'All modules',
        verdict: 'WAIT',
        reason: 'The live feed is stale or inconsistent — analysis is unreliable until data resumes.',
      },
    ];
  }

  const breakoutFavoured = has('VOLATILITY_EXPANSION') || regime === 'VOLATILITY_EXPANSION';
  const breakoutHurt = has('FALSE_BREAKOUT') || has('FAILED_BREAKDOWN');

  out.push({
    module: 'Breakout & Retest models',
    verdict: breakoutHurt ? 'CAUTION' : breakoutFavoured ? 'SUITABLE' : 'SUITABLE',
    reason: breakoutHurt
      ? 'A failed breakout just occurred — wait for a candle-close confirmation before acting.'
      : breakoutFavoured
        ? 'Volatility expansion detected — breakout strategies may be more suitable; wait for candle-close confirmation.'
        : 'No conflicting structural evidence for breakout continuation.',
  });

  out.push({
    module: 'Trend & Pullback models',
    verdict: high && regime === 'TRANSITIONAL' ? 'CAUTION' : 'SUITABLE',
    reason:
      regime === 'VOLATILITY_EXPANSION'
        ? 'Expansion without trend strength — pullback entries are less reliable.'
        : 'Trend assumptions are consistent with the current regime.',
  });

  out.push({
    module: 'Range & Mean-Reversion models',
    verdict:
      regime === 'SIDEWAYS' || regime === 'CONSOLIDATION' || regime === 'VOLATILITY_COMPRESSION'
        ? 'SUITABLE'
        : 'CAUTION',
    reason:
      regime === 'STRONG_BULLISH' || regime === 'STRONG_BEARISH'
        ? 'A directional trend is in force — counter-trend range entries carry added risk.'
        : 'Range conditions support mean-reversion entries at the validated extremes.',
  });

  if (has('ABNORMAL_CONSECUTIVE_SEQUENCE') || has('SUDDEN_PRICE_JUMP')) {
    out.push({
      module: 'Immediate entries',
      verdict: 'WAIT',
      reason: 'Unusual price sequence — avoid immediate entries until market structure stabilises.',
    });
  }

  return out;
}

function worstSeverity(findings: readonly { severity: AnomalySeverity }[], data: DataHealth): AnomalySeverity {
  if (!data.healthy && (data.stale || data.duplicateTimes > 0 || data.outOfOrder > 0)) return 'CRITICAL_DATA';
  let worst: AnomalySeverity = 'NORMAL';
  for (const f of findings) {
    if (ANOMALY_SEVERITY_ORDER.indexOf(f.severity) > ANOMALY_SEVERITY_ORDER.indexOf(worst)) {
      worst = f.severity;
    }
  }
  return worst;
}

/** Full anomaly read for one instrument/timeframe. Reads only real candles. */
export function analyzeMarketAnomaly(params: AnalyzeAnomalyParams): AnomalyReport {
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
  const now = nowSec * 1000;
  const bars = confirmedOnly(params.candles);
  const baseline = computeBaseline(params.candles);
  const dataHealth = detectDataAnomalies({
    candles: params.candles,
    granularitySec: params.granularitySec,
    nowSec,
  });

  const base = {
    symbol: params.symbol,
    displayName: params.displayName,
    timeframe: params.timeframe,
    now,
  };

  const findings: AnomalyFinding[] = [];

  if (!dataHealth.healthy) {
    const parts: string[] = [];
    if (dataHealth.stale) parts.push(`last bar is ${Math.round(dataHealth.lastBarAgeSec)}s old`);
    if (dataHealth.missingCandles > 0) parts.push(`${dataHealth.missingCandles} missing candles`);
    if (dataHealth.duplicateTimes > 0) parts.push(`${dataHealth.duplicateTimes} duplicate timestamps`);
    if (dataHealth.outOfOrder > 0) parts.push(`${dataHealth.outOfOrder} out-of-order bars`);
    findings.push(
      makeFinding(base, {
        class: 'DATA',
        kind: 'DATA_FEED_ISSUE',
        severity: 'CRITICAL_DATA',
        evidence: `Data integrity check failed: ${parts.join(', ')}.`,
        impact: 'Every module reading this feed is unreliable until the feed recovers.',
        action: 'Wait for the live feed to reconnect and repopulate before acting on any setup.',
        metric: null,
        baseline: null,
        zScore: null,
      })
    );
  }

  for (const f of detectPriceAnomalies(params.candles, baseline)) {
    findings.push(
      makeFinding(base, {
        class: 'PRICE',
        kind: f.kind,
        severity: f.severity,
        evidence: f.evidence,
        impact: 'Unusual candle behaviour can invalidate entry timing assumptions.',
        action: 'Prefer waiting for a candle close before acting.',
        metric: f.metric,
        baseline: baseline.atr,
        zScore: f.z,
      })
    );
  }
  for (const f of detectVolatilityAnomalies(params.candles, baseline)) {
    findings.push(
      makeFinding(base, {
        class: 'VOLATILITY',
        kind: f.kind,
        severity: f.severity,
        evidence: f.evidence,
        impact: 'Volatility regime shifts change which strategy assumptions hold.',
        action:
          f.kind === 'VOLATILITY_EXPANSION' || f.kind === 'VOLATILITY_SPIKE'
            ? 'Breakout strategies may be more suitable; require candle-close confirmation.'
            : 'Compression can precede expansion — avoid chasing and wait for the break.',
        metric: f.metric,
        baseline: baseline.atr,
        zScore: f.z,
      })
    );
  }
  for (const f of detectStructuralAnomalies(params.candles, baseline)) {
    findings.push(
      makeFinding(base, {
        class: 'STRUCTURAL',
        kind: f.kind,
        severity: f.severity,
        evidence: f.evidence,
        impact: 'Structure assumptions may be temporarily invalid.',
        action: 'Re-check the structure read before committing to a continuation entry.',
        metric: f.metric,
        baseline: baseline.atr,
        zScore: f.z,
      })
    );
  }

  const earlyWarnings = detectEarlyWarnings(params.candles, baseline);
  const regime = classifyRegime(params.candles, baseline);
  const severity = worstSeverity(findings, dataHealth);
  const suitability = assessStrategySuitability({
    findings: findings.map((f) => ({ kind: f.kind, severity: f.severity })),
    regime: regime.regime,
    dataHealthy: dataHealth.healthy,
  });

  const price = bars.length > 0 ? bars[bars.length - 1].close : 0;
  const summary =
    severity === 'NORMAL'
      ? `${params.displayName} is behaving within its own normal range (${regime.regime.replace(/_/g, ' ').toLowerCase()}).`
      : `${params.displayName}: ${ANOMALY_SEVERITY_LABELS[severity].toLowerCase()} — ${findings.length} finding(s), regime ${regime.regime.replace(/_/g, ' ').toLowerCase()}.`;

  return {
    symbol: params.symbol,
    displayName: params.displayName,
    timeframe: params.timeframe,
    price,
    severity,
    findings,
    earlyWarnings,
    regime,
    baseline,
    dataHealth,
    suitability,
    summary,
    analyzedAt: now,
  };
}
