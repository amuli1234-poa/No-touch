import type { ChartStructure } from '../engines/ChartStructureEngine';
import type { OpportunitySignal, ProtectedSwing, SupportResistanceZone, Trendline } from '../types/scanner';
import {
  buildOverlays,
  DEFAULT_OVERLAY_PREFERENCES,
  type OverlayPreferences,
  type OverlayShape
} from '../components/chart/chartOverlays';

/**
 * Tests for the chart overlay model.
 *
 * The overlay geometry is pure, so it can be asserted without a DOM. The
 * important behaviour is the gating: each overlay category must appear only
 * when its toggle is on and it is genuinely derived — never invented.
 */

console.log('🧪 Starting Chart Overlay Model Test Suite...\n');

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failCount++;
  }
}

function zone(over: Partial<SupportResistanceZone> = {}): SupportResistanceZone {
  return {
    id: 'z1',
    timeframe: '15m',
    type: 'DEMAND',
    strength: 'STRONG_DEMAND',
    upperPrice: 100,
    lowerPrice: 98,
    originEpoch: 1000,
    testCount: 1,
    fresh: true,
    broken: false,
    causedDisplacement: false,
    ...over
  };
}

function trendline(over: Partial<Trendline> = {}): Trendline {
  return {
    id: 't1',
    timeframe: '15m',
    direction: 'BULLISH',
    startEpoch: 1000,
    startPrice: 90,
    endEpoch: 2000,
    endPrice: 110,
    touches: 3,
    broken: false,
    retested: false,
    falseBreakout: false,
    slopePerSecond: 0.01,
    ...over
  };
}

function swing(over: Partial<ProtectedSwing> = {}): ProtectedSwing {
  return { type: 'HIGH', price: 120, epoch: 1500, label: 'PH', ...over };
}

function structure(over: Partial<ChartStructure> = {}): ChartStructure {
  return {
    trendLabel: 'Uptrend',
    marketCondition: 'UPTRENDING',
    protectedHigh: null,
    protectedLow: null,
    supportZones: [],
    resistanceZones: [],
    trendlines: [],
    confirmedPattern: null,
    ...over
  };
}

function opp(over: Partial<OpportunitySignal> = {}): OpportunitySignal {
  return {
    tradingRange: {
      timeframe: '15m',
      isValid: true,
      condition: 'UPTRENDING',
      rangeHigh: 130,
      rangeLow: 90,
      equilibrium: 110,
      premiumZone: [110, 130],
      discountZone: [90, 110],
      currentPosition: 'PREMIUM',
      breakoutState: 'BULLISH_BREAKOUT_RETEST',
      poisInsideRangeCount: 1,
      startEpoch: 1000,
      endEpoch: 2000
    },
    ...over
  } as OpportunitySignal;
}

const prefs = (over: Partial<OverlayPreferences> = {}): OverlayPreferences => ({
  ...DEFAULT_OVERLAY_PREFERENCES,
  ...over
});

const LAST = 5000;

/* 1. Toggles gate each category */
console.log('[1] Toggles gate categories');
{
  const s = structure({ supportZones: [zone()], trendlines: [trendline()], protectedHigh: swing() });

  const all = buildOverlays({ structure: s, preferences: prefs(), lastEpoch: LAST });
  assert(all.some((o) => o.kind === 'zone'), 'support zone drawn when enabled');
  assert(all.some((o) => o.kind === 'segment'), 'trendline drawn when enabled');
  assert(all.some((o) => o.kind === 'level' && o.tone === 'protectedHigh'), 'protected swing drawn when enabled');

  const noTrend = buildOverlays({
    structure: s,
    preferences: prefs({ showTrendlines: false }),
    lastEpoch: LAST
  });
  assert(!noTrend.some((o) => o.kind === 'segment'), 'trendlines hidden when disabled');

  const noSwings = buildOverlays({
    structure: s,
    preferences: prefs({ showProtectedSwings: false }),
    lastEpoch: LAST
  });
  assert(!noSwings.some((o) => o.tone === 'protectedHigh'), 'protected swings hidden when disabled');

  const noSr = buildOverlays({
    structure: s,
    preferences: prefs({ showSupportResistance: false }),
    lastEpoch: LAST
  });
  assert(!noSr.some((o) => o.kind === 'zone'), 'support zone hidden when S/R disabled');
}

