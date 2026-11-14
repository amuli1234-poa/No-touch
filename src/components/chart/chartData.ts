import type { UTCTimestamp } from 'lightweight-charts';
import type { Candle, Timeframe } from '../../types/scanner';

/**
 * Pure adapters between WickSentinel candles and TradingView Lightweight
 * Charts data.
 *
 * Kept free of DOM and React so the mapping rules — ordering, de-duplication
 * and validity — can be unit-tested directly. Lightweight Charts requires
 * strictly ascending, unique timestamps; it silently drops or mis-renders
 * otherwise, so normalisation happens here rather than at the call site.
 */

export interface ChartBar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartPoint {
  time: UTCTimestamp;
  value: number;
}

/** Bar length per timeframe, in seconds. Mirrors the server aggregation periods. */
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400
};

export const TIMEFRAME_LABELS: { tf: Timeframe; label: string }[] = [
  { tf: '1m', label: 'M1' },
  { tf: '5m', label: 'M5' },
  { tf: '15m', label: 'M15' },
  { tf: '1h', label: 'H1' },
  { tf: '4h', label: 'H4' }
];

function isFiniteCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.epoch) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  );
}

/**
 * Normalises a candle list for Lightweight Charts: drops malformed bars,
 * sorts ascending, and keeps the last value for any duplicated timestamp
 * (a live bar can arrive twice as it updates).
 */
function normalise(candles: readonly Candle[]): Candle[] {
  const byEpoch = new Map<number, Candle>();
  for (const c of candles) {
    if (!isFiniteCandle(c)) continue;
    byEpoch.set(Math.floor(c.epoch), c);
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

export function toChartBars(candles: readonly Candle[]): ChartBar[] {
  return normalise(candles).map((c) => ({
    time: Math.floor(c.epoch) as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));
}

export function toLinePoints(candles: readonly Candle[]): ChartPoint[] {
  return normalise(candles).map((c) => ({
    time: Math.floor(c.epoch) as UTCTimestamp,
    value: c.close
  }));
}

/** Most recent close, or null when there is no usable data. */
export function lastClose(candles: readonly Candle[]): number | null {
  const n = normalise(candles);
  return n.length > 0 ? n[n.length - 1].close : null;
}

export interface PriceChange {
  abs: number;
  pct: number;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Change between the first and last close in the supplied window.
 *
 * Returns null when fewer than two bars exist — the UI shows an explicit
 * "—" rather than a fabricated 0%.
 */
export function priceChange(candles: readonly Candle[]): PriceChange | null {
  const n = normalise(candles);
  if (n.length < 2) return null;
  const from = n[0].close;
  const to = n[n.length - 1].close;
  if (!Number.isFinite(from) || from === 0) return null;
  const abs = to - from;
  return {
    abs,
    pct: (abs / from) * 100,
    direction: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat'
  };
}

/**
 * A stable identity for a candle snapshot. Used to decide whether a live
 * update can be applied incrementally (`series.update`) or needs a full
 * `setData` — the chart must not be torn down on every tick.
 */
export function seriesKey(symbol: string, timeframe: Timeframe, candles: readonly Candle[]): string {
  if (candles.length === 0) return `${symbol}|${timeframe}|empty`;
  const last = candles[candles.length - 1];
  return `${symbol}|${timeframe}|${candles.length}|${last.epoch}|${last.close}`;
}

export type LoadMode = 'full' | 'incremental';

/**
 * Decide whether a candle snapshot must be painted in full or can be applied as
 * a single-bar update.
 *
 * This is subtle enough to have caused a real bug: the first render for a symbol
 * frequently happens before its history has arrived (zero bars), and marking
 * that as "loaded" meant the arriving history was later applied incrementally —
 * leaving the chart showing only its final bar. A jump in depth, or a shrink
 * (a new symbol whose history is shorter), therefore forces a full repaint; only
 * a same-depth tick on an already-populated series may be incremental.
 */
export function loadMode(args: {
  keyChanged: boolean;
  barCount: number;
  loadedCount: number;
}): LoadMode {
  if (args.keyChanged) return 'full';
  if (args.barCount < args.loadedCount) return 'full';
  if (args.barCount > args.loadedCount + 1) return 'full';
  return 'incremental';
}
