import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type { StructureBreakEvent, SupportResistanceLevel, SupplyDemandZone } from '../types/analysis';
import type { TrendlineLine } from '../types/trendline';
import { evaluateTrendAlignment } from './trendAlignment';
import { buildTrendSetupZones, MAX_SETUP_ZONES } from './trendRejection';

const STEP = 900;

function candles(count: number, base = 100): Candle[] {
  const out: Candle[] = [];
  let t = 1_700_000_000;
  for (let i = 0; i < count; i++) {
    const p = base + i * 0.1;
    out.push({ time: t, open: p, high: p + 0.5, low: p - 0.5, close: p + 0.2, volume: 1 } as Candle);
    t += STEP;
  }
  return out;
}

function trendline(partial: Partial<TrendlineLine>): TrendlineLine {
  return {
    id: 'tl-1',
    kind: 'support',
    trend: 'ascending',
    startTime: 1_700_000_000,
    startPrice: 100,
    endTime: 1_700_007_200,
    endPrice: 102,
    slopePerSec: 2 / 7200,
    touches: 2,
    touchPoints: [],
    valid: true,
    invalidReason: '',
    broken: false,
    currentPrice: 102,
    reason: 'Rising support trendline.',
    ...partial,
  };
}

test('uptrend: HH/HL + bullish structure ⇒ RISE-only, trend confirmed', () => {
  const a = evaluateTrendAlignment({
    structureCandles: candles(30),
    structureDirection: 'BULLISH',
    structureSequence: { hh: true, hl: true, lh: false, ll: false },
    breaks: [],
    atr: 1,
    precision: 2,
  });
  assert.equal(a.dominantTrend, 'UPTREND');
  assert.equal(a.tradableDirection, 'RISE');
  assert.equal(a.trendConfirmed, true);
});

test('downtrend: LH/LL + bearish structure ⇒ FALL-only, trend confirmed', () => {
  const a = evaluateTrendAlignment({
    structureCandles: candles(30),
    structureDirection: 'BEARISH',
    structureSequence: { hh: false, hl: false, lh: true, ll: true },
    breaks: [],
    atr: 1,
    precision: 2,
  });
  assert.equal(a.dominantTrend, 'DOWNTREND');
  assert.equal(a.tradableDirection, 'FALL');
  assert.equal(a.trendConfirmed, true);
});

test('ranging structure ⇒ WAIT (no tradable direction)', () => {
  const a = evaluateTrendAlignment({
    structureCandles: candles(30),
    structureDirection: 'RANGING',
    structureSequence: { hh: false, hl: false, lh: false, ll: false },
    breaks: [],
    atr: 1,
    precision: 2,
  });
  assert.equal(a.dominantTrend, 'RANGING');
  assert.equal(a.tradableDirection, null);
  assert.equal(a.trendConfirmed, false);
  assert.match(a.reason, /WAIT/);
});

test('bullish bias without a clean HH/HL sequence ⇒ WAIT until structure confirms', () => {
  const a = evaluateTrendAlignment({
    structureCandles: candles(30),
    structureDirection: 'BULLISH',
    structureSequence: { hh: true, hl: false, lh: false, ll: false },
    breaks: [],
    atr: 1,
    precision: 2,
  });
  assert.equal(a.tradableDirection, null);
  assert.equal(a.trendConfirmed, false);
});

test('confirmed bullish reversal (fresh momentum CHOCH) flips a downtrend to RISE-only', () => {
  const structure = candles(30);
  const lastIndex = structure.length - 2; // breaks are evaluated on confirmed bars
  const choch: StructureBreakEvent = {
    id: 'choch-1',
    kind: 'CHOCH',
    direction: 'bullish',
    time: structure[lastIndex].time,
    index: lastIndex,
    price: 101,
    brokenLevel: 100.5,
    momentumConfirmed: true,
    reason: 'BULLISH CHOCH',
  };
  const a = evaluateTrendAlignment({
    structureCandles: structure,
    structureDirection: 'BEARISH',
    structureSequence: { hh: false, hl: false, lh: true, ll: true },
    breaks: [choch],
    atr: 1,
    precision: 2,
  });
  assert.equal(a.reversalConfirmed, true);
  assert.equal(a.tradableDirection, 'RISE');
  assert.equal(a.dominantTrend, 'UPTREND');
});

test('continuation BOS agreeing with the dominant trend is surfaced', () => {
  const structure = candles(30);
  const idx = structure.length - 3;
  const bos: StructureBreakEvent = {
    id: 'bos-1',
    kind: 'BOS',
    direction: 'bullish',
    time: structure[idx].time,
    index: idx,
    price: 103,
    brokenLevel: 102,
    momentumConfirmed: true,
    reason: 'BULLISH BOS',
  };
  const a = evaluateTrendAlignment({
    structureCandles: structure,
    structureDirection: 'BULLISH',
    structureSequence: { hh: true, hl: true, lh: false, ll: false },
    breaks: [bos],
    atr: 1,
    precision: 2,
  });
  assert.ok(a.continuationBos, 'expected a continuation BOS string');
  assert.match(a.continuationBos!, /BOS/);
});

