import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import { analyzeInstrument } from './signalEngine';
import {
  classifyRangeZone,
  detectBoundaryRejection,
  detectRangeAnalysis,
} from './rangeAnalysis';

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const M15_STEP = 900;
const M5_STEP = 300;

/**
 * Oscillating sideways series between `lo` and `hi`. Each leg is walked in `steps`
 * bars so real swing highs/lows form at both boundaries (confirmed touches).
 */
function oscillate(params: {
  startTime: number;
  step: number;
  lo: number;
  hi: number;
  legs: number[];
  stepsPerLeg?: number;
}): Candle[] {
  const { startTime, step, lo, hi, legs, stepsPerLeg = 4 } = params;
  const candles: Candle[] = [];
  let t = startTime;
  let price = (lo + hi) / 2;
  for (const target of legs) {
    const clamped = Math.max(lo, Math.min(hi, target));
    for (let s = 0; s < stepsPerLeg; s++) {
      const o = price;
      const c = price + (clamped - price) / (stepsPerLeg - s);
      candles.push(candle(t, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c));
      price = c;
      t += step;
    }
  }
  return candles;
}

/** A validated M15 range with support ≈ 100 and resistance ≈ 106. */
function m15Range(): Candle[] {
  return oscillate({
    startTime: 1_700_000_000,
    step: M15_STEP,
    lo: 100,
    hi: 106,
    legs: [100.2, 105.9, 100.1, 106.0, 100.3, 105.8, 100.0, 106.1, 100.2, 105.9, 100.1],
  });
}

function baseParams() {
  return {
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    precision: 2,
    marketFamily: 'VOLATILITY' as MarketFamily,
    timeframe: 'M5' as TimeframeKey,
  };
}

test('detectRangeAnalysis builds support/resistance/equilibrium and the 25/50/25 bands', () => {
  const m15 = m15Range();
  const price = m15[m15.length - 1].close;
  const range = detectRangeAnalysis(m15, price);
  assert.ok(range, 'expected a candidate range');
  assert.equal(range!.valid, true);
  assert.ok(range!.resistance > range!.support);
  assert.ok(Math.abs(range!.equilibrium - (range!.support + range!.resistance) / 2) < 1e-6);
  // Upper 25% trading area sits at the top, lower 25% at the bottom, middle 50% between.
  assert.ok(range!.tradingArea.upper === range!.resistance);
  assert.ok(Math.abs(range!.tradingArea.lower - (range!.resistance - range!.height * 0.25)) < 1e-6);
  assert.ok(Math.abs(range!.noTradeBand.lower - (range!.support + range!.height * 0.25)) < 1e-6);
  assert.ok(range!.noTradeBand.upper === range!.tradingArea.lower);
  assert.ok(range!.resistanceTouches >= 2);
  assert.ok(range!.supportTouches >= 2);
});

test('classifyRangeZone maps price to the correct band', () => {
  const m15 = m15Range();
  const range = detectRangeAnalysis(m15, m15[m15.length - 1].close)!;
  assert.equal(classifyRangeZone(range.resistance - 0.1, range), 'UPPER');
  assert.equal(classifyRangeZone(range.support + 0.1, range), 'LOWER');
  assert.equal(classifyRangeZone(range.equilibrium, range), 'MIDDLE');
  assert.equal(classifyRangeZone(range.resistance + 5, range), 'ABOVE_RANGE');
  assert.equal(classifyRangeZone(range.support - 5, range), 'BELOW_RANGE');
});

test('a decisive break of a boundary invalidates the range', () => {
  const m15 = m15Range();
  const broken = [...m15, candle(m15[m15.length - 1].time + M15_STEP, 106, 112, 105.8, 111)];
  const range = detectRangeAnalysis(broken, 111);
  assert.ok(range);
  assert.equal(range!.valid, false);
  assert.match(range!.reason, /broke above resistance/i);
});

