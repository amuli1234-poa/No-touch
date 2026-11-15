import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type {
  TrendlineAlignment,
  TrendlineMarketCondition,
  TrendlineLine,
} from '../types/trendline';
import { detectSwings } from './swings';
import {
  classifyTrendlineCondition,
  confirmedOnly,
  detectTrendlines,
  linePriceAtTime,
  trendlineAtr,
} from './trendlineDetection';
import {
  detectTrendlineCandidate,
  detectTrendlineRejection,
  isPublishable,
  TRENDLINE_PUBLICATION_MIN_SCORE,
  type TrendlineModelContext,
} from './trendlineModels';
import { evaluateTrendAlignment } from './trendAlignment';
import { buildTrendSetupZones } from './trendRejection';
import { analyzeTrendlineInstrument, trendlineSignalStatus } from './trendlineEngine';

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const M15_STEP = 900;
const M5_STEP = 300;

/** Walks a series to each target price, producing real swing pivots at the turns. */
function walk(params: {
  startTime: number;
  step: number;
  start: number;
  legs: number[];
  stepsPerLeg?: number;
  pad?: number;
}): Candle[] {
  const { startTime, step, legs, stepsPerLeg = 4, pad = 0.25 } = params;
  const candles: Candle[] = [];
  let t = startTime;
  let price = params.start;
  for (const target of legs) {
    for (let s = 0; s < stepsPerLeg; s++) {
      const o = price;
      const c = price + (target - price) / (stepsPerLeg - s);
      candles.push(candle(t, o, Math.max(o, c) + pad, Math.min(o, c) - pad, c));
      price = c;
      t += step;
    }
  }
  return candles;
}

/** M15 staircase uptrend: ascending swing lows 102 → 104 → 106 → 108. */
function m15Uptrend(): Candle[] {
  return walk({
    startTime: 1_700_000_000,
    step: M15_STEP,
    start: 100,
    legs: [104, 102, 106, 104, 108, 106, 110, 108.2],
  });
}


/**
 * Builds a trend-aligned model context. `tradable` is the direction the dominant trend
 * permits (null = WAIT); zones are derived from the trendlines/S-R the module found.
 */
function buildContext(params: {
  m15: Candle[];
  m5: Candle[];
  lines: TrendlineLine[];
  swings: ReturnType<typeof detectSwings>;
  condition: TrendlineMarketCondition;
  structureDirection: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL';
  tradable: 'RISE' | 'FALL' | null;
  price?: number;
}): TrendlineModelContext {
  const atr = trendlineAtr(params.m15, 14);
  const alignment: TrendlineAlignment = {
    dominantTrend: params.tradable === 'RISE' ? 'UPTREND' : params.tradable === 'FALL' ? 'DOWNTREND' : 'RANGING',
    structureLabel: 'test',
    tradableDirection: params.tradable,
    trendConfirmed: params.tradable !== null,
    reversalConfirmed: false,
    reason: 'test',
    continuationBos: null,
  };
  const price = params.price ?? confirmedOnly(params.m5)[confirmedOnly(params.m5).length - 1].close;
  const setupZones = buildTrendSetupZones({
    price,
    atr,
    precision: 2,
    alignment,
    trendlines: params.lines,
    supportResistance: [],
    supplyDemand: [],
    lastTime: confirmedOnly(params.m15)[confirmedOnly(params.m15).length - 1].time,
  });
  return {
    symbol: 'R_100',
    precision: 2,
    condition: params.condition,
    alignment,
    setupZones,
    structureCandles: confirmedOnly(params.m15),
    entryCandles: params.m5,
    structureAtr: atr,
    entryAtr: trendlineAtr(params.m5, 14),
    trendlines: params.lines,
    structureSwings: params.swings,
    structureDirection: params.structureDirection,
    supportResistance: [],
    supplyDemand: [],
    range: null,
    momentumStrongBullish: false,
    momentumStrongBearish: false,
  };
}

/** Aligns an M5 series so its last confirmed bar coincides with the M15 series end. */
function alignedM5Start(m15: readonly Candle[], barsBack = 16): number {
  return m15[m15.length - 1].time - barsBack * M5_STEP;
}

/**
 * Builds an M5 series that approaches `boundary`, then prints a rejection candle:
 * the wick probes the boundary and the candle CLOSES back on the correct side.
 */
