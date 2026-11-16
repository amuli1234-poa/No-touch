import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle, TimeframeKey } from '../types/market';
import { buildTopDownAnalysis, topDownAuthorises } from './topDownAnalysis';
import { topDownDirection } from '../types/topDown';

function mk(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const STEP = 60;
const T0 = 1_700_000_000;

/** Walks a series to each target price, producing real pivots at the turns. */
function walk(legs: number[], start = 100, pad = 0.4, stepsPerLeg = 20): Candle[] {
  const candles: Candle[] = [];
  let t = T0;
  let price = start;
  for (const target of legs) {
    for (let s = 0; s < stepsPerLeg; s++) {
      const o = price;
      const c = price + (target - price) / (stepsPerLeg - s);
      candles.push(mk(t, o, Math.max(o, c) + pad, Math.min(o, c) - pad, c));
      price = c;
      t += STEP;
    }
  }
  return candles;
}

const BULL = walk([104, 101, 108, 104, 113, 109, 118, 114, 123], 100, 0.5);
const BEAR = walk([96, 99, 92, 96, 87, 91, 82, 86, 77], 100, 0.5);

/** A ten-timeframe ladder where every timeframe carries the same series. */
function ladder(series: Candle[]): Partial<Record<TimeframeKey, readonly Candle[]>> {
  const keys: TimeframeKey[] = ['M30', 'M15', 'M10', 'M7', 'M6', 'M5', 'M4', 'M3', 'M2', 'M1'];
  const out: Partial<Record<TimeframeKey, readonly Candle[]>> = {};
  for (const k of keys) out[k] = series;
  return out;
}

test('a fully bullish ladder reads bullish on every role and confirms the execution timeframe', () => {
  const a = buildTopDownAnalysis('R_100', ladder(BULL));
  assert.equal(a.reads.length, 10);
  assert.equal(a.majorBias, 'RISE');
  assert.equal(a.intermediateBias, 'RISE');
  assert.equal(a.executionBias, 'RISE');
  assert.equal(a.refinementBias, 'RISE');
  assert.equal(a.executionConfirmed, true);
  assert.equal(a.aligned, true);
  assert.equal(a.insufficient, false);
  assert.equal(a.contradictions.length, 0);
  assert.equal(topDownDirection(a), 'RISE');
  assert.equal(topDownAuthorises(a, 'RISE'), true);
  assert.equal(topDownAuthorises(a, 'FALL'), false);
});

test('a fully bearish ladder reads bearish on every role', () => {
  const a = buildTopDownAnalysis('R_100', ladder(BEAR));
  assert.equal(a.majorBias, 'FALL');
  assert.equal(a.executionBias, 'FALL');
  assert.equal(topDownDirection(a), 'FALL');
  assert.equal(topDownAuthorises(a, 'FALL'), true);
  assert.equal(a.aligned, true);
});

test('never requires every timeframe to agree — a refinement-only disagreement is a contradiction, not a veto', () => {
  const mixed = { ...ladder(BULL), M4: BEAR, M3: BEAR, M2: BEAR, M1: BEAR };
  const a = buildTopDownAnalysis('R_100', mixed);
  assert.equal(a.majorBias, 'RISE');
  assert.equal(a.intermediateBias, 'RISE');
  assert.equal(a.executionBias, 'RISE');
  assert.equal(a.refinementBias, 'FALL');
  // Major + intermediate + execution still agree, so the entry is authorised…
  assert.equal(topDownDirection(a), 'RISE');
  assert.equal(topDownAuthorises(a, 'RISE'), true);
  // …but the disagreement is surfaced, never hidden.
  assert.ok(a.contradictions.length >= 1);
  assert.ok(a.contradictions.some((c) => c.includes('M5')));
});

test('a major-timeframe contradiction blocks a final entry', () => {
  const mixed = { ...ladder(BULL), M30: BEAR, M15: BEAR };
  const a = buildTopDownAnalysis('R_100', mixed);
  assert.equal(a.executionBias, 'RISE');
  assert.equal(a.majorBias, 'FALL');
  assert.equal(a.aligned, false);
  // M5 alone confirms, but the major bias fights it — the top-down ladder refuses the entry.
  assert.equal(topDownAuthorises(a, 'RISE'), false);
  assert.equal(topDownDirection(a), null);
  assert.ok(a.contradictions.some((c) => c.includes('Major')));
});

test('insufficient data is reported, never fabricated — missing timeframes are simply omitted', () => {
  const a = buildTopDownAnalysis('R_100', { M15: BULL, M5: BULL, M1: BULL });
  assert.equal(a.reads.length, 3);
  assert.equal(a.insufficient, true);
  assert.equal(a.majorBias, 'RISE');
  assert.equal(a.executionBias, 'RISE');
  assert.equal(a.intermediateBias, null);
  assert.equal(a.refinementBias, 'RISE');
});

test('an empty ladder is insufficient and authorises nothing', () => {
  const a = buildTopDownAnalysis('R_100', {});
  assert.equal(a.reads.length, 0);
  assert.equal(a.insufficient, true);
  assert.equal(a.executionConfirmed, false);
  assert.equal(topDownDirection(a), null);
  assert.equal(topDownAuthorises(a, 'RISE'), false);
});

test('a timeframe with too few confirmed bars is omitted rather than read from noise', () => {
  const shortSeries = BULL.slice(0, 10);
  const a = buildTopDownAnalysis('R_100', { ...ladder(BULL), M10: shortSeries });
  assert.ok(!a.reads.some((r) => r.timeframe === 'M10'));
  assert.equal(a.reads.length, 9);
});