test('detectBoundaryRejection confirms bullish at support and bearish at resistance', () => {
  const atr = 0.6;
  const bull: Candle[] = [
    candle(1, 101, 101.2, 100.8, 101),
    candle(2, 100.8, 101.0, 100.4, 100.9),
    candle(3, 100.6, 101.0, 99.9, 100.8), // wick below support, bullish close back above
    candle(4, 100.8, 101.2, 100.7, 101.1), // live
  ];
  assert.equal(
    detectBoundaryRejection({ candles: bull, boundary: 100, direction: 'RISE', atr }).confirmed,
    true
  );

  const bear: Candle[] = [
    candle(1, 105, 105.4, 104.9, 105),
    candle(2, 105.2, 105.6, 105, 105.1),
    candle(3, 105.4, 106.2, 105.1, 105.2), // wick above resistance, bearish close back below
    candle(4, 105.2, 105.3, 104.8, 104.9), // live
  ];
  assert.equal(
    detectBoundaryRejection({ candles: bear, boundary: 106, direction: 'FALL', atr }).confirmed,
    true
  );
});

/** M5 series inside the range ending with a bullish rejection at support. */
function m5BullishRejectionAtSupport(): Candle[] {
  const m5 = oscillate({
    startTime: 1_700_000_000,
    step: M5_STEP,
    lo: 100.2,
    hi: 105.8,
    legs: [
      100.3, 105.5, 100.4, 105.6, 100.2, 105.4, 100.3, 105.7, 100.1, 105.5, 100.2, 105.6,
      100.3,
    ],
  });
  const t = m5[m5.length - 1].time + M5_STEP;
  m5.push(candle(t, 100.5, 100.9, 99.9, 100.8)); // confirmed bullish rejection at support
  m5.push(candle(t + M5_STEP, 100.8, 101.1, 100.7, 101.0)); // live bar
  return m5;
}

/** M5 series ending mid-range with no boundary interaction (no-trade zone). */
function m5AtMidpoint(): Candle[] {
  const m5 = oscillate({
    startTime: 1_700_000_000,
    step: M5_STEP,
    lo: 100.2,
    hi: 105.8,
    legs: [100.3, 105.5, 100.4, 105.6, 100.2, 105.4, 100.3, 105.7, 100.1, 105.5, 103.0],
  });
  const t = m5[m5.length - 1].time + M5_STEP;
  m5.push(candle(t, 103.0, 103.4, 102.8, 103.1)); // sits at equilibrium, no rejection
  m5.push(candle(t + M5_STEP, 103.1, 103.4, 103.0, 103.2)); // live bar
  return m5;
}

test('sideways range: RISE is produced only at the lower boundary after an M5 rejection', () => {
  const m15 = m15Range();
  const m5 = m5BullishRejectionAtSupport();
  const analysis = analyzeInstrument({
    ...baseParams(),
    candles: m5,
    htfContext: { rangeCandles: m15, entryCandles: m5 },
  });
  assert.equal(analysis.condition, 'SIDEWAYS_RANGE');
  assert.ok(analysis.range?.valid);
  assert.equal(analysis.range?.zone, 'LOWER');
  assert.ok(analysis.signal, 'expected a range-extreme RISE setup');
  assert.equal(analysis.signal!.direction, 'RISE');
  assert.equal(analysis.signal!.model, 'MODEL_3_SUPPORT_RESISTANCE_REJECTION');
});

test('sideways range: no signal is generated in the middle 50% (no-trade zone)', () => {
  const m15 = m15Range();
  const m5 = m5AtMidpoint();
  const analysis = analyzeInstrument({
    ...baseParams(),
    candles: m5,
    htfContext: { rangeCandles: m15, entryCandles: m5 },
  });
  assert.equal(analysis.condition, 'SIDEWAYS_RANGE');
  assert.equal(analysis.range?.zone, 'MIDDLE');
  assert.equal(analysis.signal, null);
  const model3 = analysis.evaluatedModels.find(
    (m) => m.model === 'MODEL_3_SUPPORT_RESISTANCE_REJECTION'
  );
  assert.ok(model3);
  assert.equal(model3!.qualified, false);
});

/** M5 series ending with a bearish rejection at resistance. */
function m5BearishRejectionAtResistance(): Candle[] {
  const m5 = oscillate({
    startTime: 1_700_000_000,
    step: M5_STEP,
    lo: 100.2,
    hi: 105.8,
    legs: [
      105.5, 100.4, 105.6, 100.2, 105.4, 100.3, 105.7, 100.1, 105.5, 100.2, 105.6, 100.3,
      105.5,
    ],
  });
  const t = m5[m5.length - 1].time + M5_STEP;
  m5.push(candle(t, 105.4, 106.2, 105.0, 105.2)); // wick above resistance, bearish close back below
  m5.push(candle(t + M5_STEP, 105.2, 105.3, 104.7, 104.8)); // live bar
  return m5;
}

