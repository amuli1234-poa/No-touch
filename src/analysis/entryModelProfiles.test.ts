import test from 'node:test';
import assert from 'node:assert/strict';
import type { IndexModelRecord } from '../types/entryModelProfiles';
import {
  buildIndexProfiles,
  indexHistoricalBonus,
  indexHistoricalBonusMap,
  summarizeIndexPerformance,
  MIN_RELIABLE_SAMPLE,
} from './entryModelProfiles';

function rec(over: Partial<IndexModelRecord> = {}): IndexModelRecord {
  return {
    symbol: 'R_75',
    displayName: 'Volatility 75 Index',
    marketFamily: 'VOLATILITY',
    model: 'BOS_RETEST',
    timeframe: 'M5',
    direction: 'RISE',
    riskRewardRatio: 2,
    outcome: 'TARGET_HIT',
    settledAt: 1_000,
    ...over,
  };
}

/** A stable, non-overfit series: alternating wins/losses at a 50% rate. */
function alternating(symbol: string, model: IndexModelRecord['model'], count: number, offset = 0): IndexModelRecord[] {
  return Array.from({ length: count }, (_, i) =>
    rec({
      symbol,
      model,
      outcome: i % 2 === 0 ? 'TARGET_HIT' : 'STOP_HIT',
      settledAt: offset + i,
    })
  );
}

test('each index keeps its OWN profile — statistics are never blended across indices', () => {
  const records: IndexModelRecord[] = [
    ...Array.from({ length: 30 }, (_, i) =>
      rec({ symbol: 'R_75', outcome: i < 24 ? 'TARGET_HIT' : 'STOP_HIT', settledAt: i })
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      rec({ symbol: 'R_100', displayName: 'Volatility 100 Index', outcome: i < 6 ? 'TARGET_HIT' : 'STOP_HIT', settledAt: i })
    ),
  ];
  const profiles = buildIndexProfiles(records);
  assert.equal(profiles.size, 2);
  const p75 = profiles.get('R_75')!;
  const p100 = profiles.get('R_100')!;
  assert.equal(p75.totalRecords, 30);
  assert.equal(p100.totalRecords, 30);
  const bos75 = p75.models.find((m) => m.model === 'BOS_RETEST')!;
  const bos100 = p100.models.find((m) => m.model === 'BOS_RETEST')!;
  assert.equal(bos75.winRatePercent, 80);
  assert.equal(bos100.winRatePercent, 20);
});

test('a model is only marked reliable once the sample is large enough', () => {
  const small = buildIndexProfiles(
    Array.from({ length: MIN_RELIABLE_SAMPLE - 1 }, (_, i) => rec({ settledAt: i }))
  ).get('R_75')!;
  assert.equal(small.models[0].reliable, false);
  assert.equal(small.selected, null);

  const large = buildIndexProfiles(
    Array.from({ length: MIN_RELIABLE_SAMPLE }, (_, i) => rec({ settledAt: i }))
  ).get('R_75')!;
  assert.equal(large.models[0].reliable, true);
  assert.equal(large.selected, 'BOS_RETEST');
});

test('an overfit challenger is rejected and the previous validated model retained', () => {
  // The challenger looks strong in-sample but collapses out-of-sample → overfit, never adopted.
  const records: IndexModelRecord[] = Array.from({ length: 20 }, (_, i) =>
    rec({ model: 'FVG_ENTRY', outcome: i < 14 ? 'TARGET_HIT' : 'STOP_HIT', settledAt: i })
  );
  const previous = buildIndexProfiles(alternating('R_75', 'BOS_RETEST', 30)).get('R_75')!;
  assert.equal(previous.selected, 'BOS_RETEST');
  const profile = buildIndexProfiles(records, new Map([['R_75', previous]])).get('R_75')!;
  assert.equal(profile.selected, 'BOS_RETEST');
  assert.equal(profile.retained, true);
});

test('a genuinely stronger reliable challenger is adopted', () => {
  const records: IndexModelRecord[] = [
    ...alternating('R_75', 'BOS_RETEST', 30),
    ...Array.from({ length: 30 }, (_, i) =>
      rec({ model: 'FVG_ENTRY', outcome: 'TARGET_HIT', settledAt: 100 + i })
    ),
  ];
  const previous = buildIndexProfiles(alternating('R_75', 'BOS_RETEST', 30));
  const profile = buildIndexProfiles(records, previous).get('R_75')!;
  assert.equal(profile.selected, 'FVG_ENTRY');
  assert.equal(profile.retained, false);
  assert.ok((profile.selectedExpectancy ?? 0) > 0.5);
});

test('the historical bonus only rewards a reliable, non-overfit model', () => {
  const profile = buildIndexProfiles(
    Array.from({ length: 30 }, (_, i) => rec({ settledAt: i }))
  ).get('R_75')!;
  const bonus = indexHistoricalBonus(profile);
  assert.ok((bonus.BOS_RETEST ?? 0) > 0);
  assert.equal(indexHistoricalBonus(undefined).BOS_RETEST, undefined);
});

test('indexHistoricalBonusMap returns one entry per index', () => {
  const records: IndexModelRecord[] = [
    ...Array.from({ length: 30 }, (_, i) => rec({ symbol: 'R_75', settledAt: i })),
    ...Array.from({ length: 30 }, (_, i) =>
      rec({ symbol: 'R_100', displayName: 'V100', outcome: 'STOP_HIT', settledAt: i })
    ),
  ];
  const map = indexHistoricalBonusMap(buildIndexProfiles(records));
  assert.equal(map.size, 2);
  assert.ok(map.has('R_75'));
  assert.ok(map.has('R_100'));
});

test('summarizeIndexPerformance reports sample-aware stats for one index', () => {
  const perf = summarizeIndexPerformance(
    Array.from({ length: 20 }, (_, i) => rec({ outcome: i < 14 ? 'TARGET_HIT' : 'STOP_HIT' }))
  );
  assert.equal(perf[0].sampleSize, 20);
  assert.equal(perf[0].reliable, true);
  assert.equal(perf[0].winRatePercent, 70);
});
