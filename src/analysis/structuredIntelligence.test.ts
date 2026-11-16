import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type { AiEngineParams } from '../hooks/useAiScanner';
import type { IndexLearningPlan } from '../types/learning';
import {
  analyzeTimeframeAlignmentInstrument,
  buildTimeframeAlignment,
  TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE,
} from './timeframeAlignmentEngine';
import {
  analyzeConsolidationInstrument,
  buildConsolidationRead,
  CONSOLIDATION_PUBLICATION_MIN_SCORE,
} from './consolidationEngine';
import { buildStructuredTrade } from './structuredReads';

function mk(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const STEP = 900;
const T0 = 1_700_000_000;

/** Walks a series to each target price, producing real pivots at the turns. */
function walk(legs: number[], start = 100, pad = 0.4, stepsPerLeg = 6): Candle[] {
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

const BULL = walk([104, 101, 108, 104, 113, 109, 118, 114, 123], 100, 0.5, 20);
const BEAR = walk([96, 99, 92, 96, 87, 91, 82, 86, 77], 100, 0.5, 20);

/** A genuine range: oscillates between two bounds with small, balanced steps. */
function makeRange(lo = 100, hi = 104, cycles = 6, stepsPerLeg = 4): Candle[] {
  const legs: number[] = [];
  for (let c = 0; c < cycles; c++) legs.push(hi, lo);
  return walk(legs, lo, 0.15, stepsPerLeg);
}
const RANGE = makeRange();

/** A coil that contracts (wide oscillation → tight oscillation) then breaks out upward. */
function makeCoil(): Candle[] {
  const wide = walk([103, 100, 103, 100, 103, 100], 100, 0.2, 5);
  const t0 = wide[wide.length - 1].time + STEP;
  const tight = walk([101, 100.5, 101, 100.5, 101, 100.5], 100, 0.08, 5).map((c, i) => ({
    ...c,
    time: t0 + i * STEP,
  }));
  const last = tight[tight.length - 1];
  const breakout = mk(last.time + STEP, last.close, last.close + 2.4, last.close - 0.1, last.close + 2.1);
  // A trailing forming bar — the engine evaluates the last CONFIRMED bar, so the breakout
  // must not itself be the newest bar.
  const trailing = mk(breakout.time + STEP, breakout.close, breakout.close + 0.3, breakout.close - 0.2, breakout.close + 0.1);
  return [...wide, ...tight, breakout, trailing];
}
const COIL = makeCoil();

function fullLadder(candles: Candle[]): Partial<Record<TimeframeKey, readonly Candle[]>> {
  const tf: TimeframeKey[] = ['M30', 'M15', 'M10', 'M7', 'M5', 'M3', 'M1'];
  const out: Partial<Record<TimeframeKey, readonly Candle[]>> = {};
  for (const k of tf) out[k] = candles;
  return out;
}

function params(candles: Candle[], over: Partial<AiEngineParams> = {}): AiEngineParams {
  return {
    symbol: 'R_10',
    displayName: 'Volatility 10 Index',
    precision: 2,
    marketFamily: 'VOLATILITY' as MarketFamily,
    structureCandles: candles,
    setupCandles: candles,
    entryCandles: candles,
    candlesByTimeframe: fullLadder(candles),
    dataHealth: 'HEALTHY',
    peers: [],
    ...over,
  };
}

function assertValidTrade(trade: { entry: number; stop: number; tp1: number; tp2: number; riskRewardRatio: number }, dir: 'RISE' | 'FALL') {
  assert.ok(Number.isFinite(trade.entry) && trade.entry > 0, 'bad entry');
  if (dir === 'RISE') {
    assert.ok(trade.stop < trade.entry, 'RISE stop not below entry');
    assert.ok(trade.tp1 > trade.entry, 'RISE tp1 not above entry');
    assert.ok(trade.tp2 >= trade.tp1, 'RISE tp2 < tp1');
  } else {
    assert.ok(trade.stop > trade.entry, 'FALL stop not above entry');
    assert.ok(trade.tp1 < trade.entry, 'FALL tp1 not below entry');
    assert.ok(trade.tp2 <= trade.tp1, 'FALL tp2 > tp1');
  }
}

// ---------------------------------------------------------------------------
// TIMEFRAME ALIGNMENT AI
// ---------------------------------------------------------------------------

test('alignment: a fully aligned uptrend resolves to RISE with a high score', () => {
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: fullLadder(BULL),
  });
  assert.equal(read.direction, 'RISE');
  assert.equal(read.majorBias, 'RISE');
  assert.equal(read.intermediateBias, 'RISE');
  assert.equal(read.refinementBias, 'RISE');
  assert.equal(read.character, 'ALIGNED_CONTINUATION');
  assert.equal(read.insufficient, false);
  assert.ok((read.alignmentScore ?? 0) >= TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE, `score ${read.alignmentScore}`);
  assert.equal(read.contradictions.length, 0);
  assert.equal(read.ladder.length, 7);
});