function m5Rejection(boundary: number, dir: 'RISE' | 'FALL', startTime: number): Candle[] {
  const candles: Candle[] = [];
  let t = startTime;
  const above = dir === 'RISE';
  const from = above ? boundary + 1.4 : boundary - 1.4;
  const to = above ? boundary + 0.35 : boundary - 0.35;
  for (let i = 0; i < 14; i++) {
    const o = from + (to - from) * (i / 13);
    const c = from + (to - from) * ((i + 1) / 13);
    candles.push(candle(t, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c));
    t += M5_STEP;
  }
  if (above) {
    // Bullish rejection: wick probes below the line, bullish close back above it.
    candles.push(candle(t, boundary + 0.25, boundary + 0.4, boundary - 0.15, boundary + 0.35));
  } else {
    // Bearish rejection: wick probes above the line, bearish close back below it.
    candles.push(candle(t, boundary - 0.25, boundary + 0.15, boundary - 0.4, boundary - 0.35));
  }
  t += M5_STEP;
  // Live (forming) bar.
  candles.push(
    above
      ? candle(t, boundary + 0.35, boundary + 0.55, boundary + 0.3, boundary + 0.45)
      : candle(t, boundary - 0.35, boundary - 0.3, boundary - 0.55, boundary - 0.45)
  );
  return candles;
}

test('detectTrendlines finds a valid ascending support line', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const lines = detectTrendlines(m15, swings, atr, 2);
  const support = lines.find((l) => l.kind === 'support' && l.valid);
  assert.ok(support, 'expected a valid ascending support trendline');
  assert.equal(support!.trend, 'ascending');
  assert.ok(support!.touches >= 2);
});

test('mandatory rejection: RISE needs a bullish reclaim of the trendline', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const line = detectTrendlines(m15, swings, atr, 2).find((l) => l.kind === 'support' && l.valid)!;

  const good = m5Rejection(line.currentPrice, 'RISE', alignedM5Start(m15));
  const goodRej = detectTrendlineRejection({
    entryCandles: good,
    boundaryPrice: line.currentPrice,
    direction: 'RISE',
    atr: trendlineAtr(good, 14),
  });
  assert.equal(goodRej.confirmed, true);
  assert.equal(goodRej.kind, 'BULLISH_REJECTION');

  // A series that closes below the boundary must NOT confirm a bullish rejection.
  const bad = m5Rejection(line.currentPrice, 'RISE', alignedM5Start(m15)).map((c) =>
    candle(c.time, c.open, c.high, c.low, c.low)
  );
  const badRej = detectTrendlineRejection({
    entryCandles: bad,
    boundaryPrice: line.currentPrice,
    direction: 'RISE',
    atr: trendlineAtr(bad, 14),
  });
  assert.equal(badRej.confirmed, false);
});

test('classifyTrendlineCondition reports an uptrend for ascending structure', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const lines = detectTrendlines(m15, swings, atr, 2);
  const { condition } = classifyTrendlineCondition({
    candles: m15,
    trendlines: lines,
    structureDirection: 'BULLISH',
    structureSequence: { hh: true, hl: true, lh: false, ll: false },
    overlapRatio: 0.5,
    rangeZone: null,
    rangeValid: false,
  });
  assert.equal(condition, 'UPTREND');
});

test('classifyTrendlineCondition reports a range extreme inside a validated range', () => {
  const { condition } = classifyTrendlineCondition({
    candles: [],
    trendlines: [],
    structureDirection: 'RANGING',
    structureSequence: { hh: false, hl: false, lh: false, ll: false },
    overlapRatio: 0.4,
    rangeZone: 'LOWER',
    rangeValid: true,
  });
  assert.equal(condition, 'RANGE_EXTREME');
});

test('Model T1 — rejection publishes a confirmed RISE signal at ascending support', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const line = detectTrendlines(m15, swings, atr, 2).find((l) => l.kind === 'support' && l.valid)!;
  const m5 = m5Rejection(line.currentPrice, 'RISE', alignedM5Start(m15));

  const analysis = analyzeTrendlineInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: m15,
    entryCandles: m5,
  });

  assert.equal(analysis.condition, 'UPTREND');
  assert.ok(analysis.bestCandidate, 'expected a trendline candidate');
  assert.equal(analysis.bestCandidate!.model, 'TRENDLINE_REJECTION');
  assert.equal(analysis.bestCandidate!.direction, 'RISE');
  assert.equal(analysis.bestCandidate!.rejection.confirmed, true);
  assert.ok(analysis.signal, 'expected a published signal');
  assert.ok(analysis.signal!.score >= TRENDLINE_PUBLICATION_MIN_SCORE);
  assert.ok(analysis.signal!.stopLoss < analysis.signal!.entryPrice);
  assert.ok(analysis.signal!.takeProfit > analysis.signal!.entryPrice);
  assert.ok(analysis.signal!.riskRewardRatio > 0);
});

