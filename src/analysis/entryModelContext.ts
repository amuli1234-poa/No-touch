import type { Candle } from '../types/market';
import type { EntryModelMarketContext } from '../types/entryModelAI';
import { computeAtrSeries } from './swings';

/**
 * Builds the market context the universal Entry Model AI reads for one instrument: the
 * latest confirmed close, the ATR of the analysis timeframe, and a simple higher-timeframe
 * directional read. Pure — no side effects, no invented values.
 */
export interface BuildMarketContextParams {
  candles: readonly Candle[];
  /** A simple higher-timeframe direction (from a slower candle series), or null. */
  htfDirection?: 'RISE' | 'FALL' | null;
  /** Historical win-rate bonus per entry model (real learning signal). */
  historicalBonus?: EntryModelMarketContext['historicalBonus'];
  /** The index-specific validated model (from THIS index's own outcomes), or null. */
  indexProfile?: EntryModelMarketContext['indexProfile'];
  /** Epoch seconds of the newest confirmed candle (data freshness). */
  dataTimestamp?: number;
}

export function buildMarketContext({
  candles,
  htfDirection = null,
  historicalBonus,
  indexProfile = null,
  dataTimestamp,
}: BuildMarketContextParams): EntryModelMarketContext | null {
  if (candles.length === 0) return null;
  const price = candles[candles.length - 1].close;
  const atrSeries = computeAtrSeries(candles, 14);
  const atr = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : 0;
  return {
    price,
    atr,
    htfDirection,
    historicalBonus,
    indexProfile,
    dataTimestamp: dataTimestamp ?? candles[candles.length - 1].time,
  };
}

/**
 * A simple, explainable higher-timeframe direction from a slower candle series: compares
 * the latest close against the close N bars back. Returns null when there is not enough
 * history to make the call (never a guess).
 */
export function deriveHtfDirection(
  htfCandles: readonly Candle[],
  lookback = 3
): 'RISE' | 'FALL' | null {
  if (htfCandles.length <= lookback) return null;
  const latest = htfCandles[htfCandles.length - 1].close;
  const prior = htfCandles[htfCandles.length - 1 - lookback].close;
  if (latest > prior) return 'RISE';
  if (latest < prior) return 'FALL';
  return null;
}
