import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type {
  DsInstrumentAnalysis,
  DsSignal,
  DsZone,
} from '../types/demandSupply';
import { DS_STATUS_LABELS } from '../types/demandSupply';
import { computeAtrSeries } from './swings';
import { detectDsZones, type RawDsZone } from './demandSupplyDetection';
import {
  applyFlips,
  scoreDsZone,
  trackDsZones,
  zoneInPlay,
} from './demandSupplyZones';
import {
  detectDsCandidate,
  detectDsRejection,
  isDsPublishable,
  type DsModelContext,
} from './demandSupplyModels';
import {
  analyzeDsInstrument,
  dsSignalStatus,
  selectStrongestDs,
} from './demandSupplyEngine';

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

function atrOf(candles: readonly Candle[]): number {
  const s = computeAtrSeries(candles, 14);
  return s[s.length - 1] || 1e-6;
}

const M15_STEP = 900;
const M5_STEP = 300;
const M1_STEP = 60;

/** 24 gentle descending candles ending near 104 — establishes a bearish leg + a stable ATR. */
function descendingPrefix(startTime: number, step: number, count = 24): Candle[] {
  const out: Candle[] = [];
  let price = 108;
  for (let i = 0; i < count; i++) {
    const o = price;
    const c = price - 0.2;
    out.push(candle(startTime + i * step, o, o + 0.1, c - 0.1, c));
    price = c;
  }
  return out;
}

/**
 * A clean Drop-Base-Rally demand structure on M15: a compact base (103.8–104.0) followed by
 * two strong bullish displacement candles, then a slow continuation higher.
 */
function dbrStructure(startTime = 1_700_000_000, step = M15_STEP): Candle[] {
  const prefix = descendingPrefix(startTime, step);
  const t = startTime + prefix.length * step;
  const base = candle(t, 103.8, 104.0, 103.75, 103.9);
  const out1 = candle(t + step, 103.9, 105.1, 103.85, 105.0);
  const out2 = candle(t + 2 * step, 105.0, 106.3, 104.9, 106.2);
  const tail: Candle[] = [];
  let price = 106.2;
  for (let i = 0; i < 8; i++) {
    const c = price + 0.1;
    tail.push(candle(t + (3 + i) * step, price, c + 0.1, price - 0.1, c));
    price = c;
  }
  return [...prefix, base, out1, out2, ...tail];
}

/** M5 candles settling flat at the zone proximal edge (104.3). */
function setupAtZone(startTime = 1_700_000_000, step = M5_STEP, count = 8): Candle[] {
  const out: Candle[] = [];
  const closes = [104.1, 104.2, 104.25, 104.3, 104.28, 104.3, 104.3, 104.3];
  for (let i = 0; i < count; i++) {
    const c = closes[i % closes.length];
    const o = i === count - 2 ? 104.2 : c - 0.05;
    out.push(candle(startTime + i * step, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.1, c));
  }
  // Last confirmed bar (index count-2) is a bullish push out of the zone.
  out[count - 2] = candle(startTime + (count - 2) * step, 104.2, 104.45, 104.2, 104.4);
  return out;
}

/** M1 candles ending with a confirmed bullish rejection (hammer) at the zone proximal edge. */
function m1BullishRejection(startTime = 1_700_000_000, step = M1_STEP): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(candle(startTime + i * step, 104.2, 104.25, 104.1, 104.15));
  }
  out.push(candle(startTime + 5 * step, 104.35, 104.55, 103.95, 104.5)); // hammer
  out.push(candle(startTime + 6 * step, 104.5, 104.55, 104.45, 104.52)); // forming bar
  return out;
}

