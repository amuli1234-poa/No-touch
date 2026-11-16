import test from 'node:test';
import assert from 'node:assert/strict';
import type { SyntheticMarket } from '../types/market';
import {
  eligibleMarketMap,
  eligibleMarkets,
  isBoomOrCrash,
  isEligibleMarket,
  isJumpMarket,
  isOneSecondMarket,
  isStepMarket,
} from './eligibleMarkets';

/** Minimal market builder — mirrors what `parseActiveSymbols` produces. */
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

/**
 * A realistic Deriv synthetic universe: the standard + 1-second Volatility Indices the app
 * must cover, plus every family that MUST be excluded (Boom, Crash, Jump, Step, Range,
 * Daily Reset, baskets).
 */
const STANDARD = [
  mk('R_10', 'Volatility 10 Index', 'random_index', 'VOLATILITY'),
  mk('R_25', 'Volatility 25 Index', 'random_index', 'VOLATILITY'),
  mk('R_50', 'Volatility 50 Index', 'random_index', 'VOLATILITY'),
  mk('R_75', 'Volatility 75 Index', 'random_index', 'VOLATILITY'),
  mk('R_100', 'Volatility 100 Index', 'random_index', 'VOLATILITY'),
];

const ONE_SECOND = [
  mk('1HZ10V', 'Volatility 10 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ15V', 'Volatility 15 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ25V', 'Volatility 25 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ30V', 'Volatility 30 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ50V', 'Volatility 50 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ75V', 'Volatility 75 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ90V', 'Volatility 90 (1s) Index', 'random_index', 'VOLATILITY'),
  mk('1HZ100V', 'Volatility 100 (1s) Index', 'random_index', 'VOLATILITY'),
];

const EXCLUDED = [
  mk('BOOM500', 'Boom 500 Index', 'crash_index', 'OTHER'),
  mk('BOOM1000', 'Boom 1000 Index', 'crash_index', 'OTHER'),
  mk('CRASH500', 'Crash 500 Index', 'crash_index', 'OTHER'),
  mk('CRASH1000', 'Crash 1000 Index', 'crash_index', 'OTHER'),
  mk('RB100', 'Range Break 100 Index', 'range_index', 'RANGE_BREAK'),
  mk('RB200', 'Range Break 200 Index', 'range_index', 'RANGE_BREAK'),
  mk('RDBULL', 'Bull Market Index', 'random_daily', 'OTHER'),
  mk('WLDAUD', 'AUD Basket', 'forex_basket', 'OTHER'),
];

/** Jump and Step indices — now analysed by every scanner (Boom/Crash stay excluded). */
const JUMP_STEP = [
  mk('JD10', 'Jump 10 Index', 'jump_index', 'JUMP'),
  mk('JD25', 'Jump 25 Index', 'jump_index', 'JUMP'),
  mk('JD50', 'Jump 50 Index', 'jump_index', 'JUMP'),
  mk('JD75', 'Jump 75 Index', 'jump_index', 'JUMP'),
  mk('JD100', 'Jump 100 Index', 'jump_index', 'JUMP'),
  mk('stpRNG', 'Step Index', 'step_index', 'STEP'),
];

const UNIVERSE = [...STANDARD, ...ONE_SECOND, ...JUMP_STEP, ...EXCLUDED];

test('eligibility: every standard + 1-second Volatility Index is included', () => {
  const eligible = eligibleMarkets(UNIVERSE);
  const symbols = eligible.map((m) => m.symbol);
  const expected = [...STANDARD, ...ONE_SECOND].map((m) => m.symbol);
  for (const s of expected) assert.ok(symbols.includes(s), `${s} must be eligible`);
});

test('eligibility: Jump and Step indices are included', () => {
  const symbols = eligibleMarkets(UNIVERSE).map((m) => m.symbol);
  for (const s of ['JD10', 'JD25', 'JD50', 'JD75', 'JD100', 'stpRNG']) {
    assert.ok(symbols.includes(s), `${s} must be eligible`);
  }
  const jump = JUMP_STEP.find((m) => m.symbol === 'JD10')!;
  assert.equal(isJumpMarket(jump), true);
  const step = JUMP_STEP.find((m) => m.symbol === 'stpRNG')!;
  assert.equal(isStepMarket(step), true);
});

