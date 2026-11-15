import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeInstrument, selectStrongestSignal } from './signalEngine';
import { scoreCandidate, tierForScore, PUBLICATION_MIN_SCORE } from './qualityScore';
import type { EntryModelCandidate } from '../types/engine';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

/** Builds a clean uptrend with an impulse leg then a pullback and bullish rejection. */
function uptrendWithPullback(): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  let t = 1_700_000_000;
  for (let i = 0; i < 40; i++) {
    const o = price;
    const c = price + 0.6;
    candles.push(candle(t, o, c + 0.2, o - 0.2, c));
    price = c;
    t += 300;
  }
  // Pullback into prior structure
  for (let i = 0; i < 4; i++) {
    const o = price;
    const c = price - 0.5;
    candles.push(candle(t, o, o + 0.1, c - 0.1, c));
    price = c;
    t += 300;
  }
  // Bullish rejection candle
  candles.push(candle(t, price, price + 0.9, price - 0.3, price + 0.8));
  // Live (forming) bar
  candles.push(candle(t + 300, price + 0.8, price + 1.0, price + 0.7, price + 0.95));
  return candles;
}

const BASE = {
  symbol: 'R_100',
  displayName: 'Volatility 100 Index',
  precision: 2,
  marketFamily: 'VOLATILITY' as MarketFamily,
  timeframe: 'M5' as TimeframeKey,
};

test('analyzeInstrument never references a contract duration', () => {
  const analysis = analyzeInstrument({ ...BASE, candles: uptrendWithPullback() });
  assert.ok(!('selectedDurationMinutes' in analysis));
  assert.ok(!('durationMinutes' in analysis));
});

test('analyzeInstrument evaluates models and reports a condition', () => {
  const analysis = analyzeInstrument({ ...BASE, candles: uptrendWithPullback() });
  assert.ok(analysis.evaluatedModels.length > 0);
  assert.ok(
    ['STRONG_UPTREND', 'STRONG_DOWNTREND', 'CONSOLIDATION', 'TRANSITIONAL', 'CHOPPY'].includes(
      analysis.condition
    )
  );
  for (const m of analysis.evaluatedModels) {
    assert.ok(m.score >= 0 && m.score <= 100);
  }
});

test('a published signal (if any) must clear the 85-point gate and carry evidence', () => {
  const analysis = analyzeInstrument({ ...BASE, candles: uptrendWithPullback() });
  if (analysis.signal) {
    assert.ok(analysis.signal.quality.total >= PUBLICATION_MIN_SCORE);
    assert.ok(analysis.signal.quality.publishable);
    assert.ok(analysis.signal.confirmationExplanation.length > 0);
    assert.ok(Number.isFinite(analysis.signal.invalidationPrice));
  } else {
    assert.ok(analysis.rejectionReason);
  }
});

test('insufficient history yields no signal and a rejection reason', () => {
  const analysis = analyzeInstrument({ ...BASE, candles: [candle(1, 1, 1, 1, 1)] });
  assert.equal(analysis.signal, null);
  assert.ok(analysis.rejectionReason);
});

test('stale data suppresses signals entirely', () => {
  const analysis = analyzeInstrument({
    ...BASE,
    candles: uptrendWithPullback(),
    dataHealth: 'STALE',
  });
  assert.equal(analysis.signal, null);
});

test('scoreCandidate enforces the mandatory-evidence gate', () => {
  const candidate: EntryModelCandidate = {
    model: 'MODEL_8_MOMENTUM_BOS',
    modelLabel: 'Model 8 — Momentum BOS',
    direction: 'RISE',
    entryPrice: 100,
    structuralLevelPrice: 99,
    retestPrice: null,
    retestTime: null,
    invalidationPrice: 98,
    invalidationCondition: 'x',
    target1: 102,
    target2: 104,
    stopLoss: 98,
    riskRewardRatio: 2,
    confirmationExplanation: '',
    bosChochEvidence: [],
    supportResistance: [],
    momentumEvidence: [],
    reasons: [],
    invalidations: [],
    availableSpaceAtr: 3,
    availableSpaceLabel: 'Open',
    scores: {
      structure: 20,
      levelZone: 20,
      entryConfirmation: 25,
      momentum: 15,
      multiTimeframe: 10,
      availableSpace: 10,
    },
  };
  const breakdown = scoreCandidate(candidate);
  assert.equal(breakdown.total, 100);
  assert.equal(breakdown.tier, 'EXCEPTIONAL');
  // No structural evidence / confirmation explanation → not publishable.
  assert.equal(breakdown.publishable, false);
});

test('tierForScore maps the 100-point scale correctly', () => {
  assert.equal(tierForScore(95), 'EXCEPTIONAL');
  assert.equal(tierForScore(87), 'HIGH_QUALITY');
  assert.equal(tierForScore(80), 'DEVELOPING');
  assert.equal(tierForScore(60), 'REJECTED');
});

test('selectStrongestSignal chooses the highest-scoring confirmed setup only', () => {
  const good = analyzeInstrument({ ...BASE, candles: uptrendWithPullback() });
  const summary = selectStrongestSignal(
    [good],
    'M5',
    { VOLATILITY: 1, JUMP: 0, STEP: 0, RANGE_BREAK: 0 }
  );
  assert.equal(summary.scannedCount, 1);
  assert.ok(summary.statusBanner.length > 0);
  if (summary.winner) {
    assert.ok(summary.winner.quality.total >= PUBLICATION_MIN_SCORE);
  } else {
    assert.equal(summary.confirmedCount, 0);
  }
});

test('analyzeInstrument excludes Boom & Crash indices', () => {
  const boom = analyzeInstrument({
    ...BASE,
    symbol: 'BOOM500',
    displayName: 'Boom 500 Index',
    candles: uptrendWithPullback(),
  });
  assert.equal(boom.signal, null);
  assert.match(boom.rejectionReason ?? '', /Boom & Crash/i);

  const crash = analyzeInstrument({
    ...BASE,
    symbol: 'CRASH300',
    displayName: 'Crash 300 Index',
    candles: uptrendWithPullback(),
  });
  assert.equal(crash.signal, null);
  assert.match(crash.rejectionReason ?? '', /Boom & Crash/i);
});

test('analyzeInstrument surfaces multi-engine findings and reachability', () => {
  const analysis = analyzeInstrument({ ...BASE, candles: uptrendWithPullback() });
  if (analysis.bestCandidate) {
    assert.ok(analysis.findings !== null);
    assert.ok(analysis.reachability !== null);
    assert.ok(analysis.falseSignal !== null);
  } else {
    assert.equal(analysis.reachability, null);
    assert.equal(analysis.falseSignal, null);
  }
});
