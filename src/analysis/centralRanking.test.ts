import test from 'node:test';
import assert from 'node:assert/strict';
import type { CentralCandidate, IndexValidatedPerformance } from '../types/centralRanking';
import type { EntryModelDecision } from '../types/entryModelAI';
import type { RankedSetup } from '../types/ranking';
import {
  runCentralRanking,
  toCentralCandidate,
  validatedPerformanceFromProfile,
  freshnessWindowMs,
  CENTRAL_MIN_SCORE,
} from './centralRanking';

const NOW = 1_800_000_000_000; // fixed epoch ms
const FRESH_TS = Math.floor(NOW / 1000) - 30;

function decision(over: Partial<EntryModelDecision> = {}): EntryModelDecision {
  return {
    key: 'k1',
    originatingStrategy: 'BOS & CHOCH AI',
    marketName: 'Volatility 75 Index',
    symbol: 'R_75',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    direction: 'RISE',
    state: 'CONFIRMED',
    model: 'BOS_RETEST',
    modelLabel: 'BOS & Retest Entry',
    combinedWith: [],
    htfDirection: 'RISE',
    watchingZone: null,
    entryPrice: 1000,
    entryRange: { low: 998, high: 1002 },
    requiredConfirmation: 'Close back above the zone',
    stopLoss: 990,
    invalidation: { level: 990, condition: 'Close below the stop' },
    targets: { tp1: 1020, tp2: 1030, tp3: 1040 },
    riskRewardRatio: 2.5,
    qualityScore: 88,
    confirmedBarTime: FRESH_TS,
    explanation: 'x',
    dataTimestamp: FRESH_TS,
    expiresAt: NOW + 60_000,
    indexValidatedModel: 'BOS_RETEST',
    indexValidatedModelLabel: 'BOS & Retest Entry',
    evaluations: [],
    ...over,
  };
}

function candidate(over: Partial<CentralCandidate> = {}): CentralCandidate {
  return {
    key: 'k1',
    sourceLabel: 'BOS & CHOCH AI',
    symbol: 'R_75',
    displayName: 'Volatility 75 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    direction: 'RISE',
    engineScore: 88,
    entryPrice: 1000,
    stopLoss: 990,
    takeProfit1: 1020,
    takeProfit2: 1030,
    riskRewardRatio: 2.5,
    reasons: ['Break of structure'],
    confirmedBarTime: FRESH_TS,
    dataTimestamp: FRESH_TS,
    expiresAt: NOW + 60_000,
    entryDecision: decision(),
    setup: { key: 'k1' } as RankedSetup,
    ...over,
  };
}

const base = { connectionStatus: 'connected' as const, now: NOW };

test('no signals are published while the feed is disconnected', () => {
  const res = runCentralRanking({
    ...base,
    connectionStatus: 'connecting',
    candidates: [candidate()],
  });
  assert.equal(res.ranked.length, 0);
  assert.equal(res.rejected[0].reason, 'DISCONNECTED');
});

test('a candidate with stale data is rejected, not ranked', () => {
  const res = runCentralRanking({
    ...base,
    candidates: [candidate({ dataTimestamp: FRESH_TS - 3600, confirmedBarTime: FRESH_TS - 3600 })],
  });
  assert.equal(res.ranked.length, 0);
  assert.equal(res.rejected[0].reason, 'STALE_DATA');
});

test('an expired candidate is rejected as EXPIRED', () => {
  const res = runCentralRanking({
    ...base,
    candidates: [candidate({ expiresAt: NOW - 1 })],
  });
  assert.equal(res.ranked.length, 0);
  assert.equal(res.rejected[0].reason, 'EXPIRED');
});

test('an incomplete candidate (no stop-loss) is rejected', () => {
  const res = runCentralRanking({
    ...base,
    candidates: [candidate({ stopLoss: null })],
  });
  assert.equal(res.ranked.length, 0);
  assert.equal(res.rejected[0].reason, 'INCOMPLETE');
});

test('a candidate whose entry model is not confirmed is rejected', () => {
  const res = runCentralRanking({
    ...base,
    candidates: [candidate({ entryDecision: decision({ state: 'WATCHING', model: null }) })],
  });
  assert.equal(res.ranked.length, 0);
  assert.equal(res.rejected[0].reason, 'ENTRY_NOT_CONFIRMED');
});