test('alignment: a fully aligned downtrend resolves to FALL', () => {
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: fullLadder(BEAR),
  });
  assert.equal(read.direction, 'FALL');
  assert.equal(read.character, 'ALIGNED_CONTINUATION');
});

test('alignment: a lower-timeframe counter-move is a pullback, not a reversal', () => {
  const map = fullLadder(BULL);
  map.M3 = BEAR;
  map.M1 = BEAR;
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: map,
  });
  assert.equal(read.direction, 'RISE');
  assert.equal(read.refinementBias, 'FALL');
  assert.equal(read.character, 'PULLBACK_IN_TREND');
  assert.ok(read.contradictions.length >= 1);
  assert.match(read.requiredEntryConfirmation, /RISE/);
});

test('alignment: opposing major structure is a genuine reversal', () => {
  const map = fullLadder(BULL);
  map.M30 = BEAR;
  map.M15 = BEAR;
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: map,
  });
  assert.equal(read.direction, 'RISE');
  assert.equal(read.majorBias, 'FALL');
  assert.equal(read.character, 'GENUINE_REVERSAL');
});

test('alignment: opposing major AND intermediate structure is a conflict', () => {
  const map = fullLadder(BULL);
  map.M30 = BEAR;
  map.M15 = BEAR;
  map.M10 = BEAR;
  map.M7 = BEAR;
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: map,
  });
  assert.equal(read.character, 'CONFLICTING');
  assert.equal(read.directionalBias, 'conflicting');
  assert.ok((read.alignmentScore ?? 0) < TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE);
});

test('alignment: too few timeframes is insufficient', () => {
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: { M5: BULL },
  });
  assert.equal(read.insufficient, true);
  assert.equal(read.ladder.length, 1);
});

test('alignment: the trade plan is structurally valid', () => {
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: fullLadder(BULL),
  });
  assert.ok(read.trade, 'expected a trade');
  assertValidTrade(read.trade!, read.direction!);
});

test('alignment: the learner plan is consumed as advisory evidence', () => {
  const plan: IndexLearningPlan = {
    symbol: 'R_10',
    displayName: 'V10',
    analysisTimeframe: 'M15',
    confirmationTimeframe: 'M3',
    executionTimeframe: 'M5',
    requiredAlignment: ['M30', 'M15'],
    bestCombination: { reliable: true } as IndexLearningPlan['bestCombination'],
    falseSignalTimeframes: ['M7'],
  };
  const read = buildTimeframeAlignment({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    candlesByTimeframe: fullLadder(BULL),
    learnerPlan: plan,
  });
  assert.equal(read.learner.reliable, true);
  assert.equal(read.learner.analysisTimeframe, 'M15');
  assert.equal(read.learner.confirmationTimeframe, 'M3');
  assert.deepEqual(read.falseSignalTimeframes, ['M7']);
  assert.match(read.learner.note, /M15/);
});

test('alignment: the engine publishes an aligned setup through the shared contract', () => {
  const a = analyzeTimeframeAlignmentInstrument(params(BULL));
  assert.equal(a.symbol, 'R_10');
  assert.ok(a.signal, 'expected a published signal');
  assert.equal(a.signal!.direction, 'RISE');
  assert.ok(a.signal!.score >= TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE);
  assertValidTrade(
    {
      entry: a.signal!.entryPrice,
      stop: a.signal!.stopLoss,
      tp1: a.signal!.takeProfit1,
      tp2: a.signal!.takeProfit2,
      riskRewardRatio: a.signal!.riskRewardRatio,
    },
    'RISE'
  );
});

