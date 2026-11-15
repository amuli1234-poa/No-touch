import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle, SyntheticMarket } from '../types/market';
import { eligibleMarkets } from '../utils/eligibleMarkets';
import { AI_MODULE_DEFINITIONS } from '../hooks/useAiModules';
import { analyzeTrendlineInstrument } from './trendlineEngine';
import { analyzeDsInstrument } from './demandSupplyEngine';

/**
 * GLOBAL ALL-MARKETS COVERAGE — every AI module must analyse EVERY eligible Volatility
 * Index (standard + 1-second) without throwing, and must return a well-formed analysis.
 * Boom/Crash and every other synthetic family must never appear in the eligible set.
 */

function mk(
  symbol: string,
  displayName: string,
  submarket: string,
  family: SyntheticMarket['family']
): SyntheticMarket {
  return {
    symbol,
    displayName,
    submarket,
    submarketDisplayName: submarket,
    family,
    pip: 0.01,
    precision: 2,
    isOpen: true,
    isSuspended: false,
  };
}

const UNIVERSE: SyntheticMarket[] = [
  mk('R_10', 'Volatility 10 Index', 'random_index', 'VOLATILITY'),
  mk('R_25', 'Volatility 25 Index', 'random_index', 'VOLATILITY'),
  mk('R_50', 'Volatility 50 Index', 'random_index', 'VOLATILITY'),
  mk('R_75', 'Volatility 75 Index', 'random_index', 'VOLATILITY'),
  mk('R_100', 'Volatility 100 Index', 'random_index', 'VOLATILITY'),
  mk('1HZ10V', 'Volatility 10 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ25V', 'Volatility 25 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ50V', 'Volatility 50 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ75V', 'Volatility 75 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ100V', 'Volatility 100 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('BOOM500', 'Boom 500 Index', 'crash_index', 'OTHER'),
  mk('CRASH500', 'Crash 500 Index', 'crash_index', 'OTHER'),
  mk('JD10', 'Jump 10 Index', 'jump_index', 'JUMP'),
  mk('stpRNG', 'Step Index', 'step_index', 'STEP'),
];

/** Deterministic pseudo-random walk so every instrument gets real, varied candles. */
function candlesFor(symbol: string, count = 200, start = 1000): Candle[] {
  let seed = 0;
  for (const ch of symbol) seed = (seed * 31 + ch.charCodeAt(0)) % 1_000_003;
  let price = start;
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const drift = (seed / 2_147_483_648 - 0.5) * 4;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + Math.abs(drift) * 0.5;
    const low = Math.min(open, close) - Math.abs(drift) * 0.5;
    out.push({ time: 1_700_000_000 + i * 60, open, high, low, close });
    price = close;
  }
  return out;
}

test('coverage matrix: every eligible market is present and no excluded family leaks in', () => {
  const symbols = eligibleMarkets(UNIVERSE).map((m) => m.symbol);
  assert.equal(symbols.length, 10);
  for (const bad of ['BOOM500', 'CRASH500', 'JD10', 'stpRNG']) {
    assert.equal(symbols.includes(bad), false, `${bad} must be excluded`);
  }
});

test('coverage matrix: every AI module analyses every eligible market without throwing', () => {
  const markets = eligibleMarkets(UNIVERSE);
  for (const market of markets) {
    const structure = candlesFor(market.symbol, 200, 1000);
    const setup = candlesFor(market.symbol, 200, 1000);
    const entry = candlesFor(market.symbol, 200, 1000);
    for (const def of AI_MODULE_DEFINITIONS) {
      const analysis = def.engine({
        symbol: market.symbol,
        displayName: market.displayName,
        precision: market.precision,
        marketFamily: market.family,
        structureCandles: structure,
        setupCandles: setup,
        entryCandles: entry,
        dataHealth: 'HEALTHY',
        peers: [],
      });
      assert.equal(analysis.symbol, market.symbol, `${def.id} must key its analysis by symbol`);
      assert.equal(typeof analysis.status, 'string');
      assert.ok(Number.isFinite(analysis.bestScore), `${def.id} bestScore must be finite`);
      assert.ok(Array.isArray(analysis.activeZones));
      assert.ok(Array.isArray(analysis.watchZones));
    }
  }
});

test('coverage matrix: Trendline AI and Demand & Supply AI cover every eligible market', () => {
  for (const market of eligibleMarkets(UNIVERSE)) {
    const structure = candlesFor(market.symbol, 200, 1000);
    const setup = candlesFor(market.symbol, 200, 1000);
    const entry = candlesFor(market.symbol, 200, 1000);

    const trend = analyzeTrendlineInstrument({
      symbol: market.symbol,
      displayName: market.displayName,
      precision: market.precision,
      marketFamily: market.family,
      structureCandles: structure,
      entryCandles: setup,
      m1Candles: entry,
      dataHealth: 'HEALTHY',
    });
    assert.equal(trend.symbol, market.symbol);

    const ds = analyzeDsInstrument({
      symbol: market.symbol,
      displayName: market.displayName,
      precision: market.precision,
      marketFamily: market.family,
      structureCandles: structure,
      setupCandles: setup,
      entryCandles: entry,
      dataHealth: 'HEALTHY',
    });
    assert.equal(ds.symbol, market.symbol);
  }
});
