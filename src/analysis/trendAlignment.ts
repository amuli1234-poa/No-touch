import type { StructureBreakEvent } from '../types/analysis';
import type { Candle } from '../types/market';
import type { TrendlineAlignment, TrendlineDominantTrend } from '../types/trendline';
import { formatPrice } from '../utils/derivParser';
import { getCandleStats, getRecentAverageBody } from './swings';

/**
 * TREND ALIGNMENT — establishes the market's dominant direction from the higher
 * timeframe (M15) and decides whether the trendline module may search for a setup.
 *
 * CORE RULE: in an uptrend only RISE continuations are searched (price pulls back and
 * rejects from below); in a downtrend only FALL continuations (price retraces and
 * rejects from above). A range or an unclear direction produces WAIT — the module never
 * forces an entry, and it never trades against the dominant trend unless a confirmed
 * market-structure reversal (CHOCH with momentum) has actually flipped the bias.
 */

/** A break this recent (in M15 bars) counts as the trend's continuation signal. */
const CONTINUATION_BREAK_RECENCY_BARS = 12;
/** A reversal must be at least this fresh to override the trend structure. */
const REVERSAL_RECENCY_BARS = 6;

export interface TrendAlignmentInput {
  structureCandles: readonly Candle[];
  structureDirection: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL';
  structureSequence: { hh: boolean; hl: boolean; lh: boolean; ll: boolean };
  breaks: readonly StructureBreakEvent[];
  atr: number;
  precision: number;
}

export function evaluateTrendAlignment(input: TrendAlignmentInput): TrendlineAlignment {
  const { structureCandles, structureDirection, structureSequence, breaks, atr, precision } = input;
  const confirmed = structureCandles.length > 2 ? structureCandles.slice(0, -1) : [...structureCandles];
  const lastIndex = confirmed.length - 1;

  const bullishStructure = structureSequence.hh && structureSequence.hl;
  const bearishStructure = structureSequence.lh && structureSequence.ll;

  // The most recent structural break, and whether it is still fresh.
  const lastBreak = breaks.length > 0 ? breaks[breaks.length - 1] : null;
  const breakAge = lastBreak ? lastIndex - lastBreak.index : Infinity;
  const breakFresh = breakAge <= CONTINUATION_BREAK_RECENCY_BARS;
  const breakDirection: 'bullish' | 'bearish' | null = lastBreak ? lastBreak.direction : null;

  // A confirmed reversal: a fresh CHOCH that contradicts the established trend
  // structure (or, absent structure, that is itself momentum-confirmed).
  const reversalConfirmed = Boolean(
    lastBreak &&
      lastBreak.kind === 'CHOCH' &&
      lastBreak.momentumConfirmed &&
      breakAge <= REVERSAL_RECENCY_BARS
  );

  let dominantTrend: TrendlineDominantTrend;
  let trendConfirmed: boolean;
  let tradableDirection: 'RISE' | 'FALL' | null;
  let reason: string;

  if (reversalConfirmed && lastBreak) {
    // A genuine structure flip. Only a bullish CHOCH may authorise RISE, etc.
    dominantTrend = lastBreak.direction === 'bullish' ? 'UPTREND' : 'DOWNTREND';
    trendConfirmed = true;
    tradableDirection = lastBreak.direction === 'bullish' ? 'RISE' : 'FALL';
    reason = `Confirmed market-structure reversal — ${lastBreak.reason} Trend flipped to ${
      lastBreak.direction === 'bullish' ? 'bullish' : 'bearish'
    }, so only ${tradableDirection} continuations are searched.`;
  } else if (bullishStructure && structureDirection === 'BULLISH') {
    dominantTrend = 'UPTREND';
    trendConfirmed = true;
    tradableDirection = 'RISE';
    reason = `Dominant M15 uptrend (higher highs & higher lows) — only RISE continuations are searched; FALL is ignored.`;
  } else if (bearishStructure && structureDirection === 'BEARISH') {
    dominantTrend = 'DOWNTREND';
    trendConfirmed = true;
    tradableDirection = 'FALL';
    reason = `Dominant M15 downtrend (lower highs & lower lows) — only FALL continuations are searched; RISE is ignored.`;
  } else if (structureDirection === 'BULLISH' && !bearishStructure) {
    dominantTrend = 'UPTREND';
    trendConfirmed = false;
    tradableDirection = null;
    reason = `Bullish M15 bias (higher high intact) but the trend is not confirmed with a clean HH/HL sequence — WAIT until structure confirms.`;
  } else if (structureDirection === 'BEARISH' && !bullishStructure) {
    dominantTrend = 'DOWNTREND';
    trendConfirmed = false;
    tradableDirection = null;
    reason = `Bearish M15 bias (lower low intact) but the trend is not confirmed with a clean LH/LL sequence — WAIT until structure confirms.`;
  } else {
    dominantTrend = 'RANGING';
    trendConfirmed = false;
    tradableDirection = null;
    reason = `M15 structure is ranging or the direction is unclear — WAIT rather than forcing a trend-continuation entry.`;
  }

  // A trend-continuation BOS is the preferred confirmation that price is still going
  // with the dominant trend (a BOS that agrees with the trend and is still fresh).
  let continuationBos: string | null = null;
  if (tradableDirection && lastBreak && lastBreak.kind === 'BOS' && breakFresh) {
    const agrees =
      (tradableDirection === 'RISE' && breakDirection === 'bullish') ||
      (tradableDirection === 'FALL' && breakDirection === 'bearish');
    if (agrees) {
      continuationBos = `${lastBreak.direction === 'bullish' ? 'Bullish' : 'Bearish'} BOS — body closed beyond ${
        lastBreak.brokenLevel ? formatPrice(lastBreak.brokenLevel, precision) : 'the protected level'
      }${lastBreak.momentumConfirmed ? ' with displacement' : ''}.`;
    }
  }

  return {
    dominantTrend,
    structureLabel: describeStructure(structureDirection, structureSequence),
    tradableDirection,
    trendConfirmed,
    reversalConfirmed,
    reason,
    continuationBos,
  };
}

