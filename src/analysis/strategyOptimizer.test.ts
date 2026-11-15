import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecommendations,
  DEFAULT_COST_MODEL,
  evaluateStrategies,
  extendStats,
  MIN_STATISTICAL_SAMPLE,
  parameterSweep,
  rankEvaluations,
  rateStrategy,
  type ExtendedStats,
  type StrategyEvaluation,
} from './strategyOptimizer';
import { computeBacktestStats } from './backtest';
import type { BacktestTrade } from '../types/training';

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    id: 't',
    symbol: 'R_75',
    displayName: 'Volatility 75',
    marketFamily: 'VOLATILITY' as const,
    timeframe: 'M5' as const,
    model: 'MODEL_2_BREAKOUT_AND_RETEST' as const,
    modelLabel: 'M2',
    direction: 'RISE' as const,
    condition: 'STRONG_UPTREND' as const,
    qualityScore: 90,
    entry: 100,
    stopLoss: 98,
    finalTakeProfit: 106,
    exitPrice: 106,
    status: 'TARGET_HIT' as const,
    realizedRr: 3,
    maxFavourableExcursionPct: 6,
    maxAdverseExcursionPct: 0.5,
    barsHeld: 4,
    confirmedBarTime: 0,
    settledBarTime: 0,
    tpAdjustments: [],
    takeProfit1: 104,
    takeProfit2: 106,
    takeProfit3: 110,
    highestTargetReached: 2,
    ambiguous: false,
    ...overrides,
  };
}

function statsFor(trades: BacktestTrade[], atr = 2): ExtendedStats {
  return extendStats(computeBacktestStats(trades), trades, atr, DEFAULT_COST_MODEL);
}

test('extendStats computes expectancy from the actual win/loss mix', () => {
  const trades = [
    trade({ status: 'TARGET_HIT', realizedRr: 3 }),
    trade({ status: 'TARGET_HIT', realizedRr: 3 }),
    trade({ status: 'STOP_HIT', realizedRr: -1, exitPrice: 98, highestTargetReached: 0 }),
    trade({ status: 'STOP_HIT', realizedRr: -1, exitPrice: 98, highestTargetReached: 0 }),
  ];
  const stats = statsFor(trades);
  assert.equal(stats.averageWinR, 3);
  assert.equal(stats.averageLossR, -1);
  // 50% × 3 + 50% × (-1) = 1R per setup.
  assert.equal(stats.expectancyR, 1);
  assert.equal(stats.winRatePercent, 50);
  assert.equal(stats.tp1Rate, 50);
  assert.equal(stats.tp2Rate, 50);
  assert.equal(stats.tp3Rate, 0);
  assert.equal(stats.stopRate, 50);
  assert.equal(stats.averageBarsHeld, 4);
});

test('extendStats withholds every rate when nothing settled', () => {
  const stats = statsFor([trade({ status: 'PENDING', realizedRr: null, exitPrice: null })]);
  assert.equal(stats.expectancyR, null);
  assert.equal(stats.tp1Rate, null);
  assert.equal(stats.winRatePercent, null);
});

test('cost-aware expectancy is strictly lower than the raw expectancy', () => {
  const trades = [
    trade({ status: 'TARGET_HIT', realizedRr: 3 }),
    trade({ status: 'STOP_HIT', realizedRr: -1, exitPrice: 98, highestTargetReached: 0 }),
  ];
  const stats = statsFor(trades, 2);
  assert.ok(stats.expectancyR !== null && stats.expectancyAfterCostR !== null);
  assert.ok(stats.expectancyAfterCostR! < stats.expectancyR!);
});

test('rateStrategy never promotes on a small sample or an unvalidated report', () => {
  const small = statsFor([trade(), trade()]);
  // A tiny overall sample cannot be rated at all.
  assert.equal(rateStrategy({ outOfSample: small, overall: small, validated: false }), 'UNRELIABLE');

  // An adequate overall sample with an unvalidated out-of-sample split is DEVELOPING.
  const adequate = statsFor(Array.from({ length: MIN_STATISTICAL_SAMPLE }, () => trade()));
  assert.equal(
    rateStrategy({ outOfSample: small, overall: adequate, validated: false }),
    'DEVELOPING'
  );

  const empty = statsFor([]);
  assert.equal(rateStrategy({ outOfSample: empty, overall: empty, validated: false }), 'UNRELIABLE');
});

