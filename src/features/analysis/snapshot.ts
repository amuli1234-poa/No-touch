import type { Candle, Timeframe } from '../../types/scanner';
import { TIMEFRAME_SECONDS } from '../../components/chart/chartData';
import type { MarketSnapshot } from './engines/types';

/**
 * Snapshot builder: turns the live candle buffer into an immutable, verified
 * `MarketSnapshot`.
 *
 * Every rule here exists to stop stale or partial data being analysed as if it
 * were fresh and complete:
 *  - the newest candle's close time is derived from its epoch + the timeframe
 *    length, and its age is measured against capture time;
 *  - a snapshot is `complete` only when there are enough candles *and* the
 *    newest bar is not older than a few bar-lengths;
 *  - a candle carrying a non-finite value marks the snapshot incomplete rather
 *    than being silently dropped.
 */

/** A bar is considered stale once it is older than this many bar-lengths. */
export const FRESHNESS_BAR_TOLERANCE = 3;

/** Minimum bars before analysis is meaningful. */
export const MIN_SNAPSHOT_CANDLES = 20;

export interface BuildSnapshotInput {
  symbol: string;
  displayName: string;
  timeframe: Timeframe;
  candles: readonly Candle[];
  capturedAtMs: number;
}

export function buildMarketSnapshot(input: BuildSnapshotInput): MarketSnapshot {
  const { symbol, displayName, timeframe, candles, capturedAtMs } = input;
  const timeframeSeconds = TIMEFRAME_SECONDS[timeframe];

  const malformed = candles.filter(
    (c) =>
      !Number.isFinite(c.epoch) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
  );

  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  const lastCandleEpochMs = last ? (last.epoch + timeframeSeconds) * 1000 : 0;
  const freshnessMs = last ? Math.max(0, capturedAtMs - lastCandleEpochMs) : 0;

  const enoughCandles = candles.length >= MIN_SNAPSHOT_CANDLES;
  const freshEnough = last !== null && freshnessMs <= FRESHNESS_BAR_TOLERANCE * timeframeSeconds * 1000;

  let incompleteReason: string | undefined;
  if (candles.length === 0) incompleteReason = 'No candles received.';
  else if (malformed.length > 0) incompleteReason = `${malformed.length} malformed candle(s) in the buffer.`;
  else if (!enoughCandles)
    incompleteReason = `Only ${candles.length} candles available (need ${MIN_SNAPSHOT_CANDLES}).`;
  else if (!freshEnough) incompleteReason = 'Newest candle is older than the freshness window.';

  return {
    symbol,
    displayName,
    timeframe,
    timeframeSeconds,
    source: 'Deriv WebSocket (ticks_history + live ticks)',
    lastCandleEpochMs,
    capturedAtMs,
    freshnessMs,
    complete: incompleteReason === undefined,
    incompleteReason,
    candleCount: candles.length,
    lastPrice: last ? last.close : 0
  };
}
