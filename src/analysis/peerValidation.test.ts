import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiSignal } from './aiCommon';
import { verifyPeerEvidence, gradeFor, type PeerEvidence } from './peerValidation';
import type { AiDirection } from '../types/aiModule';

function mkSignal(overrides: Partial<Parameters<typeof buildAiSignal>[0]> = {}) {
  return buildAiSignal({
    id: overrides.id ?? 'sig-1',
    symbol: 'R_75',
    displayName: 'Volatility 75',
    marketFamily: 'VOLATILITY' as const,
    precision: 2,
    direction: 'RISE',
    modelId: 'TEST_MODEL',
    modelLabel: 'Test model',
    strategyLabel: 'Test',
    status: 'CONFIRMED',
    score: 90,
    condition: 'STRONG_BULLISH',
    entryPrice: 100,
    entryZoneLow: 99.8,
    entryZoneHigh: 100.2,
    stopLoss: 98,
    takeProfit1: 104,
    takeProfit2: 106,
    takeProfit3: 108,
    invalidationCondition: 'close below 98',
    reasons: [],
    confirmations: [],
    timeframes: [],
    confirmedBarTime: 1_700_000_000,
    ...overrides,
  });
}

function baseInput(peers: PeerEvidence[]) {
  return {
    peers,
    price: 100,
    atr: 1,
    precision: 2,
    condition: 'STRONG_BULLISH' as const,
    bias: 'bullish' as const,
    fvgs: [],
    obs: [],
    latestSweep: null,
    latestBreak: { direction: 'bullish' as const, kind: 'BOS' },
    opposingPools: [{ side: 'BSL' as const, price: 106 }],
  };
}

test('gradeFor maps scores to letter grades deterministically', () => {
  assert.equal(gradeFor(95), 'A+');
  assert.equal(gradeFor(88), 'A');
  assert.equal(gradeFor(80), 'B');
  assert.equal(gradeFor(72), 'C');
  assert.equal(gradeFor(50), 'REJECTED');
});

test('verifyPeerEvidence rejects a signal whose stop has already been breached', () => {
  const signal = mkSignal({ stopLoss: 101 }); // price 100 < 101 stop → invalidated for RISE
  const result = verifyPeerEvidence(baseInput([{ module: 'BOS & CHOCH AI', signal }]));
  assert.equal(result.verified.length, 0);
  assert.equal(result.chosen, null);
  assert.match(result.conflicts[0], /invalidated/i);
});

test('verifyPeerEvidence rejects a late entry that already reached TP1', () => {
  const signal = mkSignal({ takeProfit1: 99 }); // price already above TP1
  const result = verifyPeerEvidence(baseInput([{ module: 'Technical AI', signal }]));
  assert.equal(result.verified.length, 0);
  assert.match(result.conflicts[0], /late|TP1/i);
});

test('verifyPeerEvidence de-duplicates correlated evidence with the same model', () => {
  const a = mkSignal({ id: 'a' });
  const b = mkSignal({ id: 'b' });
  const result = verifyPeerEvidence(
    baseInput([
      { module: 'BOS & CHOCH AI', signal: a },
      { module: 'Technical AI', signal: b },
    ])
  );
  assert.equal(result.verified.length, 1, 'same direction + model must count once');
  assert.equal(result.chosen, 'RISE');
});

test('verifyPeerEvidence does not force a direction when conflicting evidence is close', () => {
  const rise = mkSignal({ id: 'rise', direction: 'RISE' });
  const fall = mkSignal({
    id: 'fall',
    direction: 'FALL',
    stopLoss: 102,
    takeProfit1: 96,
    takeProfit2: 94,
    takeProfit3: 92,
  });
  const result = verifyPeerEvidence({
    ...baseInput([
      { module: 'BOS & CHOCH AI', signal: rise },
      { module: 'SMC, ICT & Price Action AI', signal: fall },
    ]),
    bias: 'neutral',
    latestBreak: null,
    opposingPools: [
      { side: 'BSL' as const, price: 106 },
      { side: 'SSL' as const, price: 94 },
    ],
  });
  const directions = new Set(result.verified.map((v) => v.direction as AiDirection));
  assert.equal(directions.size, 2, 'both directions are evaluated');
  assert.equal(result.chosen, null, 'a near-tie must not force a direction');
});

test('verifyPeerEvidence chooses a side when one direction is clearly stronger', () => {
  const strongRise = mkSignal({ id: 'rise', score: 95 });
  const weakFall = mkSignal({
    id: 'fall',
    direction: 'FALL',
    score: 84,
    stopLoss: 101,
    takeProfit1: 96,
    takeProfit2: 94,
    takeProfit3: 92,
  });
  const result = verifyPeerEvidence({
    ...baseInput([
      { module: 'BOS & CHOCH AI', signal: strongRise },
      { module: 'Technical AI', signal: weakFall },
    ]),
    opposingPools: [{ side: 'BSL' as const, price: 106 }],
  });
  assert.equal(result.chosen, 'RISE');
  assert.ok(result.confluenceScore > 0);
});

test('verifyPeerEvidence returns no chosen direction when there is no evidence', () => {
  const result = verifyPeerEvidence(baseInput([]));
  assert.equal(result.chosen, null);
  assert.equal(result.confluenceScore, 0);
  assert.equal(result.grade, 'REJECTED');
});