test('a confirmed candidate with a model is ranked #1', () => {
  const res = runCentralRanking({ ...base, candidates: [candidate()] });
  assert.equal(res.ranked.length, 1);
  assert.equal(res.ranked[0].rank, 1);
  assert.ok(res.ranked[0].score.total >= CENTRAL_MIN_SCORE);
});

test('duplicate setups for the same opportunity keep only the strongest', () => {
  const res = runCentralRanking({
    ...base,
    candidates: [candidate({ key: 'a', engineScore: 70 }), candidate({ key: 'b', engineScore: 92 })],
  });
  assert.equal(res.ranked.length, 1);
  assert.equal(res.ranked[0].candidate.key, 'b');
  assert.ok(res.rejected.some((r) => r.reason === 'DUPLICATE'));
});

test('conflicting directions on one market resolve to the stronger reading', () => {
  const res = runCentralRanking({
    ...base,
    candidates: [
      candidate({ key: 'rise', direction: 'RISE', engineScore: 60, entryDecision: decision({ direction: 'RISE' }) }),
      candidate({ key: 'fall', direction: 'FALL', engineScore: 90, entryDecision: decision({ direction: 'FALL', htfDirection: 'FALL' }) }),
    ],
  });
  assert.equal(res.ranked.length, 1);
  assert.equal(res.ranked[0].candidate.direction, 'FALL');
  assert.ok(res.rejected.some((r) => r.reason === 'CONFLICT'));
});

test('an exact-score direction conflict rejects BOTH readings', () => {
  const res = runCentralRanking({
    ...base,
    candidates: [
      candidate({ key: 'rise', direction: 'RISE', engineScore: 80, entryDecision: decision({ direction: 'RISE' }) }),
      candidate({ key: 'fall', direction: 'FALL', engineScore: 80, entryDecision: decision({ direction: 'FALL' }) }),
    ],
  });
  assert.equal(res.ranked.length, 0);
  assert.equal(res.rejected.filter((r) => r.reason === 'CONFLICT').length, 2);
});

test('validated per-index performance lifts a candidate in the ranking', () => {
  const perf = new Map<string, IndexValidatedPerformance>([
    ['R_75', { model: 'BOS_RETEST', expectancy: 1.2, winRatePercent: 70, sampleSize: 40, reliable: true }],
  ]);
  const withPerf = runCentralRanking({
    ...base,
    performanceBySymbol: perf,
    candidates: [candidate({ key: 'a', engineScore: 70 })],
  });
  const without = runCentralRanking({
    ...base,
    candidates: [candidate({ key: 'a', engineScore: 70 })],
  });
  assert.ok(withPerf.ranked[0].score.total > without.ranked[0].score.total);
  assert.equal(withPerf.ranked[0].score.usedValidatedPerformance, true);
});

test('the top-N limit is honoured', () => {
  const candidates = [
    candidate({ key: 'a', symbol: 'R_10', displayName: 'V10', engineScore: 90 }),
    candidate({ key: 'b', symbol: 'R_25', displayName: 'V25', engineScore: 80, entryDecision: decision({ symbol: 'R_25' }) }),
    candidate({ key: 'c', symbol: 'R_50', displayName: 'V50', engineScore: 70, entryDecision: decision({ symbol: 'R_50' }) }),
    candidate({ key: 'd', symbol: 'R_75', displayName: 'V75', engineScore: 60, entryDecision: decision({ symbol: 'R_75' }) }),
  ];
  const res = runCentralRanking({ ...base, candidates, topN: 2 });
  assert.equal(res.ranked.length, 2);
  assert.deepEqual(res.ranked.map((r) => r.candidate.key), ['a', 'b']);
});

test('toCentralCandidate preserves the setup score and derives freshness from its bar', () => {
  const setup = {
    key: 'k1',
    sourceLabel: 'BOS & CHOCH AI',
    symbol: 'R_75',
    displayName: 'V75',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    direction: 'RISE',
    score: 84,
    entryPrice: 1000,
    stopLoss: 990,
    takeProfit1: 1020,
    takeProfit2: 1030,
    riskRewardRatio: 2.5,
    reasons: ['x'],
    confirmedBarTime: FRESH_TS,
  } as unknown as RankedSetup;
  const c = toCentralCandidate(setup, decision(), NOW);
  assert.equal(c.engineScore, 84);
  assert.equal(c.dataTimestamp, FRESH_TS);
  assert.ok(c.expiresAt > NOW);
});

