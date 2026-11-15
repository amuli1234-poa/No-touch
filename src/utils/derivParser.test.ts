import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCrosshairReadout,
  classifyMarketFamily,
  computePrecisionFromPip,
  formatCandleTime,
  formatPrice,
  mergeCandleUpdate,
  parseActiveSymbols,
  parseHistoricalCandles,
  parseOhlcUpdate,
  parseTick,
  foldTickIntoCandle,
  candleEquals,
  prependHistoricalCandles,
} from './derivParser';

test('computePrecisionFromPip derives decimal precision accurately', () => {
  assert.equal(computePrecisionFromPip(0.01), 2);
  assert.equal(computePrecisionFromPip(0.001), 3);
  assert.equal(computePrecisionFromPip(0.0001), 4);
  assert.equal(computePrecisionFromPip(1), 0);
  assert.equal(computePrecisionFromPip(undefined, 0.1), 1);
  assert.equal(computePrecisionFromPip(undefined, 0.01), 2);
  assert.equal(computePrecisionFromPip(undefined, 0.0001), 4);
  assert.equal(computePrecisionFromPip(undefined, 0.00001), 5);
  assert.equal(computePrecisionFromPip(0.01, 3), 3);
  assert.equal(computePrecisionFromPip(undefined), 2);
});

test('classifyMarketFamily detects VOLATILITY, JUMP, STEP, and OTHER indices', () => {
  assert.equal(
    classifyMarketFamily('1HZ75V', 'random_index', 'Volatility 75 (1s) Index'),
    'VOLATILITY'
  );
  assert.equal(
    classifyMarketFamily('JD50', 'jump_index', 'Jump 50 Index'),
    'JUMP'
  );
  assert.equal(
    classifyMarketFamily('stpRNG', 'step_index', 'Step Index'),
    'STEP'
  );
  assert.equal(
    classifyMarketFamily('BOOM1000', 'crash_index', 'Boom 1000 Index'),
    'OTHER'
  );
});

test('parseActiveSymbols filters synthetic indices, assigns families, and sorts by submarket', () => {
  const parsed = parseActiveSymbols([
    {
      underlying_symbol: 'frxEURUSD',
      underlying_symbol_name: 'EUR/USD',
      market: 'forex',
      submarket: 'major_pairs',
      pip_size: 0.0001,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
    {
      underlying_symbol: 'stpRNG',
      underlying_symbol_name: 'Step Index',
      market: 'synthetic_index',
      subgroup: 'synthetics',
      submarket: 'step_index',
      pip_size: 0.1,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
    {
      underlying_symbol: 'JD25',
      underlying_symbol_name: 'Jump 25 Index',
      market: 'synthetic_index',
      subgroup: 'synthetics',
      submarket: 'jump_index',
      pip_size: 0.01,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
    {
      underlying_symbol: 'R_100',
      underlying_symbol_name: 'Volatility 100 Index',
      market: 'synthetic_index',
      subgroup: 'synthetics',
      submarket: 'random_index',
      pip_size: 0.01,
      exchange_is_open: 1,
      is_trading_suspended: 0,
    },
    {
      underlying_symbol: 'R_50_SUSPENDED',
      underlying_symbol_name: 'Volatility 50 Suspended',
      market: 'synthetic_index',
      submarket: 'random_index',
      pip_size: 0.01,
      is_trading_suspended: 1,
    },
  ]);

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].symbol, 'R_100');
  assert.equal(parsed[0].family, 'VOLATILITY');
  assert.equal(parsed[1].symbol, 'JD25');
  assert.equal(parsed[1].family, 'JUMP');
  assert.equal(parsed[2].symbol, 'stpRNG');
  assert.equal(parsed[2].family, 'STEP');
});

test('parseHistoricalCandles normalizes strings/numbers, deduplicates, and sorts ascending', () => {
  const candles = parseHistoricalCandles([
    { epoch: 1700000120, open: '101.2', high: '102.0', low: '100.8', close: '101.9' },
    { epoch: 1700000060, open: 100.0, high: 101.5, low: 99.5, close: 101.2 },
    { epoch: 1700000060, open: 100.0, high: 101.6, low: 99.5, close: 101.3 },
    { epoch: 1700000180, open: 'bad', high: 100, low: 99, close: 100 },
  ]);

  assert.equal(candles.length, 2);
  assert.equal(candles[0].time, 1700000060);
  assert.equal(candles[0].close, 101.3);
  assert.equal(candles[1].time, 1700000120);
});

test('parseOhlcUpdate uses open_time or aligns epoch to granularity', () => {
  const withOpenTime = parseOhlcUpdate(
    {
      symbol: 'R_100',
      granularity: 60,
      epoch: 1700000145,
      open_time: 1700000120,
      open: '620.10',
      high: '621.00',
      low: '619.80',
      close: '620.55',
    },
    60
  );
  assert.ok(withOpenTime);
  assert.equal(withOpenTime.candle.time, 1700000120);
  assert.equal(withOpenTime.candle.close, 620.55);

  const withoutOpenTime = parseOhlcUpdate(
    {
      symbol: 'R_75',
      epoch: 1700000145,
      open: 100,
      high: 105,
      low: 99,
      close: 102,
    },
    60
  );
  assert.ok(withoutOpenTime);
  assert.equal(withoutOpenTime.candle.time, 1700000100);
});

test('mergeCandleUpdate updates active candle or appends new candle without mutating earlier history', () => {
  const initial = [
    { time: 60, open: 10, high: 12, low: 9, close: 11 },
    { time: 120, open: 11, high: 13, low: 10, close: 12 },
  ];

  const updatedSame = mergeCandleUpdate(initial, {
    time: 120,
    open: 11,
    high: 14,
    low: 10,
    close: 13.5,
  });
  assert.equal(updatedSame.length, 2);
  assert.equal(updatedSame[1].close, 13.5);

  const appendedNew = mergeCandleUpdate(updatedSame, {
    time: 180,
    open: 13.5,
    high: 15,
    low: 13,
    close: 14.5,
  });
  assert.equal(appendedNew.length, 3);
  assert.equal(appendedNew[2].time, 180);

  const ignoredStale = mergeCandleUpdate(appendedNew, {
    time: 120,
    open: 11,
    high: 11,
    low: 11,
    close: 11,
  });
  assert.equal(ignoredStale.length, 3);
  assert.equal(ignoredStale[1].close, 13.5);
});

test('prependHistoricalCandles merges older page before existing candles', () => {
  const existing = [
    { time: 180, open: 3, high: 4, low: 2, close: 3.5 },
    { time: 240, open: 3.5, high: 5, low: 3, close: 4 },
  ];
  const older = [
    { time: 60, open: 1, high: 2, low: 1, close: 2 },
    { time: 120, open: 2, high: 3, low: 2, close: 3 },
    { time: 180, open: 3, high: 4, low: 2, close: 3.5 },
  ];
  const merged = prependHistoricalCandles(existing, older);
  assert.deepEqual(
    merged.map((c) => c.time),
    [60, 120, 180, 240]
  );
});

test('formatting helpers render fixed decimals and UTC timestamp', () => {
  assert.equal(formatPrice(1234.5, 2), '1234.50');
  assert.equal(formatCandleTime(1700000120), '2023-11-14 22:15 UTC');
  const readout = buildCrosshairReadout(
    { time: 1700000120, open: 100, high: 110, low: 95, close: 105 },
    true
  );
  assert.equal(readout.change, 5);
  assert.equal(readout.changePercent, 5);
});

test('parseTick extracts symbol, floored epoch and quote from a raw tick', () => {
  assert.deepEqual(parseTick({ symbol: 'R_100', epoch: 1700000120.9, quote: 1234.56 }), {
    symbol: 'R_100',
    epochSec: 1700000120,
    quote: 1234.56,
  });
  assert.equal(parseTick({ symbol: 'R_100', epoch: 'bad', quote: 1 }), null);
  assert.equal(parseTick({ epoch: 1, quote: 1 }), null);
  assert.equal(parseTick(null), null);
  assert.equal(parseTick('nope'), null);
});

test('foldTickIntoCandle opens a new candle when the bucket advances', () => {
  const base = [{ time: 300, open: 10, high: 12, low: 9, close: 11 }];
  const next = foldTickIntoCandle(base, 300, { epochSec: 620, quote: 13 });
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], { time: 600, open: 13, high: 13, low: 13, close: 13 });
  // Original series is never mutated.
  assert.equal(base.length, 1);
});

