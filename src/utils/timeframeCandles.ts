import type { Candle } from '../types/market';

/**
 * Internal multi-timeframe candle construction.
 *
 * Deriv publishes M1/M3/M5/M15/H1/H4 candles natively, but NOT 420-second (M7) candles.
 * M7 is therefore built internally from live M1 data. These pure helpers implement the
 * bucketing and aggregation so the same rules are used by the data layer, the chart and
 * every AI module (a single construction path — never a duplicate module).
 */

/** Aligns an epoch to the START of its candle bucket for `granularitySec`. */
export function derivedBucketStart(epochSec: number, granularitySec: number): number {
  return Math.floor(epochSec / granularitySec) * granularitySec;
}

/**
 * Aggregates a source candle series (e.g. M1) into larger candles of `granularitySec`
 * (e.g. M7 = 420s). Boundaries are aligned to the epoch, so candles never overlap and no
 * bucket is ever skipped. OHLC is taken correctly: first source open, max high, min low,
 * last source close. Duplicate source timestamps collapse to the last value (a re-issued
 * candle overwrites, it never double-counts).
 */
export function aggregateCandles(source: readonly Candle[], granularitySec: number): Candle[] {
  if (!Number.isFinite(granularitySec) || granularitySec <= 0) return [...source];

  const ordered = [...source]
    .filter((c) => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);

  const byBucket = new Map<number, Candle>();
  for (const c of ordered) {
    const bucket = derivedBucketStart(c.time, granularitySec);
    const existing = byBucket.get(bucket);
    if (!existing) {
      byBucket.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      byBucket.set(bucket, {
        time: bucket,
        open: existing.open,
        high: Math.max(existing.high, c.high),
        low: Math.min(existing.low, c.low),
        close: c.close,
      });
    }
  }
  return Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
}

/**
 * Drops candles that are NOT fully covered by the source series:
 *  - a leading partial bucket (source does not begin at the bucket boundary), and
 *  - the trailing bucket (the currently-forming candle, unless `keepForming`).
 * This is what guarantees an incomplete candle is never treated as a confirmed historical one.
 */
export function confirmedDerivedCandles(
  aggregated: readonly Candle[],
  sourceStartTime: number,
  granularitySec: number,
  keepForming = false
): Candle[] {
  if (aggregated.length === 0) return [];
  let out = [...aggregated];
  if (derivedBucketStart(sourceStartTime, granularitySec) !== sourceStartTime) {
    out = out.slice(1);
  }
  if (!keepForming && out.length > 1) out = out.slice(0, -1);
  return out;
}

/**
 * Folds one live M1 candle into an M7 series. The bucket is aligned to the epoch; a new
 * bucket appends a fresh candle, an existing bucket widens high/low and moves the close.
 * Out-of-order source candles never corrupt the series (an update may only move forward).
 */
export function foldDerivedCandle(
  series: readonly Candle[],
  granularitySec: number,
  source: Candle
): Candle[] {
  if (!Number.isFinite(source.time)) return series as Candle[];
  const bucket = derivedBucketStart(source.time, granularitySec);
  const last = series.length > 0 ? series[series.length - 1] : null;

  if (!last || bucket > last.time) {
    return [...series, { time: bucket, open: source.open, high: source.high, low: source.low, close: source.close }];
  }
  if (bucket === last.time) {
    const next = series.slice();
    next[next.length - 1] = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, source.high),
      low: Math.min(last.low, source.low),
      close: source.close,
    };
    return next;
  }
  return series as Candle[];
}

/** Folds a raw tick (price + epoch) into a derived series. */
export function foldTickIntoDerived(
  series: readonly Candle[],
  granularitySec: number,
  tick: { epochSec: number; quote: number }
): Candle[] {
  if (!Number.isFinite(tick.epochSec) || !Number.isFinite(tick.quote)) return series as Candle[];
  const bucket = derivedBucketStart(tick.epochSec, granularitySec);
  const last = series.length > 0 ? series[series.length - 1] : null;

  if (!last || bucket > last.time) {
    const price = tick.quote;
    return [...series, { time: bucket, open: price, high: price, low: price, close: price }];
  }
  if (bucket === last.time) {
    const next = series.slice();
    next[next.length - 1] = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, tick.quote),
      low: Math.min(last.low, tick.quote),
      close: tick.quote,
    };
    return next;
  }
  return series as Candle[];
}