/** M1 candles ending with a confirmed bearish rejection at a supply zone's proximal edge. */
function m1BearishRejection(boundary: number, startTime = 1_700_000_000, step = M1_STEP): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(candle(startTime + i * step, boundary - 0.1, boundary - 0.05, boundary - 0.2, boundary - 0.15));
  }
  // Shooting-star: wick above the boundary, closes back below it.
  out.push(candle(startTime + 5 * step, boundary - 0.1, boundary + 0.35, boundary - 0.15, boundary - 0.2));
  out.push(candle(startTime + 6 * step, boundary - 0.2, boundary - 0.15, boundary - 0.25, boundary - 0.18));
  return out;
}

function makeZone(overrides: Partial<DsZone> = {}): DsZone {
  const base: DsZone = {
    id: 'demand-DBR-1',
    type: 'demand',
    formation: 'DBR',
    formationLabel: 'Drop-Base-Rally',
    state: 'FRESH',
    proximalPrice: 104.3,
    distalPrice: 103.8,
    upperPrice: 104.3,
    lowerPrice: 103.8,
    originTime: 1_700_000_000,
    originIndex: 20,
    displacementAtr: 4,
    touches: 0,
    untested: true,
    causedBos: false,
    origins: ['DISPLACEMENT'],
    hasFvgConfluence: false,
    fvg: null,
    flipped: false,
    distanceAtr: 0.1,
    isFutureWatch: false,
    lifecycle: {
      formedTime: 1_700_000_000,
      formedIndex: 20,
      firstTestTime: null,
      distalReachedTime: null,
      invalidatedTime: null,
    },
    score: {
      formationQuality: 22,
      displacement: 20,
      freshness: 20,
      bosOrigin: 6,
      fvgConfluence: 5,
      htfAlignment: 10,
      roomToTarget: 7,
      total: 90,
    },
    reason: 'Drop-Base-Rally DEMAND ZONE test fixture.',
  };
  return { ...base, ...overrides };
}

function buildContext(zone: DsZone, entryCandles?: Candle[]): DsModelContext {
  const structure = dbrStructure();
  const setup = setupAtZone();
  const entry = entryCandles ?? m1BullishRejection();
  return {
    symbol: 'R_100',
    precision: 2,
    zones: [zone],
    structureCandles: structure,
    setupCandles: setup,
    entryCandles: entry,
    structureAtr: atrOf(structure),
    setupAtr: atrOf(setup),
    entryAtr: atrOf(entry),
    structureSwings: [],
  };
}

function makeRawZone(overrides: Partial<RawDsZone> = {}): RawDsZone {
  return {
    id: 'demand-DBR-x',
    type: 'demand',
    formation: 'DBR',
    formationLabel: 'Drop-Base-Rally',
    upperPrice: 104.0,
    lowerPrice: 103.75,
    originTime: 1_700_000_000,
    originIndex: 20,
    displacementAtr: 4,
    establishedIndex: 22,
    causedBos: false,
    hasFvgConfluence: false,
    fvg: null,
    baseTightness: 0.5,
    ...overrides,
  };
}

/** Prefix + base + 2 displacement candles; interaction candles follow from index 23. */
function zoneCandleSeries(interaction: Candle[]): Candle[] {
  const prefix = descendingPrefix(1_700_000_000, M15_STEP, 20);
  const t = 1_700_000_000 + prefix.length * M15_STEP;
  const base = candle(t, 103.8, 104.0, 103.75, 103.9);
  const out1 = candle(t + M15_STEP, 103.9, 105.1, 103.85, 105.0);
  const out2 = candle(t + 2 * M15_STEP, 105.0, 106.3, 104.9, 106.2);
  const start = 1_700_000_000 + 23 * M15_STEP;
  const rest = interaction.map((c, i) => ({ ...c, time: start + i * M15_STEP }));
  return [...prefix, base, out1, out2, ...rest];
}