test('rateStrategy requires consistency, not just a high win rate', () => {
  // High win rate but negative expectancy (tiny wins, big losses) must NOT be EXCELLENT.
  const many = Array.from({ length: 12 }, () => trade({ status: 'TARGET_HIT', realizedRr: 0.1 }));
  const positive = statsFor(many);
  const rating = rateStrategy({ outOfSample: positive, overall: positive, validated: true });
  assert.notEqual(rating, 'EXCELLENT');

  const strong = Array.from({ length: 12 }, () => trade({ status: 'TARGET_HIT', realizedRr: 3 }));
  const strongStats = statsFor(strong);
  assert.equal(
    rateStrategy({ outOfSample: strongStats, overall: strongStats, validated: true }),
    'EXCELLENT'
  );
});

test('parameterSweep refuses to recommend a value on a thin sample', () => {
  const sweep = parameterSweep({
    parameter: 'MIN_QUALITY',
    values: [70, 80, 90],
    evaluationsByValue: () => statsFor([trade()]),
  });
  assert.equal(sweep.recommendedValue, null);
  assert.ok(sweep.notes.some((n) => n.includes('curve fitting')));
});

test('parameterSweep recommends the best value once the sample is adequate', () => {
  const sweep = parameterSweep({
    parameter: 'MIN_QUALITY',
    values: [70, 80, 90],
    evaluationsByValue: (value) =>
      value === 80
        ? statsFor(Array.from({ length: MIN_STATISTICAL_SAMPLE }, () => trade({ status: 'TARGET_HIT', realizedRr: 3 })))
        : statsFor(Array.from({ length: MIN_STATISTICAL_SAMPLE }, () => trade({ status: 'STOP_HIT', realizedRr: -1, exitPrice: 98, highestTargetReached: 0 }))),
  });
  assert.equal(sweep.recommendedValue, 80);
});

function evaluation(overrides: Partial<StrategyEvaluation> = {}): StrategyEvaluation {
  const base = statsFor([trade()]);
  return {
    symbol: 'R_75',
    displayName: 'Volatility 75',
    marketFamily: 'VOLATILITY' as const,
    timeframe: 'M5' as const,
    model: 'MODEL_2_BREAKOUT_AND_RETEST' as const,
    modelLabel: 'M2',
    inSample: base,
    outOfSample: base,
    overall: base,
    rating: 'GOOD',
    validated: true,
    notes: [],
    ...overrides,
  };
}

test('buildRecommendations flags unreliable models and always requires approval', () => {
  const recs = buildRecommendations([
    evaluation({
      rating: 'UNRELIABLE',
      outOfSample: { ...statsFor([trade({ status: 'STOP_HIT', realizedRr: -1, exitPrice: 98 })]), expectancyR: -1 },
    }),
  ]);
  assert.ok(recs.some((r) => r.id.startsWith('retest-')));
  for (const r of recs) assert.equal(r.requiresApproval, true);
});

test('buildRecommendations never fabricates advice with no evidence', () => {
  const recs = buildRecommendations([]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, 'insufficient-evidence');
});

test('rankEvaluations orders EXCELLENT before WEAK', () => {
  const ranked = rankEvaluations([
    evaluation({ modelLabel: 'weak', rating: 'WEAK' }),
    evaluation({ modelLabel: 'excellent', rating: 'EXCELLENT' }),
    evaluation({ modelLabel: 'developing', rating: 'DEVELOPING' }),
  ]);
  assert.deepEqual(
    ranked.map((e) => e.rating),
    ['EXCELLENT', 'DEVELOPING', 'WEAK']
  );
});

test('evaluateStrategies never fabricates results without candles', () => {
  const evaluations = evaluateStrategies({
    symbol: 'R_50',
    displayName: 'Volatility 50',
    marketFamily: 'VOLATILITY' as const,
    precision: 2,
    timeframe: 'M5',
    candles: [],
    models: ['MODEL_2_BREAKOUT_AND_RETEST' as const],
  });
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].overall.totalSetups, 0);
  assert.equal(evaluations[0].rating, 'UNRELIABLE');
  assert.equal(evaluations[0].validated, false);
});
