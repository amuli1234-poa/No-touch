import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Candle } from '../types/market';
import {
  aggregateCandles,
  confirmedDerivedCandles,
  derivedBucketStart,
  foldDerivedCandle,
  foldTickIntoDerived,
} from './timeframeCandles';

const M1 = 60;
const M7 = 420;

/** A minute candle at `epoch` with the given OHLC. */
function m1(epoch: number, o: number, h: number, l: number, c: number): Candle {
  return { time: epoch, open: o, high: h, low: l, close: c };
}

/** A contiguous run of M1 candles starting exactly on an M7 boundary. */
function contiguousM1(startEpoch: number, count: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const o = price;
    const c = price + (i % 2 === 0 ? 0.4 : -0.3);
    out.push(m1(startEpoch + i * M1, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c));
    price = c;
  }
  return out;
}

describe('derivedBucketStart', () => {
  it('aligns an epoch to the start of its M7 bucket', () => {
    assert.equal(derivedBucketStart(0, M7), 0);
    assert.equal(derivedBucketStart(419, M7), 0);
    assert.equal(derivedBucketStart(420, M7), 420);
    assert.equal(derivedBucketStart(421, M7), 420);
    assert.equal(derivedBucketStart(900, M7), 840);
  });
});

describe('aggregateCandles', () => {
  it('builds genuine 7-minute candles with correct OHLC from M1 data', () => {
    const start = 1_699_999_980; // a real M7 boundary (divisible by 420)
    assert.equal(start % M7, 0);
    const source = contiguousM1(start, 7);
    const [candle, ...rest] = aggregateCandles(source, M7);
    assert.equal(rest.length, 0);
    assert.equal(candle.time, start);
    assert.equal(candle.open, source[0].open);
    assert.equal(candle.close, source[6].close);
    assert.equal(candle.high, Math.max(...source.map((c) => c.high)));
    assert.equal(candle.low, Math.min(...source.map((c) => c.low)));
  });

  it('produces one candle per bucket — no duplicates and no gaps', () => {
    const start = 1_699_999_980;
    const source = contiguousM1(start, 21); // exactly three M7 buckets
    const out = aggregateCandles(source, M7);
    assert.equal(out.length, 3);
    for (let i = 1; i < out.length; i++) {
      assert.equal(out[i].time - out[i - 1].time, M7, 'buckets must be contiguous');
    }
  });

  it('collapses duplicate source timestamps without double-counting', () => {
    const start = 1_699_999_980;
    const dup = [...contiguousM1(start, 7)];
    // Re-issue the last minute candle (same time, corrected values) with an extended range.
    dup[dup.length - 1] = m1(start + 6 * M1, 200, 250, 50, 240);
    const out = aggregateCandles(dup, M7);
    assert.equal(out.length, 1);
    assert.equal(out[0].high, 250);
    assert.equal(out[0].low, 50);
    assert.equal(out[0].close, 240);
  });

  it('is order-independent and ignores non-finite timestamps', () => {
    const start = 1_699_999_980;
    const source = contiguousM1(start, 14);
    const shuffled = [...source].reverse();
    const a = aggregateCandles(source, M7);
    const b = aggregateCandles(shuffled, M7);
    assert.deepEqual(a, b);
    const withNan = [...source, m1(NaN, 1, 1, 1, 1)];
    assert.equal(aggregateCandles(withNan, M7).length, 2);
  });

  it('returns the source unchanged for an invalid granularity', () => {
    const source = contiguousM1(1_699_999_980, 3);
    assert.deepEqual(aggregateCandles(source, 0), source);
    assert.deepEqual(aggregateCandles(source, -5), source);
  });
});

describe('confirmedDerivedCandles', () => {
  it('drops the trailing forming bucket so an incomplete candle is never confirmed', () => {
    const start = 1_699_999_980;
    const source = contiguousM1(start, 21); // three full buckets, last is forming
    const aggregated = aggregateCandles(source, M7);
    const confirmed = confirmedDerivedCandles(aggregated, source[0].time, M7, false);
    assert.equal(confirmed.length, 2);
    assert.equal(confirmed[confirmed.length - 1].time, start + M7);
  });

  it('drops a leading partial bucket when the source does not start on a boundary', () => {
    // Start 2 minutes into a bucket: the first bucket is not fully covered.
    const start = 1_699_999_980 + 2 * M1;
    const source = contiguousM1(start, 21);
    const aggregated = aggregateCandles(source, M7);
    const confirmed = confirmedDerivedCandles(aggregated, source[0].time, M7, false);
    // First aggregated bucket is partial → dropped; trailing forming bucket → dropped.
    assert.ok(confirmed.every((c) => c.time % M7 === 0));
    assert.equal(confirmed[0].time, start + (M7 - (start % M7)));
  });

  it('keeps the forming bucket only when explicitly requested', () => {
    const start = 1_699_999_980;
    const source = contiguousM1(start, 21);
    const aggregated = aggregateCandles(source, M7);
    const kept = confirmedDerivedCandles(aggregated, source[0].time, M7, true);
    assert.equal(kept.length, 3);
  });
});

describe('foldDerivedCandle', () => {
  it('appends a fresh bucket and widens an existing one', () => {
    let series = aggregateCandles(contiguousM1(1_699_999_980, 7), M7);
    assert.equal(series.length, 1);
    // A new minute candle in the NEXT bucket appends.
    series = foldDerivedCandle(series, M7, m1(1_699_999_980 + 7 * M1, 105, 106, 104, 105.5));
    assert.equal(series.length, 2);
    assert.equal(series[1].time, 1_699_999_980 + M7);
    // An update inside the current bucket widens high/low and moves the close.
    series = foldDerivedCandle(series, M7, m1(1_699_999_980 + 7 * M1 + M1, 105.5, 120, 100, 110));
    assert.equal(series.length, 2);
    assert.equal(series[1].high, 120);
    assert.equal(series[1].low, 100);
    assert.equal(series[1].close, 110);
    assert.equal(series[1].open, 105);
  });

  it('never corrupts the series with an out-of-order (older) candle', () => {
    const series = aggregateCandles(contiguousM1(1_699_999_980, 14), M7);
    const before = JSON.stringify(series);
    const after = foldDerivedCandle(series, M7, m1(1_699_999_980 - 10 * M1, 1, 2, 0.5, 1.5));
    assert.equal(JSON.stringify(after), before);
  });
});

describe('foldTickIntoDerived', () => {
  it('builds a bucket from the first tick and then tracks high/low/close', () => {
    const start = 1_699_999_980;
    let series: Candle[] = [];
    series = foldTickIntoDerived(series, M7, { epochSec: start + 10, quote: 100 });
    assert.equal(series.length, 1);
    assert.deepEqual(series[0], { time: start, open: 100, high: 100, low: 100, close: 100 });
    series = foldTickIntoDerived(series, M7, { epochSec: start + 20, quote: 103 });
    series = foldTickIntoDerived(series, M7, { epochSec: start + 30, quote: 97 });
    assert.equal(series[0].high, 103);
    assert.equal(series[0].low, 97);
    assert.equal(series[0].close, 97);
    // A tick in the next bucket opens a new candle.
    series = foldTickIntoDerived(series, M7, { epochSec: start + M7 + 5, quote: 98 });
    assert.equal(series.length, 2);
    assert.equal(series[1].time, start + M7);
    assert.equal(series[1].open, 98);
  });

  it('ignores non-finite ticks', () => {
    const series = foldTickIntoDerived([], M7, { epochSec: NaN, quote: 100 });
    assert.equal(series.length, 0);
  });
});