test('sideways range: FALL is produced only at the upper boundary after an M5 rejection', () => {
  const m15 = m15Range();
  const m5 = m5BearishRejectionAtResistance();
  const analysis = analyzeInstrument({
    ...baseParams(),
    candles: m5,
    htfContext: { rangeCandles: m15, entryCandles: m5 },
  });
  assert.equal(analysis.condition, 'SIDEWAYS_RANGE');
  assert.equal(analysis.range?.zone, 'UPPER');
  assert.ok(analysis.signal, 'expected a range-extreme FALL setup');
  assert.equal(analysis.signal!.direction, 'FALL');
  assert.equal(analysis.signal!.model, 'MODEL_3_SUPPORT_RESISTANCE_REJECTION');
  const range = analysis.range!;
  const target1 = analysis.signal!.target1 ?? analysis.signal!.entryPrice;
  // Targets resolve toward the range extremes, never beyond the range.
  assert.ok(target1 <= range.support + range.height * 0.5);
  // Entry sits inside the upper 25% (resistance trading area).
  assert.ok(analysis.signal!.entryPrice >= range.tradingArea.lower);
  assert.ok(analysis.signal!.entryPrice <= range.resistance);
});

test('sideways range: only the S/R rejection and breakout models are evaluated', () => {
  const m15 = m15Range();
  const m5 = m5AtMidpoint();
  const analysis = analyzeInstrument({
    ...baseParams(),
    candles: m5,
    htfContext: { rangeCandles: m15, entryCandles: m5 },
  });
  const models = analysis.evaluatedModels.map((m) => m.model).sort();
  assert.deepEqual(models, [
    'MODEL_2_BREAKOUT_AND_RETEST',
    'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
  ]);
});

test('sideways range: an internal (mid-range) breakout never yields a signal', () => {
  const m15 = m15Range();
  // M5 series that breaks an INTERNAL level near equilibrium and retests it, while
  // price stays well inside the range. Model 2 must not fire — that would be a signal
  // at the midpoint, which the middle 50% no-trade rule forbids.
  const m5 = oscillate({
    startTime: 1_700_000_000,
    step: M5_STEP,
    lo: 100.2,
    hi: 105.8,
    legs: [100.3, 105.5, 100.4, 105.6, 100.2, 105.4, 100.3, 105.7, 100.1, 105.5, 102.9],
  });
  const t = m5[m5.length - 1].time + M5_STEP;
  m5.push(candle(t, 102.9, 103.6, 102.8, 103.5)); // breaks a minor internal level
  m5.push(candle(t + M5_STEP, 103.5, 103.8, 103.4, 103.7)); // holds and continues
  m5.push(candle(t + 2 * M5_STEP, 103.7, 103.9, 103.6, 103.8)); // live bar
  const analysis = analyzeInstrument({
    ...baseParams(),
    candles: m5,
    htfContext: { rangeCandles: m15, entryCandles: m5 },
  });
  assert.equal(analysis.condition, 'SIDEWAYS_RANGE');
  assert.equal(analysis.range?.zone, 'MIDDLE');
  assert.equal(analysis.signal, null);
});

test('sideways range: invalidation stops the range and a new one forms only after fresh structure', () => {
  // Original range is decisively broken to the upside → invalidated, no range entries.
  const broken = [
    ...m15Range(),
    candle(1_700_000_000 + 999 * M15_STEP, 106, 112, 105.8, 111),
  ];
  const brokenRange = detectRangeAnalysis(broken, 111)!;
  assert.equal(brokenRange.valid, false);
  assert.equal(brokenRange.zone, 'ABOVE_RANGE');
  assert.match(brokenRange.reason, /broke above resistance/i);

  // A brand-new range only forms once sufficient fresh structure develops at the new
  // level — the invalidated range is simply dropped until then.
  const fresh = oscillate({
    startTime: 1_800_000_000,
    step: M15_STEP,
    lo: 110,
    hi: 116,
    legs: [110.2, 115.9, 110.1, 116.0, 110.3, 115.8, 110.0, 116.1, 110.2, 115.9, 110.1],
  });
  const freshRange = detectRangeAnalysis(fresh, fresh[fresh.length - 1].close)!;
  assert.equal(freshRange.valid, true);
  assert.ok(freshRange.support > 105);
  assert.ok(freshRange.resistance > 115);
});
