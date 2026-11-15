import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type { FutureReactionZone } from '../types/structure';
import {
  analyzeMultiTimeframeStructure,
  analyzeStructure,
  detectFairValueGaps,
  evaluateFreshness,
  evaluateZoneState,
  markZoneEntryConfirmed,
} from './structureEngine';

function mk(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const STEP = 900;
const T0 = 1_700_000_000;

/** Walks a series to each target price, producing real swing pivots at the turns. */
function walk(legs: number[], start = 100, pad = 0.25, stepsPerLeg = 4): Candle[] {
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

// ---------------------------------------------------------------------------
// 1. Genuine BOS versus wick-only sweeps
// ---------------------------------------------------------------------------

test('valid BOS requires a body close beyond the protected swing high', () => {
  const base = walk([104, 102, 106, 104, 108, 106, 110, 108]);
  const tBreak = base[base.length - 1].time + STEP;
  const tAfter = tBreak + STEP;
  const series = [
    ...base,
    mk(tBreak, 108, 112.2, 107.9, 112), // decisive bullish body close above the 110.25 high
    mk(tAfter, 112, 112.4, 111.6, 112.1),
  ];

  const result = analyzeStructure({ candles: series, timeframe: 'M15', precision: 2 });
  const bos = result.breaks
    .filter((b) => b.direction === 'bullish' && b.kind === 'BOS')
    .at(-1);
  assert.ok(bos, 'expected a bullish BOS');
  assert.ok(
    bos!.brokenLevel > 110 && bos!.brokenLevel < 111,
    `broke the 110-ish protected high (got ${bos!.brokenLevel})`
  );
  assert.ok(bos!.displacementAtr >= 0.2, 'has meaningful displacement');
  assert.equal(result.bias, 'bullish');
});

test('a wick-only breach is a sweep, never a break of structure', () => {
  const base = walk([100, 108, 100, 108, 100, 108, 100, 108]);
  const tSweep = base[base.length - 1].time + STEP;
  const tAfter = tSweep + STEP;
  const series = [
    ...base,
    // Pokes above the ~108.25 ceiling with a long upper wick but closes back inside.
    mk(tSweep, 108, 109.6, 107.6, 107.8),
    mk(tAfter, 107.8, 108.1, 107.4, 107.6),
  ];

  const result = analyzeStructure({ candles: series, timeframe: 'M15', precision: 2 });
  assert.equal(
    result.breaks.filter((b) => b.direction === 'bullish').length,
    0,
    'wick-only breach must not register as a bullish break'
  );
  assert.ok(result.rejectedSweeps.length >= 1, 'the wick breach is recorded as a rejected sweep');
});

// ---------------------------------------------------------------------------
// 2. Swing-based trendline accuracy
// ---------------------------------------------------------------------------

test('only valid swing-anchored trendlines are exposed (invalid lines removed)', () => {
  const uptrend = walk([104, 102, 106, 104, 108, 106, 110, 108, 112, 110]);
  const result = analyzeStructure({ candles: uptrend, timeframe: 'M15', precision: 2 });
  assert.ok(result.trendlines.length >= 1, 'an ascending support trendline is detected');
  assert.ok(
    result.trendlines.every((l) => l.valid),
    'invalidated trendlines are removed from the active chart'
  );
  const support = result.trendlines.find((l) => l.kind === 'support');
  assert.ok(support && support.touches >= 2, 'support line has at least two swing anchors');
});

// ---------------------------------------------------------------------------
// 3. Rejection zone detection
// ---------------------------------------------------------------------------

test('rejection zones need repeated reactions and wick rejection, not a lone wick', () => {
  // Three swing highs clustered near 110, each rejected by a wick back down.
  const series: Candle[] = [];
  let t = T0;
  const push = (c: Candle) => {
    series.push(c);
    t += STEP;
  };
  // Warm-up so confirmed history clears the engine's 30-bar minimum.
  for (let i = 0; i < 12; i++) {
    const o = 100 + Math.sin(i) * 0.5;
    push(mk(t, o, o + 0.4, o - 0.4, o + 0.1));
  }
  for (let cycle = 0; cycle < 3; cycle++) {
    // rise into the 110 band
    for (let i = 0; i < 3; i++) {
      const o = 105 + i;
      push(mk(t, o, o + 0.4, o - 0.2, o + 0.8));
    }
    push(mk(t, 109.4, 110.5, 109.0, 109.2)); // wick pokes to 110.5, closes back down
    push(mk(t, 109.2, 109.4, 107.6, 107.8)); // strong bearish displacement
    for (let i = 0; i < 2; i++) {
      const o = 106 - i;
      push(mk(t, o, o + 0.2, o - 0.4, o - 0.6));
    }
  }
  for (let i = 0; i < 4; i++) push(mk(t, 102, 102.3, 101.6, 102));

  const result = analyzeStructure({ candles: series, timeframe: 'M15', precision: 2 });
  assert.ok(result.rejectionZones.length >= 1, 'a rejection band is detected');
  const zone = result.rejectionZones[0];
  assert.ok(zone.upperPrice > zone.lowerPrice, 'zone has real band boundaries');
  assert.ok(zone.wickRejections >= 1 && zone.touches >= 2, 'multiple reactions + wick rejection');
  assert.ok(zone.displacementAtr >= 0.4, 'has real displacement away from the level');
});

// ---------------------------------------------------------------------------
// 4. Support / resistance validation
// ---------------------------------------------------------------------------

test('support/resistance are bands built from repeated reactions; single swings are ignored', () => {
  const base = walk([100, 108, 100, 108, 100, 108, 100, 104]);
  const result = analyzeStructure({ candles: base, timeframe: 'M15', precision: 2 });
  for (const band of result.srBands) {
    assert.ok(band.upperPrice > band.lowerPrice, 'S/R is a band, not a single line');
    assert.ok(band.touches >= 2, 'requires multiple confirmed reactions');
  }
  assert.ok(result.srBands.length >= 1, 'the repeated ceiling is surfaced as a band');
});

// ---------------------------------------------------------------------------
// 5. Breakout reaction-zone identification
// ---------------------------------------------------------------------------

test('a broken resistance is reclassified as a fresh RISE watch zone', () => {
  const base = walk([104, 102, 106, 104, 108, 106, 110, 108]);
  const tBreak = base[base.length - 1].time + STEP;
  const series = [
    ...base,
    mk(tBreak, 108, 112.2, 107.9, 112),
    mk(tBreak + STEP, 112, 112.3, 111.7, 112.1),
  ];

  const result = analyzeStructure({ candles: series, timeframe: 'M15', precision: 2 });
  const riseZone = result.activeWatch.find((z) => z.direction === 'RISE');
  assert.ok(riseZone, 'a RISE watch zone is projected from the breakout');
  assert.match(riseZone!.sourceStructure, /Broken resistance/i);
  assert.match(riseZone!.sourceStructure, /potential support/i);
  assert.ok(riseZone!.upperPrice > riseZone!.lowerPrice);
});

// ---------------------------------------------------------------------------
// 6. Freshness and mitigation logic
// ---------------------------------------------------------------------------

test('freshness distinguishes wick touch, partial penetration and full mitigation', () => {
  const zone = { direction: 'RISE' as const, upperPrice: 105, lowerPrice: 103, fromIndex: 0 };
  const atr = 1;

  const untouched = [mk(1, 110, 111, 109, 110)];
  assert.equal(evaluateFreshness(zone, untouched, atr), 'FRESH');

  const wickOnly = [mk(1, 106, 106.2, 102.5, 106)]; // wick into band, body above
  assert.equal(evaluateFreshness(zone, wickOnly, atr), 'PROBED');

  const partial = [mk(1, 106, 106, 104, 104)]; // body closes inside the band
  assert.equal(evaluateFreshness(zone, partial, atr), 'PARTIALLY_TESTED');

  const mitigated = [mk(1, 102.9, 103, 102, 102.5)]; // body closed entirely through the far boundary
  assert.equal(evaluateFreshness(zone, mitigated, atr), 'MITIGATED');

  const invalidated = [mk(1, 104, 104, 101.5, 101.6)]; // decisive close beyond invalidation
  assert.equal(evaluateFreshness(zone, invalidated, atr), 'INVALIDATED');
});

// ---------------------------------------------------------------------------
// 7. Three-stage setup progression + 9. automatic invalidation
// ---------------------------------------------------------------------------

function zone(overrides: Partial<FutureReactionZone> = {}): FutureReactionZone {
  return {
    id: 'z',
    direction: 'RISE',
    kind: 'support',
    upperPrice: 103.3,
    lowerPrice: 102.7,
    originTime: T0,
    originTimeframe: 'M15',
    sourceStructure: 'test',
    freshness: 'FRESH',
    stage: 'ZONE_DETECTED',
    invalidationLevel: 102,
    invalidationCondition: 'x',
    reactions: 2,
    distanceAtr: 0,
    approachProgress: 0,
    reason: 'test',
    evidence: [],
    ...overrides,
  };
}

test('a zone far from price stays at stage 1 (ZONE_DETECTED)', () => {
  const candles = [mk(T0, 100, 100.2, 99.8, 100), mk(T0 + STEP, 110, 110.2, 109.8, 110)];
  const state = evaluateZoneState(zone(), candles, 1);
  assert.equal(state.stage, 'ZONE_DETECTED');
});

test('a zone price is approaching advances to stage 2 (PRICE_APPROACHING)', () => {
  const candles = [mk(T0, 100, 100.2, 99.8, 100), mk(T0 + STEP, 104, 104.2, 103.9, 104)];
  const state = evaluateZoneState(zone(), candles, 1);
  assert.equal(state.stage, 'PRICE_APPROACHING');
});

test('a zone whose price is consumed becomes FAILED (mitigated)', () => {
  // Body closes entirely through the far (lower) boundary but not decisively beyond
  // invalidation — full mitigation without invalidation.
  const candles = [
    mk(T0, 100, 100.2, 99.8, 100),
    mk(T0 + STEP, 102.6, 102.65, 102.0, 102.5),
  ];
  const state = evaluateZoneState(zone(), candles, 1);
  assert.equal(state.freshness, 'MITIGATED');
  assert.equal(state.stage, 'FAILED');
});

test('a zone whose invalidation is hit is automatically INVALIDATED', () => {
  const candles = [mk(T0, 100, 100.2, 99.8, 100), mk(T0 + STEP, 101, 101, 99, 99.5)];
  const state = evaluateZoneState(zone(), candles, 1);
  assert.equal(state.stage, 'INVALIDATED');
});

// ---------------------------------------------------------------------------
// 8. Entry confirmation (three-stage contract) — zone retains stage until confirmed
// ---------------------------------------------------------------------------

test('the structure engine never publishes an ENTRY_CONFIRMED stage on its own', () => {
  const base = walk([104, 102, 106, 104, 108, 106, 110, 108]);
  const series = [
    ...base,
    mk(base[base.length - 1].time + STEP, 108, 112.2, 107.9, 112),
    mk(base[base.length - 1].time + 2 * STEP, 112, 112.3, 111.7, 112.1),
  ];
  const result = analyzeStructure({ candles: series, timeframe: 'M15', precision: 2 });
  assert.ok(
    result.watchZones.every((z) => z.stage !== 'ENTRY_CONFIRMED'),
    'ENTRY_CONFIRMED is set only by the integration layer on a quality-gated signal'
  );
});

// ---------------------------------------------------------------------------
// 10. Synchronisation with the live scanner / multi-timeframe
// ---------------------------------------------------------------------------

test('multi-timeframe analysis preserves each zone origin timeframe and dedupes', () => {
  const active = walk([104, 102, 106, 104, 108, 106, 110, 108]);
  const series = [
    ...active,
    mk(active[active.length - 1].time + STEP, 108, 112.2, 107.9, 112),
    mk(active[active.length - 1].time + 2 * STEP, 112, 112.3, 111.7, 112.1),
  ];
  const htf = walk([100, 108, 100, 108, 100, 108, 100, 108]);

  const result = analyzeMultiTimeframeStructure({
    activeTimeframe: 'M5',
    candlesByTimeframe: { M5: series, M15: htf },
    htfTimeframe: 'M15',
    precision: 2,
  });

  assert.equal(result.activeTimeframe, 'M5');
  assert.ok(
    result.mergedWatchZones.every((z) => z.originTimeframe === 'M5'),
    'zones keep the timeframe they originated on'
  );
  const keys = result.mergedWatchZones.map(
    (z) => `${z.direction}-${Math.round(((z.upperPrice + z.lowerPrice) / 2) * 1e4)}`
  );
  assert.equal(new Set(keys).size, keys.length, 'no duplicate zones across timeframes');
});

// ---------------------------------------------------------------------------
// 11. Integration: entry confirmation and tested-zone separation
// ---------------------------------------------------------------------------

test('a published signal promotes a matching zone to ENTRY_CONFIRMED', () => {
  const zones = [zone({ id: 'a', direction: 'RISE', upperPrice: 101, lowerPrice: 99 })];
  const promoted = markZoneEntryConfirmed(zones, { direction: 'RISE', entryPrice: 100, atr: 1 });
  assert.equal(promoted[0].stage, 'ENTRY_CONFIRMED');
});

test('a signal does not promote a zone of the opposite direction or a distant zone', () => {
  const zones = [
    zone({ id: 'dir', direction: 'FALL', upperPrice: 101, lowerPrice: 99 }),
    zone({ id: 'far', direction: 'RISE', upperPrice: 121, lowerPrice: 119 }),
  ];
  const promoted = markZoneEntryConfirmed(zones, { direction: 'RISE', entryPrice: 100, atr: 1 });
  assert.equal(promoted.find((z) => z.id === 'dir')!.stage, 'ZONE_DETECTED');
  assert.equal(promoted.find((z) => z.id === 'far')!.stage, 'ZONE_DETECTED');
});

test('an already failed or invalidated zone is never promoted by a signal', () => {
  const zones = [zone({ id: 'dead', stage: 'INVALIDATED', direction: 'RISE' })];
  const promoted = markZoneEntryConfirmed(zones, { direction: 'RISE', entryPrice: 100, atr: 1 });
  assert.equal(promoted[0].stage, 'INVALIDATED');
});

test('the engine separates fresh (active) watch zones from tested/mitigated ones', () => {
  const base = walk([104, 102, 106, 104, 108, 106, 110, 108]);
  const series = [
    ...base,
    mk(base[base.length - 1].time + STEP, 108, 112.2, 107.9, 112),
    mk(base[base.length - 1].time + 2 * STEP, 112, 112.3, 111.7, 112.1),
  ];
  const result = analyzeStructure({ candles: series, timeframe: 'M15', precision: 2 });
  const activeIds = new Set(result.activeWatch.map((z) => z.id));
  for (const z of result.testedWatch) {
    assert.ok(!activeIds.has(z.id), 'a zone is either active or tested, never both');
    assert.ok(
      z.freshness === 'MITIGATED' || z.freshness === 'INVALIDATED' || z.stage === 'FAILED',
      'tested zones are mitigated, invalidated or failed'
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Fair value gaps (imbalances)
// ---------------------------------------------------------------------------

test('a bullish FVG is detected from a three-candle imbalance and exposed on the result', () => {
  const series: Candle[] = [];
  let t = T0;
  // Quiet warm-up so the 20-bar minimum is cleared.
  for (let i = 0; i < 35; i++) {
    series.push(mk(t, 100, 100.4, 99.6, 100.1));
    t += STEP;
  }
  // Displacement candle leaves a gap: prev high 100.4 < next low 104.
  series.push(mk(t, 100.1, 100.5, 100, 103));
  t += STEP;
  series.push(mk(t, 103, 106, 104, 105.5));
  t += STEP;
  series.push(mk(t, 105.5, 105.8, 105.2, 105.4));
  // Trailing candle: analyzeStructure drops the forming bar, so keep the gap confirmed.
  t += STEP;
  series.push(mk(t, 105.4, 105.7, 105.1, 105.5));

  const result = analyzeStructure({ candles: series, timeframe: 'M15', precision: 2 });
  assert.ok(result.fvg.length >= 1, 'a fresh bullish FVG is exposed');
  const gap = result.fvg.find((g) => g.direction === 'bullish');
  assert.ok(gap, 'the gap is classified bullish');
  assert.ok(gap!.upperPrice > gap!.lowerPrice, 'the gap has positive height');
  assert.equal(gap!.freshness, 'FRESH');
  assert.equal(gap!.reaction, 'RISE');
});

test('a filled (mitigated) fair value gap is removed by the detector', () => {
  const series: Candle[] = [];
  let t = T0;
  for (let i = 0; i < 20; i++) {
    series.push(mk(t, 100, 100.4, 99.6, 100.1));
    t += STEP;
  }
  series.push(mk(t, 100.1, 100.5, 100, 103));
  t += STEP;
  series.push(mk(t, 103, 106, 104, 105.5));
  t += STEP;
  // Price trades all the way back through the gap (low <= prev high 100.5) → filled.
  series.push(mk(t, 105.4, 105.5, 99.8, 100.2));

  const gaps = detectFairValueGaps(series, 1, 2);
  assert.equal(
    gaps.filter((g) => g.direction === 'bullish').length,
    0,
    'the filled gap is not returned'
  );
});

test('a sliver imbalance below the minimum ATR size is ignored', () => {
  const series: Candle[] = [];
  let t = T0;
  for (let i = 0; i < 20; i++) {
    series.push(mk(t, 100, 100.4, 99.6, 100.1));
    t += STEP;
  }
  // Gap height 0.05 with ATR≈1 → below the 0.12×ATR floor.
  series.push(mk(t, 100.1, 100.42, 100, 100.3));
  t += STEP;
  series.push(mk(t, 100.3, 100.45, 100.05, 100.4));
  t += STEP;
  series.push(mk(t, 100.4, 100.5, 100.2, 100.45));

  const gaps = detectFairValueGaps(series, 1, 2);
  assert.equal(gaps.length, 0, 'no sub-threshold sliver gaps are returned');
});