test('foldTickIntoCandle widens high/low and moves close within the same bucket', () => {
  const base = [{ time: 600, open: 13, high: 13, low: 13, close: 13 }];
  const up = foldTickIntoCandle(base, 300, { epochSec: 610, quote: 14.5 });
  assert.deepEqual(up[0], { time: 600, open: 13, high: 14.5, low: 13, close: 14.5 });
  const down = foldTickIntoCandle(up, 300, { epochSec: 640, quote: 11.2 });
  assert.deepEqual(down[0], { time: 600, open: 13, high: 14.5, low: 11.2, close: 11.2 });
});

test('foldTickIntoCandle ignores ticks older than the newest candle and invalid input', () => {
  const base = [
    { time: 600, open: 13, high: 13, low: 13, close: 13 },
    { time: 900, open: 13, high: 13, low: 13, close: 13 },
  ];
  const stale = foldTickIntoCandle(base, 300, { epochSec: 610, quote: 99 });
  assert.equal(stale, base);
  assert.equal(foldTickIntoCandle(base, 0, { epochSec: 1000, quote: 5 }), base);
  assert.equal(foldTickIntoCandle(base, 300, { epochSec: NaN, quote: 5 }), base);
});

test('folding a live tick preserves the forming candle OHLC (no flat-candle flicker)', () => {
  // Regression: the live path must fold ticks into the real series, never rebuild the
  // active candle from an empty array (which produced a flat candle and made the chart
  // blink between the tick and the next OHLC frame).
  const history = [
    { time: 300, open: 10, high: 12, low: 9, close: 11 },
    { time: 600, open: 11, high: 13.4, low: 10.5, close: 12.8 },
  ];
  const afterTick = foldTickIntoCandle(history, 300, { epochSec: 640, quote: 12.2 });
  assert.equal(afterTick.length, 2);
  assert.deepEqual(afterTick[1], {
    time: 600,
    open: 11,
    high: 13.4,
    low: 10.5,
    close: 12.2,
  });
  // Earlier history is untouched.
  assert.deepEqual(afterTick[0], history[0]);
});

test('candleEquals reports visual identity so no-op frames are skipped', () => {
  const a = { time: 600, open: 11, high: 13, low: 10, close: 12 };
  assert.equal(candleEquals(a, { ...a }), true);
  assert.equal(candleEquals(a, { ...a, close: 12.0001 }), false);
  assert.equal(candleEquals(a, { ...a, high: 13.5 }), false);
  assert.equal(candleEquals(a, { ...a, time: 900 }), false);
});