test('setup zones: uptrend surfaces RISE zones BELOW price only', () => {
  const price = 100;
  const atr = 1;
  const support = trendline({ id: 's', kind: 'support', currentPrice: 98, startPrice: 97, endPrice: 98 });
  const resistance = trendline({ id: 'r', kind: 'resistance', currentPrice: 104, startPrice: 105, endPrice: 104 });
  const zones = buildTrendSetupZones({
    price,
    atr,
    precision: 2,
    alignment: {
      dominantTrend: 'UPTREND',
      structureLabel: 'HH/HL',
      tradableDirection: 'RISE',
      trendConfirmed: true,
      reversalConfirmed: false,
      reason: '',
      continuationBos: null,
    },
    trendlines: [support, resistance],
    supportResistance: [],
    supplyDemand: [],
    lastTime: 1_700_007_200,
  });
  assert.ok(zones.length >= 1);
  assert.ok(zones.every((z) => z.direction === 'RISE'), 'only RISE zones in an uptrend');
  assert.ok(zones.every((z) => z.projectedPrice <= price + atr), 'zones must sit at/below price');
});

test('setup zones: downtrend surfaces FALL zones ABOVE price only', () => {
  const price = 100;
  const atr = 1;
  const support = trendline({ id: 's', kind: 'support', currentPrice: 97, startPrice: 96, endPrice: 97 });
  const resistance = trendline({ id: 'r', kind: 'resistance', currentPrice: 103, startPrice: 104, endPrice: 103 });
  const zones = buildTrendSetupZones({
    price,
    atr,
    precision: 2,
    alignment: {
      dominantTrend: 'DOWNTREND',
      structureLabel: 'LH/LL',
      tradableDirection: 'FALL',
      trendConfirmed: true,
      reversalConfirmed: false,
      reason: '',
      continuationBos: null,
    },
    trendlines: [support, resistance],
    supportResistance: [],
    supplyDemand: [],
    lastTime: 1_700_007_200,
  });
  assert.ok(zones.length >= 1);
  assert.ok(zones.every((z) => z.direction === 'FALL'), 'only FALL zones in a downtrend');
  assert.ok(zones.every((z) => z.projectedPrice >= price - atr), 'zones must sit at/above price');
});

test('setup zones: WAIT (no tradable direction) yields no zones', () => {
  const zones = buildTrendSetupZones({
    price: 100,
    atr: 1,
    precision: 2,
    alignment: {
      dominantTrend: 'RANGING',
      structureLabel: 'range',
      tradableDirection: null,
      trendConfirmed: false,
      reversalConfirmed: false,
      reason: '',
      continuationBos: null,
    },
    trendlines: [trendline({ kind: 'support', currentPrice: 98 })],
    supportResistance: [],
    supplyDemand: [],
    lastTime: 1_700_007_200,
  });
  assert.equal(zones.length, 0);
});

test('setup zones: fresh untested demand/support rank ahead of well-worn levels and are capped', () => {
  const price = 100;
  const atr = 1;
  const levels: SupportResistanceLevel[] = [0, 1, 2, 3].map((i) => ({
    id: `sr-${i}`,
    price: 99 - i * 0.5,
    type: 'support',
    touches: i === 0 ? 1 : 5,
    firstTouchTime: 1,
    lastTouchTime: 2,
    status: 'active',
    importance: 'major',
    reason: `support ${i}`,
  }));
  const zones = buildTrendSetupZones({
    price,
    atr,
    precision: 2,
    alignment: {
      dominantTrend: 'UPTREND',
      structureLabel: 'HH/HL',
      tradableDirection: 'RISE',
      trendConfirmed: true,
      reversalConfirmed: false,
      reason: '',
      continuationBos: null,
    },
    trendlines: [],
    supportResistance: levels,
    supplyDemand: [],
    lastTime: 1_700_007_200,
  });
  assert.ok(zones.length <= MAX_SETUP_ZONES, 'zones are capped');
  assert.equal(zones[0].freshness, 'FRESH', 'the freshest zone ranks first');
});

test('setup zones: supply/demand zones on the trend side are included with freshness', () => {
  const demand: SupplyDemandZone = {
    id: 'd1',
    type: 'demand',
    upperPrice: 98.5,
    lowerPrice: 98,
    originTime: 1,
    originIndex: 1,
    status: 'fresh',
    touches: 0,
    displacementAtr: 2,
    reason: 'Fresh demand.',
  };
  const zones = buildTrendSetupZones({
    price: 100,
    atr: 1,
    precision: 2,
    alignment: {
      dominantTrend: 'UPTREND',
      structureLabel: 'HH/HL',
      tradableDirection: 'RISE',
      trendConfirmed: true,
      reversalConfirmed: false,
      reason: '',
      continuationBos: null,
    },
    trendlines: [],
    supportResistance: [],
    supplyDemand: [demand],
    lastTime: 1_700_007_200,
  });
  const demandZone = zones.find((z) => z.source === 'demand');
  assert.ok(demandZone, 'demand zone should be surfaced');
  assert.equal(demandZone!.freshness, 'FRESH');
  assert.equal(demandZone!.untested, true);
});