test('Model T1 — the candidate carries the trend-aligned setup zone it rejected from', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const lines = detectTrendlines(m15, swings, atr, 2);
  const line = lines.find((l) => l.kind === 'support' && l.valid)!;
  const m5 = m5Rejection(line.currentPrice, 'RISE', alignedM5Start(m15));

  const candidate = detectTrendlineCandidate(
    buildContext({
      m15,
      m5,
      lines,
      swings,
      condition: 'UPTREND',
      structureDirection: 'BULLISH',
      tradable: 'RISE',
    })
  );
  assert.ok(candidate, 'expected a trend-aligned RISE candidate');
  assert.ok(candidate!.zone, 'expected the setup zone to be attached to the candidate');
  assert.equal(candidate!.zone!.direction, 'RISE');
  assert.equal(candidate!.scores.trendAlignment, 15, 'confirmed trend earns full alignment marks');
});

test('Model T2/T3 — breakout of descending resistance yields a confirmed RISE', () => {
  // Downtrend with a descending resistance trendline, then a rally that breaks it.
  const m15 = walk({
    startTime: 1_700_000_000,
    step: M15_STEP,
    start: 112,
    legs: [110, 106, 109, 105, 108, 104, 107, 105, 113],
  });
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const lines = detectTrendlines(m15, swings, atr, 2);
  const broken = lines.find((l) => l.kind === 'resistance' && l.broken);
  assert.ok(broken, 'expected a broken descending resistance trendline');

  const boundary = linePriceAtTime(broken!, alignedM5Start(m15) + 14 * M5_STEP);
  const m5 = m5Rejection(boundary, 'RISE', alignedM5Start(m15));

  const candidate = detectTrendlineCandidate(
    buildContext({
      m15,
      m5,
      lines,
      swings,
      condition: 'DOWNTREND',
      structureDirection: 'BEARISH',
      // The broken descending resistance is now support: an uptrend continuation.
      tradable: 'RISE',
      price: boundary,
    })
  );
  assert.ok(candidate, 'expected a candidate');
  // A broken descending resistance flips to support; whether it is reported as a
  // rejection at the flipped level or as a breakout/retest, it must be a trend-aligned RISE.
  assert.ok(
    candidate!.model === 'TRENDLINE_REJECTION' ||
      candidate!.model === 'TRENDLINE_BREAKOUT' ||
      candidate!.model === 'TRENDLINE_BREAKOUT_RETEST',
    `expected a trend-aligned RISE model, got ${candidate!.model}`
  );
  assert.equal(candidate!.direction, 'RISE');
  assert.equal(candidate!.rejection.confirmed, true);
});

test('counter-trend is rejected: a bullish rejection in a downtrend yields nothing', () => {
  // Downtrend structure with a bullish (RISE) rejection at support — must be ignored.
  const m15 = walk({
    startTime: 1_700_000_000,
    step: M15_STEP,
    start: 112,
    legs: [110, 106, 109, 105, 108, 104, 107, 105, 113],
  });
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const lines = detectTrendlines(m15, swings, atr, 2);
  const broken = lines.find((l) => l.kind === 'resistance' && l.broken)!;
  const boundary = linePriceAtTime(broken, alignedM5Start(m15) + 14 * M5_STEP);
  const m5 = m5Rejection(boundary, 'RISE', alignedM5Start(m15));

  const candidate = detectTrendlineCandidate(
    buildContext({
      m15,
      m5,
      lines,
      swings,
      condition: 'DOWNTREND',
      structureDirection: 'BEARISH',
      // Dominant trend is DOWN → only FALL is permitted, so the RISE rejection is ignored.
      tradable: 'FALL',
      price: boundary,
    })
  );
  assert.equal(candidate, null, 'a counter-trend RISE must never be produced in a downtrend');
});

test('WAIT: no tradable direction ⇒ no candidate even with a valid rejection', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const line = detectTrendlines(m15, swings, atr, 2).find((l) => l.kind === 'support' && l.valid)!;
  const m5 = m5Rejection(line.currentPrice, 'RISE', alignedM5Start(m15));

  const candidate = detectTrendlineCandidate(
    buildContext({
      m15,
      m5,
      lines: [line],
      swings,
      condition: 'SIDEWAYS',
      structureDirection: 'RANGING',
      tradable: null,
      price: line.currentPrice,
    })
  );
  assert.equal(candidate, null, 'a ranging / unclear market must produce WAIT');
});