test('detectDsZones finds a Drop-Base-Rally demand zone with strong displacement', () => {
  const structure = dbrStructure();
  const zones = detectDsZones({
    structureCandles: structure,
    refinementCandles: [],
    structureAtr: atrOf(structure),
    precision: 2,
    swings: [],
    breaks: [],
    fvgs: [],
  });
  const demand = zones.find((z) => z.type === 'demand');
  assert.ok(demand, 'expected a demand zone');
  assert.equal(demand!.formation, 'DBR');
  assert.ok(demand!.displacementAtr >= 1.2, 'displacement must clear the minimum');
  assert.ok(demand!.upperPrice > demand!.lowerPrice);
});

test('detectDsZones rejects a compact consolidation with no displacement', () => {
  const flat: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    flat.push(candle(1_700_000_000 + i * M15_STEP, 100, 100.1, 99.9, 100.02));
  }
  const zones = detectDsZones({
    structureCandles: flat,
    refinementCandles: [],
    structureAtr: atrOf(flat),
    precision: 2,
    swings: [],
    breaks: [],
    fvgs: [],
  });
  assert.equal(zones.length, 0);
});

test('trackDsZones keeps a fresh zone FRESH', () => {
  const candles = zoneCandleSeries([]);
  const tracked = trackDsZones({ raw: [makeRawZone()], candles, atr: atrOf(candles), precision: 2 });
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].state, 'FRESH');
  assert.equal(tracked[0].untested, true);
});

test('trackDsZones progresses FRESH → TESTED on a shallow touch', () => {
  const candles = zoneCandleSeries([candle(0, 104.1, 104.15, 103.9, 104.0)]);
  const tracked = trackDsZones({ raw: [makeRawZone()], candles, atr: atrOf(candles), precision: 2 });
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].state, 'TESTED');
  assert.equal(tracked[0].touches, 1);
});

test('trackDsZones marks PARTIALLY_MITIGATED when price reaches the zone body', () => {
  const candles = zoneCandleSeries([candle(0, 104.1, 104.15, 103.86, 103.9)]);
  const tracked = trackDsZones({ raw: [makeRawZone()], candles, atr: atrOf(candles), precision: 2 });
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].state, 'PARTIALLY_MITIGATED');
});

test('trackDsZones drops a zone once it is fully mitigated (distal edge reached)', () => {
  const candles = zoneCandleSeries([candle(0, 104.1, 104.15, 103.75, 103.9)]);
  const tracked = trackDsZones({ raw: [makeRawZone()], candles, atr: atrOf(candles), precision: 2 });
  assert.equal(tracked.length, 0, 'a fully mitigated zone is no longer current');
});

test('trackDsZones drops a zone invalidated by a decisive close beyond the distal edge', () => {
  const candles = zoneCandleSeries([candle(0, 104.0, 104.05, 103.4, 103.5)]);
  const tracked = trackDsZones({ raw: [makeRawZone()], candles, atr: atrOf(candles), precision: 2 });
  assert.equal(tracked.length, 0);
});

test('scoreDsZone rewards a fresh zone over an equally-formed tested zone', () => {
  const raw = makeRawZone();
  const fresh = scoreDsZone(
    raw,
    { state: 'FRESH', touches: 0, firstTestTime: null, distalReachedTime: null, invalidatedTime: null, maxPenetration: 0 },
    atrOf(zoneCandleSeries([]))
  );
  const tested = scoreDsZone(
    raw,
    { state: 'TESTED', touches: 2, firstTestTime: 1, distalReachedTime: null, invalidatedTime: null, maxPenetration: 0.3 },
    atrOf(zoneCandleSeries([]))
  );
  assert.ok(fresh.total > tested.total);
  assert.ok(fresh.freshness > tested.freshness);
});

test('detectDsRejection confirms a bullish M1 rejection at a demand zone', () => {
  const entry = m1BullishRejection();
  const rejection = detectDsRejection({
    entryCandles: entry,
    boundaryPrice: 104.3,
    direction: 'RISE',
    atr: atrOf(entry),
  });
  assert.equal(rejection.confirmed, true);
  assert.equal(rejection.kind, 'BULLISH_REJECTION');
  assert.equal(rejection.timeframe, 'M1');
});