function describeStructure(
  direction: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL',
  seq: { hh: boolean; hl: boolean; lh: boolean; ll: boolean }
): string {
  if (seq.hh && seq.hl) return 'Higher Highs & Higher Lows (HH / HL)';
  if (seq.lh && seq.ll) return 'Lower Highs & Lower Lows (LH / LL)';
  if (direction === 'BULLISH') return 'Bullish bias (higher high intact)';
  if (direction === 'BEARISH') return 'Bearish bias (lower low intact)';
  return 'Ranging / mixed swings';
}

/** True when the trend is still intact — the dominant trend's structure is unbroken. */
export function trendStillIntact(
  alignment: TrendlineAlignment,
  structureSequence: { hh: boolean; hl: boolean; lh: boolean; ll: boolean }
): boolean {
  if (alignment.dominantTrend === 'UPTREND') return structureSequence.hh || structureSequence.hl;
  if (alignment.dominantTrend === 'DOWNTREND') return structureSequence.lh || structureSequence.ll;
  return false;
}

/**
 * Confirmation strength 0..1 for a trend-continuation rejection. A rejection candle with
 * a strong close is good; a rejection followed by a continuation BOS is the preferred
 * confirmation and scores highest.
 */
export function continuationConfirmationScore(params: {
  entryCandles: readonly Candle[];
  direction: 'RISE' | 'FALL';
  rejectionBarTime: number;
  continuationBos: string | null;
  atr: number;
}): { score: number; detail: string } {
  const { entryCandles, direction, rejectionBarTime, continuationBos, atr } = params;
  const confirmed = entryCandles.length > 2 ? entryCandles.slice(0, -1) : [...entryCandles];
  const idx = confirmed.findIndex((b) => b.time === rejectionBarTime);
  const bar = idx >= 0 ? confirmed[idx] : confirmed[confirmed.length - 1];
  if (!bar) return { score: 0, detail: 'No confirmation candle available.' };

  const stats = getCandleStats(bar);
  const avgBody = getRecentAverageBody(confirmed, Math.max(0, idx), 14);
  const closeConviction =
    direction === 'RISE'
      ? Math.max(0, Math.min(1, (stats.closePosition - 0.5) / 0.35))
      : Math.max(0, Math.min(1, (0.5 - stats.closePosition) / 0.35));
  const bodyConviction = Math.max(0, Math.min(1, stats.body / Math.max(1e-9, avgBody)));

  // Base confirmation from the rejection candle's close, then the BOS bonus.
  let score = 0.5 * closeConviction + 0.3 * bodyConviction;
  let detail = `Rejection candle closed with ${(closeConviction * 100).toFixed(0)}% directional conviction.`;
  if (continuationBos) {
    score += 0.2;
    detail = `${detail} Continuation BOS confirmed after the rejection.`;
  }
  void atr;
  return { score: Math.max(0, Math.min(1, score)), detail };
}