test('Model T4 — liquidity sweep & reclaim yields a confirmed RISE', () => {
  const m15 = walk({
    startTime: 1_700_000_000,
    step: M15_STEP,
    start: 104,
    legs: [106, 101.5, 105, 100.5, 104, 101, 103.5, 100.8],
  });
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const lines = detectTrendlines(m15, swings, atr, 2);
  const lastLow = swings.filter((s) => s.type === 'low').pop()!;

  const start = alignedM5Start(m15);
  const m5: Candle[] = [];
  let t = start;
  let price = lastLow.price + 0.9;
  for (let i = 0; i < 13; i++) {
    const o = price;
    const c = o - 0.03;
    m5.push(candle(t, o, o + 0.05, c - 0.05, c));
    price = c;
    t += M5_STEP;
  }
  // Sweep below the swing low and reclaim it on the same bar (bullish rejection).
  m5.push(candle(t, lastLow.price + 0.15, lastLow.price + 0.3, lastLow.price - 0.4, lastLow.price + 0.25));
  t += M5_STEP;
  m5.push(candle(t, lastLow.price + 0.25, lastLow.price + 0.5, lastLow.price + 0.2, lastLow.price + 0.4));

  const candidate = detectTrendlineCandidate(
    buildContext({
      m15,
      m5,
      lines,
      swings,
      condition: 'SIDEWAYS',
      structureDirection: 'RANGING',
      tradable: 'RISE',
      price: lastLow.price,
    })
  );
  assert.ok(candidate, 'expected a sweep & reclaim candidate');
  assert.equal(candidate!.model, 'TRENDLINE_LIQUIDITY_SWEEP_RECLAIM');
  assert.equal(candidate!.direction, 'RISE');
  assert.equal(candidate!.rejection.confirmed, true);
});

test('no confirmed rejection ⇒ no candidate and no signal (never a developing setup)', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const line = detectTrendlines(m15, swings, atr, 2).find((l) => l.kind === 'support' && l.valid)!;
  // M5 series that stays well above the trendline with no rejection at it.
  const start = alignedM5Start(m15);
  const flat: Candle[] = [];
  let t = start;
  const priceAt = (time: number) => line.startPrice + line.slopePerSec * (time - line.startTime);
  let p = priceAt(t) + 3;
  for (let i = 0; i < 16; i++) {
    const o = p;
    const c = p + 0.05;
    flat.push(candle(t, o, c + 0.08, o - 0.08, c));
    p = c;
    t += M5_STEP;
  }

  const analysis = analyzeTrendlineInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: m15,
    entryCandles: flat,
  });
  assert.equal(analysis.signal, null);
});

test('scoring gate: isPublishable requires >= 85 and a confirmed rejection', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const line = detectTrendlines(m15, swings, atr, 2).find((l) => l.kind === 'support' && l.valid)!;
  const m5 = m5Rejection(line.currentPrice, 'RISE', alignedM5Start(m15));
  const analysis = analyzeTrendlineInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: m15,
    entryCandles: m5,
  });
  const candidate = analysis.bestCandidate!;
  assert.equal(isPublishable(candidate), candidate.scores.total >= 85);
});

test('invalidation: a close beyond the stop marks the signal invalidated; target completes it', () => {
  const m15 = m15Uptrend();
  const atr = trendlineAtr(m15, 14);
  const swings = detectSwings(m15, 3, 3);
  const line = detectTrendlines(m15, swings, atr, 2).find((l) => l.kind === 'support' && l.valid)!;
  const m5 = m5Rejection(line.currentPrice, 'RISE', alignedM5Start(m15));
  const analysis = analyzeTrendlineInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: m15,
    entryCandles: m5,
  });
  const signal = analysis.signal!;
  const breakBar = candle(
    signal.confirmedBarTime + M5_STEP,
    signal.stopLoss + 0.5,
    signal.stopLoss + 0.5,
    signal.stopLoss - 0.5,
    signal.stopLoss - 0.2
  );
  assert.equal(trendlineSignalStatus(signal, [breakBar]), 'INVALIDATED');
  const targetBar = candle(
    signal.confirmedBarTime + M5_STEP,
    signal.entryPrice,
    signal.takeProfit + 0.1,
    signal.entryPrice,
    signal.takeProfit
  );
  assert.equal(trendlineSignalStatus(signal, [targetBar]), 'COMPLETED');
});