test('alignment: the engine never publishes a conflicting ladder', () => {
  const map = fullLadder(BULL);
  map.M30 = BEAR;
  map.M15 = BEAR;
  map.M10 = BEAR;
  map.M7 = BEAR;
  const a = analyzeTimeframeAlignmentInstrument(params(BULL, { candlesByTimeframe: map }));
  assert.equal(a.signal, null);
  assert.ok(a.rejectionReason && a.rejectionReason.length > 0);
});

// ---------------------------------------------------------------------------
// MARKET CONSOLIDATION & MOMENTUM AI
// ---------------------------------------------------------------------------

test('consolidation: a range is detected as sideways with weak displacement', () => {
  const read = buildConsolidationRead({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    setupCandles: RANGE,
  });
  assert.equal(read.breakoutApproved, false);
  assert.equal(read.trade, null);
  assert.equal(read.signals.sideways, true);
  assert.equal(read.signals.lowDisplacement, true);
  assert.ok(read.consolidationScore >= 40, `score ${read.consolidationScore}`);
});

test('consolidation: a confirmed breakout out of a coil is approved', () => {
  const read = buildConsolidationRead({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    setupCandles: COIL,
  });
  assert.equal(read.breakoutApproved, true);
  assert.equal(read.expansion, 'CONFIRMED');
  assert.equal(read.direction, 'RISE');
  assert.ok(read.trade, 'expected a breakout trade');
  assertValidTrade(read.trade!, 'RISE');
});

test('consolidation: a clean trend is a slow trend, not consolidation', () => {
  const read = buildConsolidationRead({
    symbol: 'R_10',
    displayName: 'V10',
    marketFamily: 'VOLATILITY' as MarketFamily,
    precision: 2,
    setupCandles: BULL,
  });
  assert.equal(read.slowTrend, true);
  assert.equal(read.genuineConsolidation, false);
  assert.ok(read.bullishMomentum > read.bearishMomentum);
});

test('consolidation: a breakout out of a coil publishes through the shared contract', () => {
  const a = analyzeConsolidationInstrument(params(COIL));
  assert.ok(a.signal, 'expected a published breakout signal');
  assert.equal(a.signal!.direction, 'RISE');
  assert.ok(a.signal!.score >= CONSOLIDATION_PUBLICATION_MIN_SCORE);
  assertValidTrade(
    {
      entry: a.signal!.entryPrice,
      stop: a.signal!.stopLoss,
      tp1: a.signal!.takeProfit1,
      tp2: a.signal!.takeProfit2,
      riskRewardRatio: a.signal!.riskRewardRatio,
    },
    'RISE'
  );
});

test('consolidation: a range publishes no directional continuation', () => {
  const a = analyzeConsolidationInstrument(params(RANGE));
  assert.equal(a.signal, null);
  assert.ok(a.rejectionReason && a.rejectionReason.length > 0);
});

// ---------------------------------------------------------------------------
// STRUCTURAL TRADE SANITY (shared builder)
// ---------------------------------------------------------------------------

test('buildStructuredTrade refuses a stop on the wrong side of the entry', () => {
  assert.equal(
    buildStructuredTrade({ direction: 'RISE', entry: 100, stop: 101, candidates: [110], unit: 1 }),
    null
  );
});

test('buildStructuredTrade refuses a first target inside the entry noise band', () => {
  // A target only 0.2 ATR away is market noise, not a real level — never publish it.
  assert.equal(
    buildStructuredTrade({ direction: 'RISE', entry: 100, stop: 99, candidates: [100.2], unit: 1 }),
    null
  );
});

test('buildStructuredTrade refuses an unenterable stop distance', () => {
  // A stop 30 ATR away is not a trade anyone can size — reject rather than publish it.
  assert.equal(
    buildStructuredTrade({ direction: 'FALL', entry: 100, stop: 130, candidates: [95], unit: 1 }),
    null
  );
});

test('buildStructuredTrade publishes a real, enterable trade', () => {
  const trade = buildStructuredTrade({
    direction: 'RISE',
    entry: 100,
    stop: 98,
    candidates: [104, 108],
    unit: 2,
  });
  assert.ok(trade, 'expected a trade');
  assert.ok(trade!.riskRewardRatio >= 1, `R:R ${trade!.riskRewardRatio}`);
  assert.ok(trade!.tp1 > trade!.entry && trade!.tp2 >= trade!.tp1);
});
