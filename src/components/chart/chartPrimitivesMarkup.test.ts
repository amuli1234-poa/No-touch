import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChartOverlayData } from '../../types/analysis';
import { AnalysisChartPrimitive } from '../AnalysisChartPrimitive';
import { StructureChartPrimitive } from './StructureChartPrimitive';
import { DsChartPrimitive } from './DsChartPrimitive';
import { AiChartPrimitive } from './AiChartPrimitive';
import { TrendlineChartPrimitive } from './TrendlineChartPrimitive';
import { SignalAnnotationPrimitive } from './SignalAnnotationPrimitive';

/**
 * Runtime markup guard: drives every primitive's real draw path against a recording
 * canvas context and asserts the minimalist contract holds at paint time — thin shape
 * strokes, barely-there fills and short labels. This exercises the actual drawing code
 * (not a re-implementation), so a future edit cannot reintroduce thick borders or
 * sentence-length labels without failing here.
 */

interface Recording {
  shapeStrokeWidths: number[];
  fillAlphas: number[];
  texts: string[];
}

function alphaOf(style: unknown): number | null {
  if (typeof style !== 'string') return null;
  const m = style.match(/rgba\([^)]*,\s*([0-9.]+)\s*\)/);
  return m ? Number(m[1]) : null;
}

