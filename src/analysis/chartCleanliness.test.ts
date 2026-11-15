import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type {
  ChartOverlayData,
  StructureBreakEvent,
  SupportResistanceLevel,
  SwingPoint,
  TrendlineStructure,
} from '../types/analysis';
import type { StructureOverlayData } from '../types/structure';
import {
  MAX_BREAK_AGE_BARS,
  isStructureBreakStillHolding,
  pruneOverlaysForLiveChart,
  pruneStructureOverlay,
} from './chartCleanliness';

const STEP = 900;
const T0 = 1_700_000_000;

function mk(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

/** A flat run of candles at `price` (small noise) so indices/times are predictable. */
function flat(count: number, price = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push(mk(T0 + i * STEP, price, price + 0.2, price - 0.2, price));
  }
  return out;
}

function emptyOverlays(): ChartOverlayData {
  return {
    supportResistance: [],
    supplyDemand: [],
    structureBreaks: [],
    liquiditySweeps: [],
    trendlines: [],
    patterns: [],
    swingPoints: [],
    majorTrendlines: [],
    majorZones: [],
    range: null,
    entryZone: null,
    breakoutRetest: null,
    signal: null,
    structure: null,
  };
}

function level(partial: Partial<SupportResistanceLevel>): SupportResistanceLevel {
  return {
    id: 'sr',
    price: 100,
    type: 'support',
    touches: 2,
    firstTouchTime: T0,
    lastTouchTime: T0,
    status: 'active',
    importance: 'major',
    reason: '',
    ...partial,
  };
}

function swing(index: number): SwingPoint {
  return { index, time: T0 + index * STEP, price: 100, type: 'high' };
}

function trendline(partial: Partial<TrendlineStructure>): TrendlineStructure {
  return {
    id: 'tl',
    direction: 'bullish',
    startTime: T0,
    startPrice: 100,
    endTime: T0 + STEP,
    endPrice: 101,
    slopePerSec: 1e-9,
    touches: 2,
    broken: false,
    reason: '',
    ...partial,
  };
}

test('broken support/resistance levels are removed from the live chart', () => {
  const candles = flat(50);
  const overlays = emptyOverlays();
  overlays.supportResistance = [
    level({ id: 'active', status: 'active' }),
    level({ id: 'broken', status: 'broken' }),
  ];
  const clean = pruneOverlaysForLiveChart({ overlays, candles, atr: 1 });
  assert.deepEqual(clean.supportResistance.map((l) => l.id), ['active']);
});

test('invalidated supply/demand zones are dropped but fresh/tested remain', () => {
  const candles = flat(50);
  const overlays = emptyOverlays();
  overlays.supplyDemand = [
    { id: 'f', status: 'fresh' } as never,
    { id: 't', status: 'tested' } as never,
    { id: 'x', status: 'invalidated' } as never,
  ];
  const clean = pruneOverlaysForLiveChart({ overlays, candles, atr: 1 });
  assert.deepEqual(clean.supplyDemand.map((z) => z.id), ['f', 't']);
});

test('a structure break reversed by a decisive close back through the level is dropped', () => {
  // Break at index 10; price then closes well back below the broken level.
  const candles = flat(40);
  candles[10] = mk(T0 + 10 * STEP, 100, 101.5, 99.8, 101);
  for (let i = 11; i < candles.length; i++) {
    candles[i] = mk(T0 + i * STEP, 99.5, 99.7, 98.8, 99);
  }
  const brk: StructureBreakEvent = {
    id: 'b',
    kind: 'BOS',
    direction: 'bullish',
    time: T0 + 10 * STEP,
    index: 10,
    price: 101,
    brokenLevel: 100.5,
    momentumConfirmed: true,
    reason: '',
  };
  assert.equal(isStructureBreakStillHolding(brk, candles, 1), false);
});

test('an old structure break beyond the age window is removed even if price holds', () => {
  const candles = flat(200, 100);
  const overlays = emptyOverlays();
  overlays.structureBreaks = [
    {
      id: 'old',
      kind: 'BOS',
      direction: 'bullish',
      time: candles[10].time,
      index: 10,
      price: 101,
      brokenLevel: 99,
      momentumConfirmed: true,
      reason: '',
    },
    {
      id: 'fresh',
      kind: 'BOS',
      direction: 'bullish',
      time: candles[candles.length - 5].time,
      index: candles.length - 5,
      price: 101,
      brokenLevel: 99,
      momentumConfirmed: true,
      reason: '',
    },
  ];
  const clean = pruneOverlaysForLiveChart({ overlays, candles, atr: 1 });
  assert.deepEqual(clean.structureBreaks.map((b) => b.id), ['fresh']);
  assert.ok(candles.length - 1 - 10 > MAX_BREAK_AGE_BARS);
});