/* 2. Supply/demand routing */
console.log('\n[2] Supply/demand routing');
{
  const sd = zone({ hasBaseFormation: true, causedDisplacement: true });
  const withSd = buildOverlays({
    structure: structure({ supportZones: [sd] }),
    preferences: prefs(),
    lastEpoch: LAST
  });
  const z = withSd.find((o) => o.kind === 'zone') as Extract<OverlayShape, { kind: 'zone' }>;
  assert(z?.tone === 'demand', 'base-formation support zone routed to demand tone');

  const noSd = buildOverlays({
    structure: structure({ supportZones: [sd] }),
    preferences: prefs({ showSupplyDemand: false }),
    lastEpoch: LAST
  });
  assert(noSd.length === 0, 'supply/demand zone removed when its toggle is off');

  const plain = zone({ hasBaseFormation: false, causedDisplacement: false });
  const kept = buildOverlays({
    structure: structure({ supportZones: [plain] }),
    preferences: prefs({ showSupplyDemand: false }),
    lastEpoch: LAST
  });
  assert(kept.length === 1, 'plain S/R zone survives when only supply/demand is off');
}

/* 3. Flip zones always shown with S/R */
console.log('\n[3] Flip zones');
{
  const flip = zone({ isFlip: true, flipType: 'R_TO_S' });
  const shapes = buildOverlays({
    structure: structure({ supportZones: [flip] }),
    preferences: prefs(),
    lastEpoch: LAST
  });
  const z = shapes.find((o) => o.kind === 'zone') as Extract<OverlayShape, { kind: 'zone' }>;
  assert(z?.tone === 'flipSupport', 'flip support gets its own tone');
  assert(z?.midline === true, 'flip zone draws a midline');
}

/* 4. Zones extend to the right edge */
console.log('\n[4] Zone extent');
{
  const shapes = buildOverlays({
    structure: structure({ supportZones: [zone({ originEpoch: 1000 })] }),
    preferences: prefs(),
    lastEpoch: LAST
  });
  const z = shapes[0] as Extract<OverlayShape, { kind: 'zone' }>;
  assert(z.to === LAST, 'zone extends to the last visible epoch');
  assert(z.from === 1000, 'zone starts at its origin epoch');
}

/* 5. Breakout level only when the range has broken */
console.log('\n[5] Breakout level');
{
  const inside = buildOverlays({
    structure: structure(),
    opportunity: opp({ tradingRange: { ...opp().tradingRange, breakoutState: 'INSIDE_RANGE' } }),
    preferences: prefs(),
    lastEpoch: LAST
  });
  assert(!inside.some((o) => o.tone === 'breakout'), 'no breakout level while inside range');

  const broken = buildOverlays({
    structure: structure(),
    opportunity: opp(),
    preferences: prefs(),
    lastEpoch: LAST
  });
  const b = broken.find((o) => o.tone === 'breakout') as Extract<OverlayShape, { kind: 'level' }>;
  assert(b?.price === 130, 'bullish breakout uses the range high');

  const disabled = buildOverlays({
    structure: structure(),
    opportunity: opp(),
    preferences: prefs({ showBreakoutLevels: false }),
    lastEpoch: LAST
  });
  assert(!disabled.some((o) => o.tone === 'breakout'), 'breakout hidden when disabled');

  const noOpp = buildOverlays({ structure: structure(), preferences: prefs(), lastEpoch: LAST });
  assert(!noOpp.some((o) => o.tone === 'breakout'), 'no breakout without an opportunity');
}