test('detectDsRejection confirms a bearish M1 rejection at a supply zone', () => {
  const entry = m1BearishRejection(105.0);
  const rejection = detectDsRejection({
    entryCandles: entry,
    boundaryPrice: 105.0,
    direction: 'FALL',
    atr: atrOf(entry),
  });
  assert.equal(rejection.confirmed, true);
  assert.equal(rejection.kind, 'BEARISH_REJECTION');
});

test('detectDsRejection returns NONE when price never probed the zone', () => {
  const entry: Candle[] = [];
  for (let i = 0; i < 8; i++) {
    entry.push(candle(1_700_000_000 + i * M1_STEP, 110, 110.1, 109.9, 110.05));
  }
  const rejection = detectDsRejection({
    entryCandles: entry,
    boundaryPrice: 104.3,
    direction: 'RISE',
    atr: atrOf(entry),
  });
  assert.equal(rejection.confirmed, false);
  assert.equal(rejection.kind, 'NONE');
});

test('detectDsCandidate never returns a candidate without a confirmed M1 rejection', () => {
  const flatEntry: Candle[] = [];
  for (let i = 0; i < 8; i++) {
    flatEntry.push(candle(1_700_000_000 + i * M1_STEP, 104.3, 104.35, 104.25, 104.3));
  }
  const ctx = buildContext(makeZone(), flatEntry);
  assert.equal(detectDsCandidate(ctx), null);
});

test('detectDsCandidate classifies a fresh zone as a fresh-zone rejection and passes the gate', () => {
  const ctx = buildContext(makeZone());
  const candidate = detectDsCandidate(ctx);
  assert.ok(candidate);
  assert.equal(candidate!.model, 'DS_FRESH_REJECTION');
  assert.equal(candidate!.direction, 'RISE');
  assert.ok(candidate!.takeProfit1 > candidate!.entryPrice);
  assert.ok(candidate!.stopLoss < candidate!.entryPrice);
  assert.ok(isDsPublishable(candidate!), `expected publishable, score=${candidate!.score}`);
});

test('detectDsCandidate classifies a BOS-originating zone as an order block', () => {
  const ctx = buildContext(makeZone({ causedBos: true }));
  const candidate = detectDsCandidate(ctx);
  assert.ok(candidate);
  assert.equal(candidate!.model, 'DS_ORDER_BLOCK_RETEST');
});

test('detectDsCandidate classifies an FVG zone as FVG confluence', () => {
  const ctx = buildContext(
    makeZone({ hasFvgConfluence: true, fvg: { upperPrice: 104.2, lowerPrice: 103.9 } })
  );
  const candidate = detectDsCandidate(ctx);
  assert.ok(candidate);
  assert.equal(candidate!.model, 'DS_FVG_CONFLUENCE');
});

test('detectDsCandidate classifies a role-flipped zone as a breaker', () => {
  const ctx = buildContext(makeZone({ flipped: true, type: 'demand' }));
  const candidate = detectDsCandidate(ctx);
  assert.ok(candidate);
  assert.equal(candidate!.model, 'DS_BREAKER_RETEST');
});

test('detectDsCandidate classifies an already-tested zone as retest continuation', () => {
  const ctx = buildContext(makeZone({ state: 'TESTED', touches: 1, untested: false }));
  const candidate = detectDsCandidate(ctx);
  assert.ok(candidate);
  assert.equal(candidate!.model, 'DS_RETEST_CONTINUATION');
});

test('detectDsCandidate classifies a swept-and-reclaimed zone as a liquidity sweep', () => {
  const entry = m1BullishRejection();
  // Insert an earlier candle whose wick swept beyond the distal edge then reclaimed.
  entry.splice(2, 0, candle(1_700_000_000 + 2 * M1_STEP, 104.0, 104.05, 103.6, 103.9));
  const ctx = buildContext(makeZone(), entry);
  const candidate = detectDsCandidate(ctx);
  assert.ok(candidate);
  assert.equal(candidate!.model, 'DS_LIQUIDITY_SWEEP_RECLAIM');
});

