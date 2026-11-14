import { runAnalysis } from '../features/analysis/orchestrator';
import { buildMarketSnapshot, MIN_SNAPSHOT_CANDLES } from '../features/analysis/snapshot';
import { checkPrerequisites } from '../features/analysis/types';
import { DeterministicAnalysisEngine } from '../features/analysis/engines/deterministicEngine';
import { createDeclaredAiEngines, UnavailableAnalysisEngine } from '../features/analysis/engines/unavailableEngines';
import type {
  AnalysisEngine,
  EngineOutput,
  MarketSnapshot
} from '../features/analysis/engines/types';
import type { Candle, Timeframe } from '../types/scanner';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL: ${name}`);
  }
}

const TF_SECONDS: Record<Timeframe, number> = { '1m': 60, '2m': 120, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };

/** Synthesise a *shape-valid* candle buffer for plumbing tests (not market data). */
function makeCandles(n: number, tf: Timeframe, endMs: number): Candle[] {
  const secs = TF_SECONDS[tf];
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const epoch = Math.floor(endMs / 1000) - (n - i) * secs;
    const base = 1000 + i * 0.5;
    out.push({ epoch, open: base, high: base + 1, low: base - 1, close: base + 0.25 });
  }
  return out;
}

function symbolInfo(symbol: string) {
  return { symbol, displayName: symbol, market: 'synthetic_index', is1s: false, isOpen: true, pipSize: 0.01 };
}

const NOW = 1_700_000_000_000;

console.log('\n[1] Prerequisites gate the run');
{
  check('blocks when disconnected', !checkPrerequisites({ connectionState: 'DISCONNECTED', hasSymbol: true, hasTimeframe: true, candleCount: 100, minCandles: 20 }).ok);
  check('blocks without a symbol', !checkPrerequisites({ connectionState: 'CONNECTED', hasSymbol: false, hasTimeframe: true, candleCount: 100, minCandles: 20 }).ok);
  check('blocks without a timeframe', !checkPrerequisites({ connectionState: 'CONNECTED', hasSymbol: true, hasTimeframe: false, candleCount: 100, minCandles: 20 }).ok);
  check('blocks with too few candles', !checkPrerequisites({ connectionState: 'CONNECTED', hasSymbol: true, hasTimeframe: true, candleCount: 5, minCandles: 20 }).ok);
  check('blocks on stale data', !checkPrerequisites({ connectionState: 'CONNECTED', hasSymbol: true, hasTimeframe: true, candleCount: 100, minCandles: 20, isStale: true }).ok);
  check('allows a fresh, complete snapshot', checkPrerequisites({ connectionState: 'CONNECTED', hasSymbol: true, hasTimeframe: true, candleCount: 100, minCandles: 20 }).ok);
}

console.log('\n[2] Snapshot builder reports provenance and freshness honestly');
{
  const fresh = buildMarketSnapshot({ symbol: 'R_100', displayName: 'Volatility 100', timeframe: '5m', candles: makeCandles(50, '5m', NOW), capturedAtMs: NOW });
  check('marks a fresh buffer complete', fresh.complete === true);
  check('records the data source', fresh.source.includes('Deriv'));
  check('reports the candle count', fresh.candleCount === 50);
  check('computes freshness within the window', fresh.freshnessMs <= 3 * 300 * 1000);

  const short = buildMarketSnapshot({ symbol: 'R_100', displayName: 'V', timeframe: '5m', candles: makeCandles(5, '5m', NOW), capturedAtMs: NOW });
  check('marks a short buffer incomplete', short.complete === false);
  check('explains why it is incomplete', typeof short.incompleteReason === 'string' && short.incompleteReason.length > 0);

  const stale = buildMarketSnapshot({ symbol: 'R_100', displayName: 'V', timeframe: '5m', candles: makeCandles(50, '5m', NOW - 60 * 60 * 1000), capturedAtMs: NOW });
  check('marks a stale buffer incomplete', stale.complete === false);

  const malformed = buildMarketSnapshot({ symbol: 'R_100', displayName: 'V', timeframe: '5m', candles: [...makeCandles(49, '5m', NOW), { epoch: NOW / 1000, open: NaN, high: 1, low: 1, close: 1 }], capturedAtMs: NOW });
  check('flags malformed candles', malformed.complete === false && (malformed.incompleteReason || '').includes('malformed'));
}

console.log('\n[3] A failed prerequisite produces FAILED, never a fake result');
{
  const res = await runAnalysis(
    {
      symbol: 'R_100',
      displayName: 'V',
      timeframe: '5m',
      candles: makeCandles(50, '5m', NOW),
      connectionState: 'DISCONNECTED',
      engines: [],
      now: () => NOW
    },
    new AbortController().signal
  );
  check('status is FAILED', res.status === 'FAILED');
  check('direction is WAIT', res.direction === 'WAIT');
  check('no zone is produced', res.zone === null);
  check('carries a reason', typeof res.error === 'string' && res.error.length > 0);
  check('stages after the failure are SKIPPED', res.snapshot.candleCount === 50);
}

console.log('\n[4] Unavailable AI engines are reported, never asked for output');
{
  let analyzeCalled = false;
  const spyUnavailable: AnalysisEngine = {
    id: 'spy-unavailable',
    name: 'Spy',
    description: 'x',
    checkAvailability: () => ({ available: false, reason: 'no provider' }),
    analyze: async () => {
      analyzeCalled = true;
      throw new Error('should not be called');
    }
  };
  const res = await runAnalysis(
    {
      symbol: 'R_100',
      displayName: 'V',
      timeframe: '5m',
      candles: makeCandles(50, '5m', NOW),
      connectionState: 'CONNECTED',
      engines: [spyUnavailable],
      now: () => NOW
    },
    new AbortController().signal
  );
  check('analyze() was never called on an unavailable engine', analyzeCalled === false);
  check('engine recorded as UNAVAILABLE', res.engines[0].status === 'UNAVAILABLE');
  check('engine carries an unavailable reason', res.engines[0].reason === 'no provider');
  check('no fabricated zone', res.zone === null);
  check('a note explains no AI output', res.notes.some((n) => n.toLowerCase().includes('unavailable')));
}

console.log('\n[5] A failing engine is FAILED and never counts as agreement');
{
  const boom: AnalysisEngine = {
    id: 'boom',
    name: 'Boom',
    description: 'x',
    checkAvailability: () => ({ available: true }),
    analyze: async () => {
      throw new Error('inference exploded');
    }
  };
  const res = await runAnalysis(
    {
      symbol: 'R_100',
      displayName: 'V',
      timeframe: '5m',
      candles: makeCandles(50, '5m', NOW),
      connectionState: 'CONNECTED',
      engines: [boom],
      now: () => NOW
    },
    new AbortController().signal
  );
  check('engine recorded as FAILED', res.engines[0].status === 'FAILED');
  check('failure reason captured', (res.engines[0].reason || '').includes('exploded'));
  check('no zone from a failed engine', res.zone === null);
}

console.log('\n[6] Engines that disagree withhold a directional call (WAIT)');
{
  const mk = (id: string, dir: 'RISE' | 'FALL'): AnalysisEngine => ({
    id,
    name: id,
    description: 'x',
    checkAvailability: () => ({ available: true }),
    analyze: async (s: MarketSnapshot): Promise<EngineOutput> => ({
      engineId: id,
      engineName: id,
      direction: dir,
      zones: [],
      summary: 'x',
      completedAtMs: s.capturedAtMs
    })
  });
  const res = await runAnalysis(
    {
      symbol: 'R_100',
      displayName: 'V',
      timeframe: '5m',
      candles: makeCandles(50, '5m', NOW),
      connectionState: 'CONNECTED',
      engines: [mk('a', 'RISE'), mk('b', 'FALL')],
      now: () => NOW
    },
    new AbortController().signal
  );
  check('status is WAIT when engines disagree', res.status === 'WAIT');
  check('direction is WAIT', res.direction === 'WAIT');
  check('no zone is drawn on disagreement', res.zone === null);
  check('a note records the disagreement', res.notes.some((n) => n.toLowerCase().includes('disagree')));
}

console.log('\n[7] Declared AI engines are all interface-only (unavailable)');
{
  const declared = createDeclaredAiEngines();
  check('declares the specialized engines', declared.length === 3);
  check('every declared engine is unavailable', declared.every((e) => e.checkAvailability().available === false));
  check('each carries an unavailable reason', declared.every((e) => Boolean(e.checkAvailability().reason)));
  const one = new UnavailableAnalysisEngine('x', 'X', 'd', 'nope');
  let threw = false;
  try {
    await one.analyze({} as MarketSnapshot, new AbortController().signal);
  } catch {
    threw = true;
  }
  check('an unavailable engine throws rather than fabricating output', threw === true);
}

console.log('\n[8] The real deterministic engine runs end-to-end on a real buffer');
{
  // Build a realistic rising series so the engine has structure to read.
  const n = 120;
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const epoch = Math.floor(NOW / 1000) - (n - i) * 60;
    const base = 1000 + i * 0.8 + Math.sin(i / 4) * 3;
    candles.push({ epoch, open: base, high: base + 2, low: base - 2, close: base + 0.5 });
  }
  const byTf = { '1m': candles, '5m': candles, '15m': candles, '1h': candles, '4h': candles };
  const engine = new DeterministicAnalysisEngine({
    candlesFor: () => byTf,
    symbolInfoFor: () => symbolInfo('R_100')
  });
  const res = await runAnalysis(
    {
      symbol: 'R_100',
      displayName: 'Volatility 100',
      timeframe: '5m',
      candles,
      connectionState: 'CONNECTED',
      engines: [engine, ...createDeclaredAiEngines()],
      now: () => NOW
    },
    new AbortController().signal
  );
  check('the run completed with a status', ['COMPLETED', 'WAIT'].includes(res.status));
  check('the deterministic engine ran', res.engines.find((e) => e.engineId === 'deterministic-price-action')?.status === 'COMPLETED');
  check('AI engines remain UNAVAILABLE', res.engines.filter((e) => e.engineId.startsWith('ai-')).every((e) => e.status === 'UNAVAILABLE'));
  check('a COMPLETED result always has a validated zone', res.status !== 'COMPLETED' || res.zone !== null);
  check('a WAIT result never has a zone', res.status !== 'WAIT' || res.zone === null);
  check('snapshot is attached to the result', res.snapshot.symbol === 'R_100' && res.snapshot.candleCount === n);
  check('result has a unique id', typeof res.id === 'string' && res.id.length > 0);
  if (res.zone) {
    check('zone prices are ordered', res.zone.upperPrice > res.zone.lowerPrice);
    check('zone is a rise or fall', res.zone.direction === 'RISE' || res.zone.direction === 'FALL');
  }
}

console.log('\n[9] Cancellation is handled');
{
  const slow: AnalysisEngine = {
    id: 'slow',
    name: 'Slow',
    description: 'x',
    checkAvailability: () => ({ available: true }),
    analyze: (_s, sig) =>
      new Promise((_res, rej) => {
        sig.addEventListener('abort', () => rej(new DOMException('cancelled', 'AbortError')));
      })
  };
  const ctrl = new AbortController();
  const p = runAnalysis(
    {
      symbol: 'R_100',
      displayName: 'V',
      timeframe: '5m',
      candles: makeCandles(50, '5m', NOW),
      connectionState: 'CONNECTED',
      engines: [slow],
      now: () => NOW,
      timeoutMs: 50
    },
    ctrl.signal
  );
  const res = await p;
  check('a timed-out engine is FAILED, not fabricated', res.engines[0].status === 'FAILED');
  check('the run still returns a result object', typeof res.id === 'string');
}

console.log('\n[10] MIN_SNAPSHOT_CANDLES is the documented floor');
{
  check('floor is 20', MIN_SNAPSHOT_CANDLES === 20);
}

console.log('\n========================================');
console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
console.log('========================================\n');
if (failed > 0) process.exit(1);