/* 6. Trendline direction maps to tone */
console.log('\n[6] Trendline tones');
{
  const bull = buildOverlays({
    structure: structure({ trendlines: [trendline({ direction: 'BULLISH' })] }),
    preferences: prefs(),
    lastEpoch: LAST
  })[0] as Extract<OverlayShape, { kind: 'segment' }>;
  assert(bull.tone === 'trendBull', 'bullish trendline tone');

  const bear = buildOverlays({
    structure: structure({ trendlines: [trendline({ direction: 'BEARISH' })] }),
    preferences: prefs(),
    lastEpoch: LAST
  })[0] as Extract<OverlayShape, { kind: 'segment' }>;
  assert(bear.tone === 'trendBear', 'bearish trendline tone');

  const broke = buildOverlays({
    structure: structure({ trendlines: [trendline({ event: 'BREAKOUT' })] }),
    preferences: prefs(),
    lastEpoch: LAST
  })[0] as Extract<OverlayShape, { kind: 'segment' }>;
  assert(broke.dashed === true, 'breakout trendline is dashed');
}

/* 7. Chart patterns */
console.log('\n[7] Chart patterns');
{
  const pattern = {
    id: 'p1',
    type: 'DOUBLE_TOP' as const,
    label: 'Double Top',
    timeframe: '15m' as const,
    direction: 'BEARISH' as const,
    status: 'CONFIRMED_BREAKOUT' as const,
    confirmedByClose: true,
    necklineOrBreakLevel: 100,
    targetPrice: 90,
    invalidationPrice: 105,
    detectedEpoch: 1500,
    description: 'x',
    points: [],
    lines: [
      { startEpoch: 1000, startPrice: 100, endEpoch: 2000, endPrice: 100, kind: 'NECKLINE' as const },
      { startEpoch: 1000, startPrice: 105, endEpoch: 1200, endPrice: 105, kind: 'BOUNDARY' as const }
    ]
  };
  const shapes = buildOverlays({
    structure: structure({ confirmedPattern: pattern }),
    preferences: prefs(),
    lastEpoch: LAST
  });
  const segs = shapes.filter((o) => o.kind === 'segment') as Extract<OverlayShape, { kind: 'segment' }>[];
  assert(segs.length === 2, 'both pattern lines drawn');
  assert(segs.some((s) => s.tone === 'patternNeckline' && s.dashed), 'neckline dashed');
  assert(segs.some((s) => s.tone === 'patternBoundary'), 'boundary tone');

  const off = buildOverlays({
    structure: structure({ confirmedPattern: pattern }),
    preferences: prefs({ showChartPatterns: false }),
    lastEpoch: LAST
  });
  assert(off.length === 0, 'patterns hidden when disabled');
}

/* 8. Empty structure draws nothing */
console.log('\n[8] Empty structure');
{
  const shapes = buildOverlays({ structure: structure(), preferences: prefs(), lastEpoch: LAST });
  assert(shapes.length === 0, 'no overlays invented from empty structure');
}

/* 9. Protected swing levels carry a dot and reach the right edge */
console.log('\n[9] Protected swing geometry');
{
  const shapes = buildOverlays({
    structure: structure({ protectedLow: swing({ type: 'LOW', price: 80, epoch: 1200 }) }),
    preferences: prefs(),
    lastEpoch: LAST
  });
  const lvl = shapes[0] as Extract<OverlayShape, { kind: 'level' }>;
  assert(lvl.tone === 'protectedLow', 'low swing tone');
  assert(lvl.dotEpoch === 1200, 'swing origin marked with a dot');
  assert(lvl.to === LAST, 'swing level extends to the right edge');
  assert(lvl.dashed === true, 'swing level dashed');
}

console.log(`\n${'='.repeat(52)}`);
console.log(`Chart overlay tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error('❌ Chart overlay test suite FAILED');
  process.exit(1);
}
console.log('✅ Chart overlay test suite PASSED');