test('applyFlips marks an invalidated zone as a role-flipped breaker', () => {
  const supply = makeZone({ type: 'supply', state: 'INVALIDATED', flipped: false });
  const flipped = applyFlips([supply]);
  assert.equal(flipped[0].flipped, true);
});

test('zoneInPlay is true only when price is inside or within an ATR of the zone', () => {
  const zone = makeZone();
  assert.equal(zoneInPlay(zone, 104.2, 0.5), true);
  assert.equal(zoneInPlay(zone, 110, 0.5), false);
});

test('analyzeDsInstrument returns a well-formed analysis for a live instrument', () => {
  const structure = dbrStructure();
  const analysis = analyzeDsInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: structure,
    setupCandles: setupAtZone(),
    entryCandles: m1BullishRejection(),
  });
  assert.equal(analysis.symbol, 'R_100');
  assert.equal(analysis.dataHealth, 'HEALTHY');
  assert.ok(analysis.status in DS_STATUS_LABELS);
  // The engine always surfaces the full ten-timeframe ladder — insufficient timeframes are
  // reported as "awaiting data", never omitted and never faked.
  assert.equal(analysis.timeframes.length, 10);
  assert.deepEqual(
    analysis.timeframes.map((t) => t.timeframe),
    ['M30', 'M15', 'M10', 'M7', 'M6', 'M5', 'M4', 'M3', 'M2', 'M1']
  );
  assert.ok(analysis.zones.every((z) => z.type === 'demand' || z.type === 'supply'));
});

test('analyzeDsInstrument reads the whole ten-timeframe ladder when all series are supplied', () => {
  const analysis = analyzeDsInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: dbrStructure(),
    trendCandles: dbrStructure(1_700_000_000, 420),
    setupCandles: setupAtZone(1_700_000_000, M5_STEP, 24),
    confirmCandles: setupAtZone(1_700_000_000, 180, 24),
    entryCandles: m1BullishRejection(),
    candlesByTimeframe: {
      M30: dbrStructure(1_700_000_000, 1800),
      M15: dbrStructure(),
      M10: dbrStructure(1_700_000_000, 600),
      M7: dbrStructure(1_700_000_000, 420),
      M6: dbrStructure(1_700_000_000, 360),
      M5: setupAtZone(1_700_000_000, M5_STEP, 24),
      M4: dbrStructure(1_700_000_000, 240),
      M3: setupAtZone(1_700_000_000, 180, 24),
      M2: dbrStructure(1_700_000_000, 120),
      M1: m1BullishRejection(),
    },
  });
  assert.deepEqual(
    analysis.timeframes.map((t) => t.timeframe),
    ['M30', 'M15', 'M10', 'M7', 'M6', 'M5', 'M4', 'M3', 'M2', 'M1']
  );
  for (const tf of analysis.timeframes) {
    assert.ok(tf.detail.length > 0, `${tf.timeframe}: empty detail`);
  }
});

test('analyzeDsInstrument withholds a signal when the data feed is stale', () => {
  const analysis = analyzeDsInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: dbrStructure(),
    setupCandles: setupAtZone(),
    entryCandles: m1BullishRejection(),
    dataHealth: 'STALE',
  });
  assert.equal(analysis.signal, null);
  assert.equal(analysis.dataHealth, 'STALE');
  assert.equal(analysis.status, 'ANALYSING');
});

test('analyzeDsInstrument reports ANALYSING with insufficient data', () => {
  const analysis = analyzeDsInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: dbrStructure().slice(0, 10),
    setupCandles: setupAtZone().slice(0, 5),
    entryCandles: [],
  });
  assert.equal(analysis.signal, null);
  assert.equal(analysis.zones.length, 0);
  assert.equal(analysis.status, 'ANALYSING');
});