test('broken trendlines are removed; lines that still hold are kept', () => {
  const candles = flat(50);
  const overlays = emptyOverlays();
  overlays.trendlines = [
    trendline({ id: 'hold', broken: false, endTime: candles[40].time }),
    trendline({ id: 'broken', broken: true, endTime: candles[45].time }),
    trendline({ id: 'scrolled', broken: false, endTime: T0 - 5 * STEP }),
  ];
  const clean = pruneOverlaysForLiveChart({ overlays, candles, atr: 1 });
  assert.deepEqual(clean.trendlines.map((l) => l.id), ['hold']);
});

test('completed (confirmed) patterns are removed; active ones stay', () => {
  const candles = flat(50);
  const overlays = emptyOverlays();
  overlays.patterns = [
    { id: 'done', confirmed: true } as never,
    { id: 'live', confirmed: false } as never,
  ];
  const clean = pruneOverlaysForLiveChart({ overlays, candles, atr: 1 });
  assert.deepEqual(clean.patterns.map((p) => p.id), ['live']);
});

test('only recent swing labels are kept on the chart', () => {
  const candles = flat(100);
  const overlays = emptyOverlays();
  overlays.swingPoints = [swing(5), swing(60), swing(98)];
  const clean = pruneOverlaysForLiveChart({ overlays, candles, atr: 1 });
  assert.deepEqual(clean.swingPoints.map((s) => s.index), [98]);
});

test('structure overlay pruning drops mitigated bands and invalidated zones', () => {
  const candles = flat(60);
  const structure: StructureOverlayData = {
    bias: 'bullish',
    htfBias: 'bullish',
    htfTimeframe: 'H1',
    breaks: [],
    rejectionZones: [
      { id: 'fresh', freshness: 'FRESH' } as never,
      { id: 'dead', freshness: 'MITIGATED' } as never,
      { id: 'invalid', freshness: 'INVALIDATED' } as never,
    ],
    srBands: [
      { id: 'active', status: 'active' } as never,
      { id: 'broken', status: 'broken' } as never,
    ],
    fvg: [
      { id: 'gap', freshness: 'FRESH' } as never,
      { id: 'filled', freshness: 'MITIGATED' } as never,
      { id: 'probed', freshness: 'PROBED' } as never,
    ],
    watchZones: [],
    testedZones: [],
    summary: '',
  };
  const clean = pruneStructureOverlay({ structure, candles, atr: 1 });
  assert.ok(clean);
  assert.deepEqual(clean!.rejectionZones.map((z) => z.id), ['fresh']);
  assert.deepEqual(clean!.srBands.map((b) => b.id), ['active']);
  assert.deepEqual(clean!.fvg.map((g) => g.id), ['gap']);
});

test('failed / invalidated / mitigated watch zones are removed from the chart', () => {
  const candles = flat(60);
  const structure: StructureOverlayData = {
    bias: 'bullish',
    htfBias: 'bullish',
    htfTimeframe: 'H1',
    breaks: [],
    rejectionZones: [],
    srBands: [],
    fvg: [],
    watchZones: [
      { id: 'watching', stage: 'ZONE_DETECTED', freshness: 'FRESH' } as never,
      { id: 'approaching', stage: 'PRICE_APPROACHING', freshness: 'FRESH' } as never,
      { id: 'failed', stage: 'FAILED', freshness: 'FRESH' } as never,
      { id: 'dead', stage: 'INVALIDATED', freshness: 'FRESH' } as never,
      { id: 'consumed', stage: 'ZONE_DETECTED', freshness: 'MITIGATED' } as never,
    ],
    testedZones: [],
    summary: '',
  };
  const clean = pruneStructureOverlay({ structure, candles, atr: 1 });
  assert.ok(clean);
  assert.deepEqual(clean!.watchZones.map((z) => z.id), ['watching', 'approaching']);
});

test('pruning a null structure overlay is a no-op', () => {
  assert.equal(pruneStructureOverlay({ structure: null, candles: flat(10), atr: 1 }), null);
});
