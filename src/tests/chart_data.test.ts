import { Candle } from '../types/scanner';
import {
  toChartBars,
  toLinePoints,
  lastClose,
  priceChange,
  seriesKey,
  loadMode,
  TIMEFRAME_SECONDS
} from '../components/chart/chartData';

/**
 * Tests for the chart data adapters.
 *
 * These cover the invariants Lightweight Charts depends on — ascending,
 * unique timestamps and finite values — because a violation there is silent:
 * the chart simply renders wrong rather than throwing.
 */

console.log('🧪 Starting Chart Data Adapter Test Suite...\n');

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failCount++;
  }
}

function candle(epoch: number, open: number, high: number, low: number, close: number): Candle {
  return { epoch, open, high, low, close };
}

/* 1. Ordering */
console.log('[1] Ordering and normalisation');
{
  const outOfOrder = [candle(300, 3, 4, 2, 3.5), candle(100, 1, 2, 0.5, 1.5), candle(200, 2, 3, 1, 2.5)];
  const bars = toChartBars(outOfOrder);
  assert(bars.length === 3, 'keeps all three bars');
  assert(
    bars[0].time === 100 && bars[1].time === 200 && bars[2].time === 300,
    'sorts bars into ascending time order',
    bars.map((b) => b.time).join(',')
  );
}

/* 2. Duplicate timestamps collapse to the latest value */
console.log('\n[2] Duplicate timestamp handling');
{
  const dupes = [candle(100, 1, 2, 0.5, 1.5), candle(100, 1, 3, 0.4, 2.5)];
  const bars = toChartBars(dupes);
  assert(bars.length === 1, 'collapses duplicate timestamps to one bar');
  assert(bars[0].close === 2.5, 'keeps the most recent value for a duplicated timestamp');
}

/* 3. Malformed values are dropped, never rendered */
console.log('\n[3] Malformed value rejection');
{
  const withBad = [
    candle(100, 1, 2, 0.5, 1.5),
    { epoch: 200, open: NaN, high: 3, low: 1, close: 2.5 },
    { epoch: 300, open: 2, high: Infinity, low: 1, close: 2.5 },
    candle(400, 3, 4, 2.5, 3.5)
  ] as Candle[];
  const bars = toChartBars(withBad);
  assert(bars.length === 2, 'drops NaN and Infinity bars', `got ${bars.length}`);
  assert(bars.every((b) => Number.isFinite(b.open) && Number.isFinite(b.close)), 'all kept bars are finite');
}

/* 4. Line points mirror closes */
console.log('\n[4] Line point projection');
{
  const data = [candle(100, 1, 2, 0.5, 1.5), candle(200, 2, 3, 1, 2.75)];
  const points = toLinePoints(data);
  assert(points.length === 2, 'produces one point per bar');
  assert(points[1].value === 2.75, 'uses the close price for the line value');
}

/* 5. lastClose */
console.log('\n[5] Last close');
{
  assert(lastClose([]) === null, 'returns null for an empty series');
  assert(lastClose([candle(100, 1, 2, 0.5, 1.5)]) === 1.5, 'returns the only close');
  assert(
    lastClose([candle(200, 2, 3, 1, 2.5), candle(100, 1, 2, 0.5, 1.5)]) === 2.5,
    'returns the close of the latest bar regardless of input order'
  );
}

/* 6. priceChange honesty */
console.log('\n[6] Price change');
{
  assert(priceChange([]) === null, 'returns null with no bars');
  assert(priceChange([candle(100, 1, 2, 0.5, 1.5)]) === null, 'returns null with a single bar (never a fake 0%)');

  const up = priceChange([candle(100, 1, 2, 0.5, 100), candle(200, 2, 3, 1, 110)]);
  assert(up !== null && Math.abs(up.abs - 10) < 1e-9, 'computes absolute change');
  assert(up !== null && Math.abs(up.pct - 10) < 1e-9, 'computes percentage change');
  assert(up?.direction === 'up', 'labels a rise as up');

  const down = priceChange([candle(100, 1, 2, 0.5, 100), candle(200, 2, 3, 1, 90)]);
  assert(down?.direction === 'down', 'labels a fall as down');

  const flat = priceChange([candle(100, 1, 2, 0.5, 100), candle(200, 2, 3, 1, 100)]);
  assert(flat?.direction === 'flat', 'labels no change as flat');
}

/* 7. Zero base guard */
console.log('\n[7] Zero base guard');
{
  const zeroBase = priceChange([candle(100, 0, 2, 0, 0), candle(200, 0, 3, 0, 5)]);
  assert(zeroBase === null, 'returns null rather than dividing by a zero base');
}

/* 8. seriesKey stability */
console.log('\n[8] Series identity key');
{
  const a = [candle(100, 1, 2, 0.5, 1.5)];
  const b = [candle(100, 1, 2, 0.5, 1.5)];
  assert(seriesKey('R_100', '1m', a) === seriesKey('R_100', '1m', b), 'is stable for identical snapshots');
  assert(seriesKey('R_100', '1m', a) !== seriesKey('R_100', '5m', a), 'differs across timeframes');
  assert(seriesKey('R_100', '1m', a) !== seriesKey('R_50', '1m', a), 'differs across symbols');
  assert(seriesKey('R_100', '1m', []) !== seriesKey('R_100', '1m', a), 'differs between empty and populated');
}

/* 9. Timeframe periods match the server aggregation */
console.log('\n[9] Timeframe periods');
{
  assert(TIMEFRAME_SECONDS['1m'] === 60, '1m is 60s');
  assert(TIMEFRAME_SECONDS['5m'] === 300, '5m is 300s');
  assert(TIMEFRAME_SECONDS['15m'] === 900, '15m is 900s');
  assert(TIMEFRAME_SECONDS['1h'] === 3600, '1h is 3600s');
  assert(TIMEFRAME_SECONDS['4h'] === 14400, '4h is 14400s');
}

/* 10. Load mode: full vs incremental repaint */
console.log('\n[10] Load mode decision');
{
  const m = (keyChanged: boolean, barCount: number, loadedCount: number) =>
    loadMode({ keyChanged, barCount, loadedCount });

  assert(m(true, 100, 0) === 'full', 'new symbol/timeframe forces full repaint');
  assert(m(true, 0, 0) === 'full', 'first render of a new key is full even when empty');
  assert(m(false, 0, 0) === 'incremental', 'empty to empty stays incremental');
  assert(m(false, 1, 0) === 'incremental', 'first arriving bar is a single update');
  assert(m(false, 500, 0) === 'full', 'history arriving after an empty render forces full repaint');
  assert(m(false, 101, 100) === 'incremental', 'one new bar is incremental');
  assert(m(false, 150, 100) === 'full', 'a batch of new bars forces full repaint');
  assert(m(false, 40, 100) === 'full', 'a shorter history (symbol switch) forces full repaint');
  assert(m(false, 100, 100) === 'incremental', 'unchanged depth is incremental');
}

console.log(`\n${'='.repeat(52)}`);
console.log(`Chart adapter tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error('❌ Chart data adapter test suite FAILED');
  process.exit(1);
}
console.log('✅ Chart data adapter test suite PASSED');