function makeContext(rec: Recording): CanvasRenderingContext2D {
  let lineWidth = 1;
  let fillStyle: unknown = '#000';
  const ctx = {
    get lineWidth() {
      return lineWidth;
    },
    set lineWidth(v: number) {
      lineWidth = v;
    },
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    strokeStyle: '#000',
    font: '',
    textAlign: 'left',
    textBaseline: 'middle',
    lineJoin: 'round',
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    setLineDash() {},
    stroke() {
      rec.shapeStrokeWidths.push(lineWidth);
    },
    strokeRect() {
      rec.shapeStrokeWidths.push(lineWidth);
    },
    fill() {},
    fillRect() {
      const a = alphaOf(fillStyle);
      if (a !== null) rec.fillAlphas.push(a);
    },
    fillText(text: string) {
      rec.texts.push(String(text));
    },
    strokeText() {
      // Halo pass of drawLabel — the same text is recorded once, from fillText.
    },
    measureText() {
      return { width: 10 } as TextMetrics;
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** A fake chart/series pair with a stable time/price → coordinate mapping. */
function makeTarget(rec: Recording) {
  const context = makeContext(rec);
  const target = {
    useMediaCoordinateSpace(cb: (arg: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void) {
      cb({ context, mediaSize: { width: 900, height: 500 } });
    },
  };
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (t: number) => 100 + (Number(t) % 700),
      options: () => ({ barSpacing: 10 }),
    }),
  };
  const series = {
    priceToCoordinate: (p: number) => 250 - p,
  };
  return { target, chart, series };
}

function assertMinimal(rec: Recording, label: string): void {
  for (const w of rec.shapeStrokeWidths) {
    assert.ok(w <= 1.5, `${label}: drew a ${w}px shape stroke (max 1.5)`);
  }
  for (const a of rec.fillAlphas) {
    assert.ok(a <= 0.12, `${label}: filled with alpha ${a} (max 0.12)`);
  }
  for (const t of rec.texts) {
    assert.ok(t.length <= 14, `${label}: drew the long label "${t}"`);
    for (const banned of ['ZONE DETECTED', 'PRICE APPROACHING', 'ENTRY CONFIRMED', 'NO TRADE']) {
      assert.ok(!t.includes(banned), `${label}: drew the long label "${t}"`);
    }
  }
}

const T = 1_700_000_000;

test('AnalysisChartPrimitive paints thin, subtle, short-labelled markup', () => {
  const rec: Recording = { shapeStrokeWidths: [], fillAlphas: [], texts: [] };
  const { target, chart, series } = makeTarget(rec);

  const overlays = {
    range: {
      valid: true,
      resistance: 120,
      support: 80,
      tradingArea: { lower: 110 },
      noTradeBand: { lower: 90 },
    },
    entryZone: { high: 118, low: 112 },
    supplyDemand: [
      { type: 'demand', upperPrice: 95, lowerPrice: 90, originTime: T, status: 'fresh' },
      { type: 'supply', upperPrice: 130, lowerPrice: 125, originTime: T + 100, status: 'invalidated' },
    ],
    trendlines: [
      { startTime: T, startPrice: 90, endTime: T + 500, slopePerSec: 0.00001, direction: 'bullish', broken: false },
    ],
    majorTrendlines: [
      {
        startTime: T,
        startPrice: 85,
        endTime: T + 800,
        slopePerSec: 0.00002,
        direction: 'bullish',
        thirdTouchConfirmed: true,
        anchors: [{ time: T, price: 85 }],
      },
    ],
    majorZones: [{ originTime: T, upperPrice: 100, lowerPrice: 98, role: 'support', freshness: 'FRESH' }],
    liquiditySweeps: [{ time: T + 200, sweepPrice: 88, type: 'BULLISH_SWEEP' }],
    swingPoints: [{ time: T + 300, price: 105, type: 'high', swingLabel: 'HH' }],
    patterns: [],
    breakoutRetest: {
      breakoutLevel: 102,
      breakoutTime: T + 400,
      direction: 'RISE',
      label: 'BREAKOUT',
      retestTime: T + 500,
      retestPrice: 101,
    },
  } as unknown as ChartOverlayData;

  const prim = new AnalysisChartPrimitive();
  prim.chart = chart as never;
  prim.series = series as never;
  prim.setOverlays(overlays, T + 900);

  const renderer = prim.paneViews()[0].renderer();
  assert.ok(renderer);
  renderer.draw(target as never);
  assert.ok(rec.texts.length > 0, 'expected some labels to be drawn');
  assertMinimal(rec, 'analysis');
});

test('StructureChartPrimitive paints thin bands, small BOS marker and short labels', () => {
  const rec: Recording = { shapeStrokeWidths: [], fillAlphas: [], texts: [] };
  const { target, chart, series } = makeTarget(rec);

  const prim = new StructureChartPrimitive();
  prim.chart = chart as never;
  prim.series = series as never;
  prim.setOverlay({
    precision: 2,
    bias: 'bullish',
    htfBias: 'bullish',
    htfTimeframe: 'H1',
    breaks: [{ time: T, brokenLevel: 100, direction: 'bullish', kind: 'BOS' }],
    srBands: [{ upperPrice: 105, lowerPrice: 103, type: 'resistance', status: 'active', importance: 'major' }],
    rejectionZones: [],
    fvg: [{ time: T, upperPrice: 99, lowerPrice: 98, reaction: 'RISE' }],
    watchZones: [
      {
        originTime: T,
        upperPrice: 96,
        lowerPrice: 94,
        direction: 'RISE',
        stage: 'PRICE_APPROACHING',
        invalidationLevel: 93,
      },
    ],
    testedZones: [],
    summary: '',
  } as never);

  const renderer = prim.paneViews()[0].renderer();
  assert.ok(renderer);
  renderer.draw(target as never);
  assert.ok(rec.texts.some((t) => t.includes('BOS')), 'expected a BOS label');
  assertMinimal(rec, 'structure');
});

test('DsChartPrimitive paints thin zones and short DZ/SZ/E/TP/SL labels', () => {
  const rec: Recording = { shapeStrokeWidths: [], fillAlphas: [], texts: [] };
  const { target, chart, series } = makeTarget(rec);

  const prim = new DsChartPrimitive();
  prim.chart = chart as never;
  prim.series = series as never;
  prim.setOverlay({
    precision: 2,
    zones: [
      {
        type: 'demand',
        upperPrice: 95,
        lowerPrice: 90,
        proximalPrice: 95,
        distalPrice: 90,
        state: 'FRESH',
        flipped: false,
      },
      {
        type: 'supply',
        upperPrice: 120,
        lowerPrice: 118,
        proximalPrice: 118,
        distalPrice: 120,
        state: 'TESTED',
        flipped: false,
      },
      // A fully mitigated, non-flipped zone must NOT be painted.
      {
        type: 'supply',
        upperPrice: 130,
        lowerPrice: 125,
        proximalPrice: 125,
        distalPrice: 130,
        state: 'FULLY_MITIGATED',
        flipped: false,
      },
    ],
    signal: {
      direction: 'RISE',
      entryPrice: 96,
      takeProfit1: 100,
      takeProfit2: 104,
      stopLoss: 93,
      confirmedBarTime: T,
    },
  } as never);

  const renderer = prim.paneViews()[0].renderer();
  assert.ok(renderer);
  renderer.draw(target as never);
  assert.ok(rec.texts.some((t) => t.startsWith('DZ')), 'expected a DZ label');
  // Only the live supply zone is drawn — the fully-mitigated one is skipped.
  assert.equal(rec.texts.filter((t) => t.startsWith('SZ')).length, 1, 'expected exactly one SZ label');
  assertMinimal(rec, 'ds');
});

test('AiChartPrimitive paints thin zones with short codes and level badges', () => {
  const rec: Recording = { shapeStrokeWidths: [], fillAlphas: [], texts: [] };
  const { target, chart, series } = makeTarget(rec);

  const prim = new AiChartPrimitive();
  prim.chart = chart as never;
  prim.series = series as never;
  prim.setOverlay({
    precision: 2,
    zones: [{ direction: 'RISE', upperPrice: 95, lowerPrice: 90, label: 'SUPPORT' }],
    watchZones: [{ direction: 'FALL', upperPrice: 130, lowerPrice: 128, label: 'BULLISH OB' }],
    signal: {
      direction: 'RISE',
      entryPrice: 96,
      takeProfit1: 100,
      takeProfit2: 104,
      takeProfit3: 108,
      stopLoss: 93,
      confirmedBarTime: T,
    },
  } as never);

  const renderer = prim.paneViews()[0].renderer();
  assert.ok(renderer);
  renderer.draw(target as never);
  assertMinimal(rec, 'ai');
});

test('TrendlineChartPrimitive paints thin setup zones and level badges', () => {
  const rec: Recording = { shapeStrokeWidths: [], fillAlphas: [], texts: [] };
  const { target, chart, series } = makeTarget(rec);

  const prim = new TrendlineChartPrimitive();
  prim.chart = chart as never;
  prim.series = series as never;
  prim.setOverlay({
    precision: 2,
    setupZones: [{ direction: 'RISE', upperPrice: 95, lowerPrice: 92 }],
    signal: {
      direction: 'RISE',
      entryPrice: 95,
      stopLoss: 91,
      takeProfit: 103,
      confirmedBarTime: T,
    },
  } as never);

  const renderer = prim.paneViews()[0].renderer();
  assert.ok(renderer);
  renderer.draw(target as never);
  assert.ok(rec.texts.some((t) => t.startsWith('ENTRY ')), 'expected an entry label');
  assertMinimal(rec, 'trendline');
});

test('SignalAnnotationPrimitive paints thin E/SL/TP lines and a small marker', () => {
  const rec: Recording = { shapeStrokeWidths: [], fillAlphas: [], texts: [] };
  const { target, chart, series } = makeTarget(rec);

  const prim = new SignalAnnotationPrimitive();
  prim.chart = chart as never;
  prim.series = series as never;
  prim.setLevels({
    direction: 'RISE',
    entry: 1.23456,
    stopLoss: 1.23,
    takeProfit: 1.24,
    entryTime: T,
    confirmationTime: T,
  });

  const renderer = prim.paneViews()[0].renderer();
  assert.ok(renderer);
  renderer.draw(target as never);
  assert.ok(rec.texts.some((t) => t.startsWith('ENTRY ')), 'expected an entry label');
  assertMinimal(rec, 'signal');
});