test('eligibility: Boom and Crash are always excluded', () => {
  for (const m of EXCLUDED.filter((x) => /BOOM|CRASH/.test(x.symbol))) {
    assert.equal(isBoomOrCrash(m), true, `${m.symbol} must be flagged Boom/Crash`);
    assert.equal(isEligibleMarket(m), false, `${m.symbol} must be ineligible`);
  }
  const eligible = eligibleMarkets(UNIVERSE).map((m) => m.symbol);
  assert.equal(eligible.some((s) => /BOOM|CRASH/.test(s)), false);
});

test('eligibility: Range Break, Daily Reset and baskets are excluded', () => {
  const eligible = eligibleMarkets(UNIVERSE).map((m) => m.symbol);
  for (const m of ['RB100', 'RB200', 'RDBULL', 'WLDAUD']) {
    assert.equal(eligible.includes(m), false, `${m} must not be eligible`);
  }
});

test('eligibility: a mislabelled Boom/Crash record cannot slip in via family VOLATILITY', () => {
  const mislabelled = mk('BOOM500', 'Boom 500 Index', 'crash_index', 'VOLATILITY');
  assert.equal(isEligibleMarket(mislabelled), false);
});

test('eligibility: 1-second detection recognises every 1HZ symbol', () => {
  for (const m of ONE_SECOND) assert.equal(isOneSecondMarket(m), true, m.symbol);
  for (const m of STANDARD) assert.equal(isOneSecondMarket(m), false, m.symbol);
});

test('eligibility: standard → 1-second → Jump → Step display ordering', () => {
  const ordered = eligibleMarkets(UNIVERSE).map((m) => m.symbol);
  const firstFive = ordered.slice(0, 5);
  assert.deepEqual(firstFive, ['R_10', 'R_25', 'R_50', 'R_75', 'R_100']);
  const oneSecondSlice = ordered.slice(5, 13);
  assert.deepEqual(oneSecondSlice, [
    '1HZ10V',
    '1HZ15V',
    '1HZ25V',
    '1HZ30V',
    '1HZ50V',
    '1HZ75V',
    '1HZ90V',
    '1HZ100V',
  ]);
  assert.deepEqual(ordered.slice(13, 18), ['JD10', 'JD25', 'JD50', 'JD75', 'JD100']);
  assert.deepEqual(ordered.slice(18), ['stpRNG']);
});

test('eligibility: include1Sec=false drops only the 1-second variants', () => {
  const standardOnly = eligibleMarkets(UNIVERSE, { include1Sec: false });
  assert.equal(standardOnly.some(isOneSecondMarket), false);
  // Standard + Jump + Step remain.
  assert.equal(standardOnly.length, 5 + JUMP_STEP.length);
});

test('eligibility: requireOpen=true (default) skips closed markets', () => {
  const withoutR25 = STANDARD.filter((m) => m.symbol !== 'R_25');
  const closed = { ...mk('R_25', 'Volatility 25 Index', 'random_index', 'VOLATILITY'), isOpen: false };
  const open = eligibleMarkets([...withoutR25, closed]);
  assert.equal(open.some((m) => m.symbol === 'R_25'), false);
  const anyState = eligibleMarkets([...withoutR25, closed], { requireOpen: false });
  assert.equal(anyState.some((m) => m.symbol === 'R_25'), true);
});

test('eligibility: eligibleMarketMap indexes every eligible market by symbol', () => {
  const map = eligibleMarketMap(UNIVERSE);
  assert.equal(map.size, 13 + JUMP_STEP.length);
  assert.equal(map.get('R_100')?.displayName, 'Volatility 100 Index');
  assert.equal(map.has('BOOM500'), false);
});
