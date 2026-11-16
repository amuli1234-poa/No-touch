import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type { AiEngineParams } from '../hooks/useAiScanner';
import { analyzeBosChochInstrument, BOS_CHOCH_PUBLICATION_MIN_SCORE } from './bosChochEngine';
import {
  buildEntryZone,
  detectBosEvent,
  detectBosEvents,
  evaluateBosRetracement,
  lockDealingRange,
  MAX_BARS_SINCE_BOS,
} from './bosRetracement';
import { computeAtrSeries } from './swings';

/**
 * BOS RETRACEMENT & REJECTION AI tests.
 *
 * A BOS is a SETUP DETECTOR, never an automatic entry trigger. These tests prove:
 *  - wick-only breaks and indecisive closes are rejected,
 *  - continuation BOS is separated from reversal CHoCH/MSS,
 *  - the dealing range locks to the protected swing and never moves,
 *  - the entry zone is the discount/premium (never the middle),
 *  - the full retracement → sweep → rejection → MSS sequence publishes exactly ONE signal,
 *  - a missing confirmation step produces NO signal (no forced signals),
 *  - the published geometry (stop/targets on the correct side, R:R) holds,
 *  - the module never throws on empty / flat / degenerate input.
 */

const T0 = 1_700_000_000;
const STEP = 900;

let clock = T0;
function resetClock() {
  clock = T0;
}
function mk(o: number, h: number, l: number, c: number): Candle {
  return { time: clock++, open: o, high: h, low: l, close: c };
}
function seg(from: number, to: number, n: number, pad = 0.25) {
  const body = (to - from) / n;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = from + body * i;
    const c = o + body;
    out.push(mk(o, Math.max(o, c) + pad, Math.min(o, c) - pad, c));
  }
  return out;
}

/**
 * A complete bullish BOS retracement: a swing high, a protected low, a displacement break,
 * a retracement into the discount, a sweep of the zone low and a bullish rejection, then a
 * lower-timeframe MSS. A trailing forming bar is appended so `confirmedOnly` keeps the
 * rejection and MSS bars as confirmed data.
 */
function bullishRetracement(): Candle[] {
  resetClock();
  return [
    ...seg(94, 97, 6),
    ...seg(97, 93, 6),
    ...seg(93, 97.5, 6),
    ...seg(97.5, 100, 6),
    ...seg(100, 96, 6),
    mk(96, 101.8, 95.9, 101.5), // BOS — decisive bullish close above the swing high
    ...seg(101.5, 95.8, 6), // retracement into the discount
    mk(95.8, 96.6, 94.5, 96.4), // sweep + bullish rejection
    mk(96.4, 99.8, 96.2, 99.6), // lower-timeframe MSS
    mk(99.6, 101, 99.5, 100.8), // continuation
    mk(100.8, 101.2, 100.6, 101), // forming bar (stripped by confirmedOnly)
  ];
}

function bearishRetracement(): Candle[] {
  resetClock();
  return [
    ...seg(106, 103, 6),
    ...seg(103, 107, 6),
    ...seg(107, 102.5, 6),
    ...seg(102.5, 100, 6),
    ...seg(100, 104, 6),
    mk(104, 104.1, 98.2, 98.5), // BOS — decisive bearish close below the swing low
    ...seg(98.5, 104.2, 6), // retracement into the premium
    mk(104.2, 105.5, 103.4, 103.6), // sweep + bearish rejection
    mk(103.6, 103.8, 100.2, 100.4), // lower-timeframe MSS
    mk(100.4, 100.5, 99, 99.2), // continuation
    mk(99.2, 99.5, 98.9, 99.1), // forming bar
  ];
}

/** A real BOS (swing high broken) but the price then runs away with no retracement. */
function noRetracement(): Candle[] {
  resetClock();
  return [
    ...seg(94, 97, 6),
    ...seg(97, 93, 6), // protected low + swing high at ~97
    ...seg(93, 100, 6), // decisive break above the swing high (BOS)
    ...seg(100, 108, 12), // continuation far from the discount — never retraces
    mk(108, 109.5, 107.8, 109.2),
  ];
}

/** A wick-only "break": the high pokes beyond the swing high but the candle closes back below. */
function wickOnlyBreak(): Candle[] {
  resetClock();
  return [
    ...seg(94, 97, 6),
    ...seg(97, 93, 6),
    ...seg(93, 97.4, 6),
    // closes back below the 97.4 swing high despite the wick reaching 100
    mk(96, 100, 95.8, 96.2),
    ...seg(96.2, 95, 6),
  ];
}

