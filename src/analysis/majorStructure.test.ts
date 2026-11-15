import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import { computeAtrSeries, detectSwings } from './swings';
import { detectMajorSwings, detectMajorTrendlines, detectMajorZones } from './majorStructure';
import { analyzeMarketIntelligence } from './marketIntelligence';

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const STEP = 900;

/** Walks a series to each target price, producing real swing pivots at the turns. */
function walk(params: {
  startTime?: number;
  start: number;
  legs: number[];
  stepsPerLeg?: number;
  pad?: number;
}): Candle[] {
  const { legs, stepsPerLeg = 4, pad = 0.25 } = params;
  const candles: Candle[] = [];
  let t = params.startTime ?? 1_700_000_000;
  let price = params.start;
  for (const target of legs) {
    for (let s = 0; s < stepsPerLeg; s++) {
      const o = price;
      const c = price + (target - price) / (stepsPerLeg - s);
      candles.push(candle(t, o, Math.max(o, c) + pad, Math.min(o, c) - pad, c));
      price = c;
      t += STEP;
    }
  }
  return candles;
}

function atrOf(candles: readonly Candle[]): number {
  const atrs = computeAtrSeries(candles, 14);
  return atrs[atrs.length - 1] || 1e-6;
}

/** A clean staircase uptrend with strong up-displacement and rejection at each turn. */
function uptrend(): Candle[] {
  return walk({
    start: 100,
    legs: [100, 106, 103.5, 110, 107, 115, 111, 122, 119, 122.4],
  });
}

/** A clean staircase downtrend. */
function downtrend(): Candle[] {
  return walk({
    start: 120,
    legs: [120, 114, 116.5, 110, 113, 105, 109, 98, 101, 97.6],
  });
}

test('detectMajorSwings keeps only significant pivots and labels them', () => {
  const candles = uptrend();
  const atrs = computeAtrSeries(candles, 14);
  const majors = detectMajorSwings(candles, atrs, atrs[atrs.length - 1]);
  const raw = detectSwings(candles, 3, 3);

  assert.ok(majors.length > 0, 'should find at least one major swing');
  assert.ok(majors.length <= raw.length, 'majors are a filtered subset of raw swings');
  assert.ok(
    majors.every((m) => m.strength >= 0.45),
    'every major swing clears the significance floor'
  );
  // Higher lows in an uptrend should be labelled HL.
  const lows = majors.filter((m) => m.type === 'low');
  assert.ok(lows.some((l) => l.label === 'HL'), 'uptrend major lows are HL');
});

test('detectMajorSwings discards insignificant local fluctuations', () => {
  // Flat chop with tiny 0.02 ripples — no pivot should qualify as major.
  const candles: Candle[] = [];
  let t = 1_700_000_000;
  for (let i = 0; i < 60; i++) {
    const base = 100 + (i % 2 === 0 ? 0.02 : -0.02);
    candles.push(candle(t, base, base + 0.03, base - 0.03, base));
    t += STEP;
  }
  const atrs = computeAtrSeries(candles, 14);
  const majors = detectMajorSwings(candles, atrs, atrs[atrs.length - 1]);
  assert.equal(majors.length, 0, 'flat chop produces no major swings');
});

test('detectMajorTrendlines connects major higher lows in an uptrend', () => {
  const candles = uptrend();
  const atrs = computeAtrSeries(candles, 14);
  const atr = atrs[atrs.length - 1];
  const majors = detectMajorSwings(candles, atrs, atr);
  const lines = detectMajorTrendlines(candles, majors, atr, 2);

  const bull = lines.find((l) => l.direction === 'bullish');
  assert.ok(bull, 'an ascending support trendline is found');
  assert.ok(bull!.anchors.length >= 2, 'at least two structural anchors');
  assert.ok(bull!.anchors[1].price > bull!.anchors[0].price, 'anchors are higher lows');
  assert.ok(bull!.touches >= 2, 'at least two touches');
  assert.ok(!bull!.broken, 'a live uptrend line is not broken');
});

