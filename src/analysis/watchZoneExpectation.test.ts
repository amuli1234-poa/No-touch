import test from 'node:test';
import assert from 'node:assert/strict';
import type { FutureReactionZone } from '../types/structure';
import {
  buildWatchZoneExpectation,
  isFreshWatchZone,
  selectPrimaryWatchZone,
} from './watchZoneExpectation';

function zone(over: Partial<FutureReactionZone> = {}): FutureReactionZone {
  return {
    id: 'z1',
    direction: 'RISE',
    kind: 'support',
    upperPrice: 101,
    lowerPrice: 99,
    originTime: 1_700_000_000,
    originTimeframe: 'M15',
    sourceStructure: 'broken resistance → potential support',
    freshness: 'FRESH',
    stage: 'PRICE_APPROACHING',
    invalidationLevel: 97,
    invalidationCondition: 'A close below 97 invalidates the zone.',
    reactions: 2,
    distanceAtr: 0.4,
    approachProgress: 0.8,
    reason: 'Buyers defended this level twice with bullish displacement',
    evidence: ['Bullish rejection wick', 'Higher low formed'],
    ...over,
  };
}

test('fresh zone with approaching price yields a supported RISE expectation', () => {
  const e = buildWatchZoneExpectation({
    zone: zone(),
    overallDirection: 'BULLISH',
    atr: 1,
    opposingLevels: [104, 108, 112],
  });
  assert.equal(e.expectedReaction, 'RISE');
  assert.equal(e.marketDirection, 'BULLISH');
  assert.equal(e.isFreshOpportunity, true);
  assert.equal(e.zone.type, 'Demand');
  assert.ok(e.reason.toLowerCase().includes('buyers'));
  assert.ok(e.confirmationRequired.toLowerCase().includes('close back up'));
  assert.equal(e.targets.tp1, 104);
  assert.equal(e.targets.tp2, 108);
  assert.equal(e.targets.tp3, 112);
  assert.equal(e.targets.justified, true);
});

test('a bearish supply zone yields a supported FALL expectation', () => {
  const e = buildWatchZoneExpectation({
    zone: zone({
      direction: 'FALL',
      kind: 'resistance',
      sourceStructure: 'supply zone',
      reason: 'Sellers rejected this level with bearish displacement',
      evidence: ['Bearish engulfing'],
    }),
    overallDirection: 'BEARISH',
    atr: 1,
    opposingLevels: [96, 92],
  });
  assert.equal(e.expectedReaction, 'FALL');
  assert.equal(e.zone.type, 'Supply');
  assert.ok(e.reason.toLowerCase().includes('sellers'));
  assert.equal(e.targets.tp1, 96);
  assert.equal(e.targets.tp2, 92);
});

test('a detected-but-not-yet-reached zone waits for confirmation (no forced reversal)', () => {
  const e = buildWatchZoneExpectation({
    zone: zone({ stage: 'ZONE_DETECTED', approachProgress: 0.1 }),
    overallDirection: 'NEUTRAL',
    atr: 1,
    opposingLevels: [104],
  });
  assert.equal(e.expectedReaction, 'WAITING_FOR_CONFIRMATION');
  assert.equal(e.targets.tp1, null);
  assert.ok(e.quality.score <= 55);
});

test('a mitigated zone is never a fresh opportunity and never asserts a direction', () => {
  const e = buildWatchZoneExpectation({
    zone: zone({ freshness: 'MITIGATED' }),
    overallDirection: 'BULLISH',
    atr: 1,
    opposingLevels: [104],
  });
  assert.equal(e.isFreshOpportunity, false);
  assert.equal(e.expectedReaction, 'WAITING_FOR_CONFIRMATION');
});

test('a failed zone is excluded by isFreshWatchZone', () => {
  assert.equal(isFreshWatchZone(zone({ stage: 'FAILED' })), false);
  assert.equal(isFreshWatchZone(zone({ freshness: 'INVALIDATED' })), false);
  assert.equal(isFreshWatchZone(zone({ stage: 'INVALIDATED' })), false);
  assert.equal(isFreshWatchZone(zone()), true);
});

test('breakout retest zones are classified correctly', () => {
  const e = buildWatchZoneExpectation({
    zone: zone({ sourceStructure: 'broken resistance → breakout retest' }),
    overallDirection: 'BULLISH',
    atr: 1,
    opposingLevels: [104],
  });
  assert.equal(e.zone.type, 'Breakout retest');
});

test('no opposing structural levels means no justified targets', () => {
  const e = buildWatchZoneExpectation({
    zone: zone(),
    overallDirection: 'BULLISH',
    atr: 1,
    opposingLevels: [],
  });
  assert.equal(e.targets.justified, false);
});

test('selectPrimaryWatchZone picks the freshest zone closest to price and skips tested ones', () => {
  const far = zone({ id: 'far', approachProgress: 0.2 });
  const near = zone({ id: 'near', approachProgress: 0.9 });
  const tested = zone({ id: 'tested', freshness: 'MITIGATED', approachProgress: 1 });
  const primary = selectPrimaryWatchZone([far, tested, near]);
  assert.equal(primary?.id, 'near');
});

test('selectPrimaryWatchZone returns null when no fresh zone exists', () => {
  assert.equal(selectPrimaryWatchZone([zone({ stage: 'FAILED' })]), null);
  assert.equal(selectPrimaryWatchZone([]), null);
});