function makeSignal(overrides: Partial<DsSignal> = {}): DsSignal {
  const zone = makeZone();
  const base: DsSignal = {
    id: 'ds-1',
    symbol: 'R_100',
    displayName: 'Volatility 100',
    marketFamily: 'VOLATILITY',
    precision: 2,
    direction: 'RISE',
    model: 'DS_FRESH_REJECTION',
    modelLabel: 'Fresh Zone Rejection',
    structureTimeframe: 'M15',
    trendTimeframe: 'M7',
    setupTimeframe: 'M5',
    confirmTimeframe: 'M3',
    entryTimeframe: 'M1',
    score: 90,
    zoneQuality: zone.score.total,
    entryPrice: 104.3,
    entryZoneLow: 103.8,
    entryZoneHigh: 104.3,
    stopLoss: 103.7,
    takeProfit1: 105.6,
    takeProfit2: 106.4,
    takeProfit3: null,
    invalidationPrice: 103.7,
    invalidationCondition: 'test',
    riskRewardRatio: 2.2,
    zone,
    confirmation: {
      confirmed: true,
      kind: 'BULLISH_REJECTION',
      timeframe: 'M1',
      time: 1_700_000_100,
      wickPrice: 103.95,
      close: 104.3,
      strength: 0.9,
      reason: 'test',
    },
    setupStage: 'READY_FOR_CONFIRMATION',
    reasons: [],
    confirmations: [],
    m15Context: 'test',
    m5Setup: 'test',
    m1Confirmation: 'test',
    status: 'CONFIRMED',
    createdAt: 1,
    confirmedBarTime: 1_700_000_100,
    lastUpdated: 1,
  };
  return { ...base, ...overrides };
}

function makeAnalysis(signal: DsSignal | null): DsInstrumentAnalysis {
  return {
    symbol: signal?.symbol ?? 'R_100',
    displayName: signal?.displayName ?? 'Volatility 100',
    marketFamily: 'VOLATILITY',
    precision: 2,
    price: 104.3,
    status: signal ? (signal.direction === 'RISE' ? 'RISE_CONFIRMED' : 'FALL_CONFIRMED') : 'NO_VALID_SETUP',
    statusExplanation: 'test',
    timeframes: [],
    zones: signal ? [signal.zone] : [],
    freshDemand: null,
    freshSupply: null,
    activeZone: null,
    bestCandidate: null,
    signal,
    allCandidates: [],
    futureWatchZones: [],
    demandSupplyBalance: 'BALANCED',
    atr: 0.5,
    dataHealth: 'HEALTHY',
    lastUpdated: 1,
  };
}

test('selectStrongestDs picks the highest-scoring confirmed signal', () => {
  const weak = makeAnalysis(makeSignal({ id: 'ds-weak', symbol: 'R_50', score: 88 }));
  const strong = makeAnalysis(makeSignal({ id: 'ds-strong', symbol: 'R_100', score: 96 }));
  const none = makeAnalysis(null);
  const summary = selectStrongestDs([weak, strong, none]);
  assert.equal(summary.winner?.id, 'ds-strong');
  assert.equal(summary.confirmedCount, 2);
  assert.equal(summary.scannedCount, 3);
});

test('selectStrongestDs reports zones-tracked when nothing is confirmed', () => {
  const analysis = makeAnalysis(null);
  analysis.zones = [makeZone()];
  const summary = selectStrongestDs([analysis]);
  assert.equal(summary.winner, null);
  assert.match(summary.statusBanner, /ZONES TRACKED/);
});