test('detectMajorTrendlines omits broken (auto-invalidated) lines', () => {
  // Strong uptrend then a decisive breakdown below the rising support.
  const candles = walk({ start: 100, legs: [104, 102, 106, 104, 108, 106, 96, 92] });
  const atrs = computeAtrSeries(candles, 14);
  const atr = atrs[atrs.length - 1];
  const majors = detectMajorSwings(candles, atrs, atr);
  const lines = detectMajorTrendlines(candles, majors, atr, 2);
  assert.ok(
    lines.every((l) => !l.broken),
    'broken trendlines are excluded from the output'
  );
});

test('detectMajorZones builds bounded support/resistance rectangles', () => {
  const candles = uptrend();
  const atrs = computeAtrSeries(candles, 14);
  const atr = atrs[atrs.length - 1];
  const majors = detectMajorSwings(candles, atrs, atr);
  const zones = detectMajorZones(candles, majors, atr, 2);

  assert.ok(zones.length > 0, 'at least one major zone is produced');
  for (const z of zones) {
    assert.ok(z.upperPrice > z.lowerPrice, 'zone has a positive height');
    assert.ok(
      z.upperPrice - z.lowerPrice <= atr * 1.4 + 1e-6,
      'zone never exceeds the maximum height'
    );
    assert.ok(z.reactions >= 1, 'zone records its reactions');
  }
});

test('detectMajorZones never leaves overlapping zones', () => {
  const candles = uptrend();
  const atrs = computeAtrSeries(candles, 14);
  const atr = atrs[atrs.length - 1];
  const majors = detectMajorSwings(candles, atrs, atr);
  const zones = detectMajorZones(candles, majors, atr, 2);
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const overlap =
        Math.min(zones[i].upperPrice, zones[j].upperPrice) -
        Math.max(zones[i].lowerPrice, zones[j].lowerPrice);
      assert.ok(overlap <= atr * 0.25 + 1e-6, 'zones do not overlap');
    }
  }
});

test('analyzeMarketIntelligence reports a bullish bias and trend condition', () => {
  const intel = analyzeMarketIntelligence({
    symbol: 'R_100',
    timeframe: 'M15',
    candles: uptrend(),
    precision: 2,
  });
  assert.equal(intel.bias, 'bullish');
  assert.equal(intel.condition, 'TRENDING');
  assert.ok(intel.majorSwings.length > 0);
  assert.ok(intel.trendlines.length > 0);
  assert.ok(intel.report.biasSummary.length > 0);
});

test('analyzeMarketIntelligence reports a bearish bias in a downtrend', () => {
  const intel = analyzeMarketIntelligence({
    symbol: 'R_100',
    timeframe: 'M15',
    candles: downtrend(),
    precision: 2,
  });
  assert.equal(intel.bias, 'bearish');
  assert.ok(intel.report.bearishScenario.summary.length > 0);
});

test('analyzeMarketIntelligence produces both scenarios with invalidations', () => {
  const intel = analyzeMarketIntelligence({
    symbol: 'R_100',
    timeframe: 'M15',
    candles: uptrend(),
    precision: 2,
  });
  assert.equal(intel.report.bullishScenario.direction, 'bullish');
  assert.equal(intel.report.bearishScenario.direction, 'bearish');
  assert.ok(intel.report.bullishScenario.invalidation.length > 0);
  assert.ok(intel.report.bearishScenario.invalidation.length > 0);
});

test('analyzeMarketIntelligence returns an empty, non-tradeable read without history', () => {
  const candles = walk({ start: 100, legs: [101, 100, 101] });
  const intel = analyzeMarketIntelligence({
    symbol: 'R_100',
    timeframe: 'M15',
    candles,
    precision: 2,
  });
  assert.equal(intel.tradeable, false);
  assert.ok(intel.noTradeReason);
  assert.equal(intel.majorSwings.length, 0);
  assert.equal(intel.report.structuralLevels.length, 0);
});