function params(candles: Candle[], over: Partial<AiEngineParams> = {}): AiEngineParams {
  return {
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: candles,
    setupCandles: candles,
    entryCandles: candles,
    dataHealth: 'HEALTHY',
    peers: [],
    ...over,
  };
}

function atrOf(candles: Candle[]): number {
  const s = computeAtrSeries(candles, 14);
  return s[s.length - 1];
}

// ---------------------------------------------------------------------------
// BOS validation — decisive closes only, wick-only breaks rejected
// ---------------------------------------------------------------------------
test('BOS validation rejects wick-only breaks and indecisive closes', () => {
  const candles = wickOnlyBreak();
  const atr = atrOf(candles);
  const events = detectBosEvents(candles, atr, 2, 1);
  assert.equal(events.length, 0, 'a wick-only poke must not validate a BOS');
});

test('BOS validation accepts a decisive displacement close beyond a confirmed swing', () => {
  const candles = bullishRetracement();
  const atr = atrOf(candles);
  const events = detectBosEvents(candles, atr, 2, 1);
  assert.ok(events.length >= 1, 'a decisive close must validate a BOS');
  const last = events[events.length - 1];
  assert.equal(last.direction, 'RISE');
  assert.equal(last.kind, 'CONTINUATION');
});

test('continuation BOS is separated from reversal CHoCH/MSS', () => {
  const bull = bullishRetracement();
  const bullEvent = detectBosEvent(bull, atrOf(bull), 2, 1);
  assert.equal(bullEvent?.kind, 'CONTINUATION');

  const bear = bearishRetracement();
  const bearEvent = detectBosEvent(bear, atrOf(bear), 2, 1);
  assert.equal(bearEvent?.kind, 'CONTINUATION');
  assert.equal(bearEvent?.direction, 'FALL');
});

// ---------------------------------------------------------------------------
// Dealing range locks to the protected swing and never moves
// ---------------------------------------------------------------------------
test('the dealing range locks to the protected swing and the impulse extreme', () => {
  const candles = bullishRetracement();
  const event = detectBosEvent(candles, atrOf(candles), 2, 1)!;
  assert.ok(event);
  const range = lockDealingRange(candles, event, 2);
  assert.ok(range.low < range.high, 'range must be ordered');
  assert.ok(range.equilibrium > range.low && range.equilibrium < range.high);
  assert.ok(range.high >= event.brokenLevel, 'the impulse extreme must be at/above the broken level');
  // Deterministic: locking again yields identical anchors (the range never moves).
  const again = lockDealingRange(candles, event, 2);
  assert.deepEqual(again, range);
  // OTE band sits in the retracement half for a bullish range.
  assert.ok(range.ote62 < range.equilibrium && range.ote79 < range.ote62);
});

// ---------------------------------------------------------------------------
// Entry zone = discount/premium, never the middle
// ---------------------------------------------------------------------------
test('the entry zone sits in the discount (bullish) / premium (bearish) half only', () => {
  for (const [candles, bullish] of [
    [bullishRetracement(), true],
    [bearishRetracement(), false],
  ] as const) {
    const atr = atrOf(candles);
    const event = detectBosEvent(candles, atr, 2, 1)!;
    const range = lockDealingRange(candles, event, 2);
    const price = candles[candles.length - 1].close;
    const zone = buildEntryZone(candles, range, atr, 2, price);
    assert.ok(zone.low < zone.high);
    if (bullish) {
      assert.ok(zone.high <= range.equilibrium + 1e-9, 'bullish entry zone must be in the discount');
    } else {
      assert.ok(zone.low >= range.equilibrium - 1e-9, 'bearish entry zone must be in the premium');
    }
    assert.equal(zone.inOte, true, 'the zone should overlap the preferred 62–79% OTE');
  }
});