test('freshnessWindowMs scales with the timeframe', () => {
  assert.ok(freshnessWindowMs('M15') > freshnessWindowMs('M5'));
  assert.ok(freshnessWindowMs('M1') < freshnessWindowMs('M5'));
});

test('validatedPerformanceFromProfile only surfaces a reliable non-overfit model', () => {
  const profile = {
    symbol: 'R_75',
    displayName: 'V75',
    marketFamily: 'VOLATILITY' as const,
    totalRecords: 40,
    selected: 'BOS_RETEST' as const,
    selectedLabel: 'BOS',
    selectedExpectancy: 1,
    challenger: null,
    challengerLabel: null,
    retained: false,
    retentionReason: null,
    lastUpdated: NOW,
    models: [
      {
        model: 'BOS_RETEST' as const,
        label: 'BOS',
        sampleSize: 40,
        wins: 28,
        losses: 12,
        missed: 0,
        winRatePercent: 70,
        avgRiskReward: 2,
        expectancy: 1.2,
        reliable: true,
        inSampleWinRatePercent: 70,
        outOfSampleWinRatePercent: 70,
        overfitRisk: false,
      },
    ],
  };
  const perf = validatedPerformanceFromProfile(profile);
  assert.equal(perf?.reliable, true);
  assert.equal(perf?.expectancy, 1.2);

  const overfit = validatedPerformanceFromProfile({
    ...profile,
    models: [{ ...profile.models[0], overfitRisk: true }],
  });
  assert.equal(overfit?.reliable, false);
});

test('a candidate past the top-N is tracked as a WATCH opportunity, never published', () => {
  const candidates = [
    candidate({ key: 'a', symbol: 'R_10', displayName: 'V10', engineScore: 95 }),
    candidate({ key: 'b', symbol: 'R_25', displayName: 'V25', engineScore: 85, entryDecision: decision({ symbol: 'R_25' }) }),
    candidate({ key: 'c', symbol: 'R_50', displayName: 'V50', engineScore: 75, entryDecision: decision({ symbol: 'R_50' }) }),
  ];
  const res = runCentralRanking({ ...base, candidates, topN: 1 });
  assert.deepEqual(res.ranked.map((r) => r.candidate.key), ['a']);
  assert.equal(res.ranked[0].state, 'APPROVED');
  assert.deepEqual(res.watchlist.map((w) => w.candidate.key), ['b', 'c']);
  assert.ok(res.watchlist.every((w) => w.state === 'WATCH'));
  // WATCH candidates keep ascending ranks past the published set and are never rejected.
  assert.deepEqual(res.watchlist.map((w) => w.rank), [2, 3]);
});

test('the Timeframe Alignment and Momentum reads are ADDITIONAL evidence that lifts a candidate', () => {
  const bare = runCentralRanking({
    ...base,
    candidates: [candidate({ key: 'a', engineScore: 70 })],
  });
  const enriched = runCentralRanking({
    ...base,
    candidates: [candidate({ key: 'a', engineScore: 70, alignmentScore: 100, momentumStrength: 100 })],
  });
  assert.ok(
    enriched.ranked[0].score.total > bare.ranked[0].score.total,
    `expected enrichment to lift the score (${enriched.ranked[0].score.total} vs ${bare.ranked[0].score.total})`
  );
  assert.equal(enriched.ranked[0].score.alignment, 100);
  assert.equal(enriched.ranked[0].score.momentum, 100);
  // An unread candidate contributes nothing to either new component.
  assert.equal(bare.ranked[0].score.alignment, 0);
  assert.equal(bare.ranked[0].score.momentum, 0);
});

test('a candidate with no new reads scores exactly as it did before the new modules existed', () => {
  const legacyWeights = {
    quality: 0.4,
    performance: 0.23,
    rewardRisk: 0.14,
    htfAlignment: 0.08,
    confirmation: 0.07,
    learning: 0.08,
    alignment: 0.08,
    momentum: 0.06,
  };
  const res = runCentralRanking({
    ...base,
    candidates: [candidate({ key: 'a', engineScore: 70 })],
    weights: legacyWeights,
  });
  const core = 70 * 0.4 + 0 * 0.23 + ((2.5 / 3) * 100) * 0.14 + 100 * 0.08 + 90 * 0.07 + 50 * 0.08;
  assert.equal(res.ranked[0].score.total, Math.round(core));
});