test('dsSignalStatus invalidates on a close beyond the stop and completes on TP1', () => {
  const signal = makeSignal();
  const invalidated = dsSignalStatus(signal, [
    candle(signal.confirmedBarTime + 60, 104.2, 104.3, 103.5, 103.6),
  ]);
  assert.equal(invalidated, 'INVALIDATED');

  const completed = dsSignalStatus(signal, [
    candle(signal.confirmedBarTime + 60, 104.3, 105.7, 104.2, 105.6),
  ]);
  assert.equal(completed, 'COMPLETED');

  const active = dsSignalStatus(signal, [
    candle(signal.confirmedBarTime + 60, 104.3, 104.5, 104.1, 104.4),
  ]);
  assert.equal(active, 'ACTIVE');
});

test('detectDsCandidate classifies an M1 BOS/CHOCH confirmation at a fresh zone', () => {
  const entry: Candle[] = [];
  for (let i = 0; i < 6; i++) {
    entry.push(candle(1_700_000_000 + i * M1_STEP, 104.2, 104.3, 104.15, 104.2));
  }
  // Decisive bullish M1 body closing well above the recent M1 range with the zone.
  entry.push(candle(1_700_000_000 + 6 * M1_STEP, 104.2, 104.85, 104.15, 104.8));
  entry.push(candle(1_700_000_000 + 7 * M1_STEP, 104.8, 104.9, 104.75, 104.85));
  const ctx = buildContext(makeZone(), entry);
  const candidate = detectDsCandidate(ctx);
  assert.ok(candidate);
  assert.equal(candidate!.model, 'DS_M1_BOS_CHOCH');
  assert.ok(candidate!.entryZoneLow <= candidate!.entryZoneHigh);
});

test('detectDsCandidate exposes an entry zone and never invents a TP3', () => {
  const candidate = detectDsCandidate(buildContext(makeZone()));
  assert.ok(candidate);
  assert.equal(candidate!.entryZoneLow, 103.8);
  assert.equal(candidate!.entryZoneHigh, 104.3);
  // A single fresh zone fixture carries no third structural target.
  assert.equal(candidate!.takeProfit3, null);
});

test('scoreDsZone weights HTF alignment and room to target', () => {
  const raw = makeRawZone();
  const tracker = {
    state: 'FRESH' as const,
    touches: 0,
    firstTestTime: null,
    distalReachedTime: null,
    invalidatedTime: null,
    maxPenetration: 0,
  };
  const aligned = scoreDsZone(raw, tracker, 1, 'BULLISH', 4);
  const fighting = scoreDsZone(raw, tracker, 1, 'BEARISH', 0.4);
  assert.ok(aligned.htfAlignment > fighting.htfAlignment);
  assert.ok(aligned.roomToTarget > fighting.roomToTarget);
  assert.ok(aligned.total > fighting.total);
});

test('trackDsZones marks an untouched zone ahead of price as a future watch zone', () => {
  // Price is far above the demand zone (104.3) — the untouched zone is a future watch.
  const candles = zoneCandleSeries([]);
  const zone = trackDsZones({
    raw: [makeRawZone()],
    candles,
    atr: 0.3,
    precision: 2,
  })[0];
  assert.equal(zone.isFutureWatch, true);
});

test('trackDsZones records the structural origins of a zone', () => {
  const zones = detectDsZones({
    structureCandles: dbrStructure(),
    refinementCandles: setupAtZone(),
    structureAtr: atrOf(dbrStructure()),
    precision: 2,
    swings: [],
    breaks: [],
    fvgs: [],
  });
  assert.ok(zones.length > 0);
  assert.ok(zones[0]!.origins?.includes('DISPLACEMENT'));
});

test('analyzeDsInstrument surfaces future watch zones ahead of price', () => {
  const structure = dbrStructure();
  const analysis = analyzeDsInstrument({
    symbol: 'R_100',
    displayName: 'Volatility 100',
    precision: 2,
    marketFamily: 'VOLATILITY',
    structureCandles: structure,
    setupCandles: setupAtZone(),
    entryCandles: m1BullishRejection(),
  });
  assert.ok(Array.isArray(analysis.futureWatchZones));
});