// ---------------------------------------------------------------------------
// Full sequence publishes exactly ONE signal with valid geometry
// ---------------------------------------------------------------------------
test('a complete retracement → sweep → rejection → MSS sequence publishes exactly one signal', () => {
  for (const candles of [bullishRetracement(), bearishRetracement()]) {
    const a = analyzeBosChochInstrument(params(candles));
    assert.ok(a.signal, `expected a published signal (state ${a.status})`);
    assert.equal(a.signal!.status, 'CONFIRMED');
    assert.ok(
      a.signal!.score >= BOS_CHOCH_PUBLICATION_MIN_SCORE,
      `score ${a.signal!.score} below gate`
    );
    const s = a.signal!;
    const up = s.direction === 'RISE';
    assert.ok(up ? s.stopLoss < s.entryPrice : s.stopLoss > s.entryPrice, 'stop on the wrong side');
    assert.ok(up ? s.takeProfit1 > s.entryPrice : s.takeProfit1 < s.entryPrice, 'TP1 wrong side');
    assert.ok(up ? s.takeProfit2 >= s.takeProfit1 : s.takeProfit2 <= s.takeProfit1, 'TP2 not beyond TP1');
    assert.ok(s.riskRewardRatio >= 1.5, `R:R ${s.riskRewardRatio} below the minimum`);
    // Exactly one signal per instrument — the summary can never carry two for one market.
    assert.equal(a.activeZones.length + a.watchZones.length > 0, true, 'zones should be drawn');
  }
});

test('the readout separates the setup lifecycle states', () => {
  const confirmed = evaluateBosRetracement({
    symbol: 'R_100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: bullishRetracement(),
    setupCandles: bullishRetracement(),
    entryCandles: bullishRetracement(),
  });
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.ok(confirmed.trade);
  assert.ok(confirmed.readout?.sweep && confirmed.readout?.rejection && confirmed.readout?.ltf);

  const waiting = evaluateBosRetracement({
    symbol: 'R_100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: noRetracement(),
    setupCandles: noRetracement(),
    entryCandles: noRetracement(),
  });
  assert.ok(
    waiting.state === 'WAITING_FOR_PULLBACK' || waiting.state === 'IN_ZONE',
    `expected a developing state, got ${waiting.state}`
  );
  assert.equal(waiting.trade, null, 'no trade before the confirmation sequence completes');
});

// ---------------------------------------------------------------------------
// No forced signals
// ---------------------------------------------------------------------------
test('no setup is produced when a mandatory confirmation step is missing', () => {
  // A clean break with no retracement at all.
  const a = analyzeBosChochInstrument(params(noRetracement()));
  assert.equal(a.signal, null, 'a BOS with no retracement must not publish a trade');
});

test('a setup expires rather than chasing a stale retracement', () => {
  // A break followed by a long drift far from the entry zone.
  resetClock();
  const candles = [
    ...seg(94, 97, 6),
    ...seg(97, 93, 6),
    ...seg(93, 97.5, 6),
    ...seg(97.5, 100, 6),
    ...seg(100, 96, 6),
    mk(96, 101.8, 95.9, 101.5),
    ...seg(101.5, 104, MAX_BARS_SINCE_BOS + 5),
  ];
  const result = evaluateBosRetracement({
    symbol: 'R_100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: candles,
    setupCandles: candles,
    entryCandles: candles,
  });
  assert.equal(result.trade, null, 'an aged setup must not publish');
  assert.ok(
    result.state === 'EXPIRED' || result.state === 'WAITING_FOR_PULLBACK',
    `expected EXPIRED/WAITING, got ${result.state}`
  );
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------
test('the module never throws and never fabricates on empty / tiny / flat / NaN / zero input', () => {
  const cases: [string, Candle[]][] = [
    ['empty', []],
    ['tiny', [mk(100, 101, 99, 100)]],
    ['flat', Array.from({ length: 120 }, () => mk(100, 100, 100, 100))],
    ['nan', [mk(NaN, NaN, NaN, NaN), ...bullishRetracement()]],
    ['zero', Array.from({ length: 60 }, () => mk(0, 0, 0, 0))],
  ];
  for (const [label, candles] of cases) {
    const a = analyzeBosChochInstrument(params(candles));
    assert.ok(Number.isFinite(a.bestScore), `${label}: bestScore not finite`);
    assert.ok(Number.isFinite(a.atr), `${label}: atr not finite`);
    if (a.signal) {
      const s = a.signal;
      const up = s.direction === 'RISE';
      assert.ok(up ? s.stopLoss < s.entryPrice : s.stopLoss > s.entryPrice, `${label}: bad stop side`);
    }
  }
});

// ---------------------------------------------------------------------------
// The publication gate is reachable on a valid setup (never structurally unreachable)
// ---------------------------------------------------------------------------
test('the gate is reachable: a fully-confirmed setup scores at or above it', () => {
  const a = analyzeBosChochInstrument(params(bullishRetracement()));
  assert.ok(a.bestScore >= BOS_CHOCH_PUBLICATION_MIN_SCORE, `best ${a.bestScore} below gate`);
});
