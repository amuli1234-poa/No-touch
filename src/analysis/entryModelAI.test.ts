import test from 'node:test';
import assert from 'node:assert/strict';
import type { EntryModelSetupInput } from '../types/entryModelAI';
import {
  aggregateEntryModelPerformance,
  evaluateEntryModel,
  evaluateEntryModels,
  historicalBonusFromPerformance,
} from './entryModelAI';

function setup(over: Partial<EntryModelSetupInput> = {}): EntryModelSetupInput {
  return {
    key: 'k1',
    sourceLabel: 'BOS & CHOCH AI',
    symbol: 'R_50',
    displayName: 'Volatility 50 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    direction: 'RISE',
    originatingModelLabel: 'BOS_RETEST',
    score: 88,
    entryPrice: 1000,
    entryZoneLow: 998,
    entryZoneHigh: 1002,
    stopLoss: 990,
    takeProfit1: 1020,
    takeProfit2: 1030,
    takeProfit3: 1040,
    riskRewardRatio: 2.5,
    reasons: ['Break of structure confirmed', 'Retest holding'],
    evidence: ['BOS at 1001', 'M1 bullish close'],
    confirmedBarTime: Math.floor(Date.now() / 1000) - 30,
    ...over,
  };
}

const ctx = { price: 1000, atr: 5, htfDirection: 'RISE' as const };

test('selects the entry model matching the originating strategy', () => {
  const d = evaluateEntryModel(setup(), ctx);
  assert.equal(d.model, 'BOS_RETEST');
  assert.equal(d.originatingStrategy, 'BOS & CHOCH AI');
  assert.equal(d.state, 'CONFIRMED');
  assert.ok(d.qualityScore > 50);
  assert.ok(d.explanation.toLowerCase().includes('bos'));
});

test('preserves the originating detection logic — a trendline setup selects a trendline model', () => {
  const d = evaluateEntryModel(
    setup({ originatingModelLabel: 'TRENDLINE_REJECTION', reasons: ['Trendline rejection'], evidence: ['line rejection'], entryPrice: 1000, entryZoneLow: 999, entryZoneHigh: 1001 }),
    ctx
  );
  assert.equal(d.model, 'TRENDLINE_REJECTION_CONTINUATION');
});

test('a watching setup far from its entry area is WATCHING, not CONFIRMED', () => {
  // RISE setup: price still below the entry zone means it has not arrived yet.
  const d = evaluateEntryModel(setup(), { price: 995, atr: 5, htfDirection: 'RISE' });
  assert.equal(d.state, 'WATCHING');
});

test('a setup whose price moved beyond the entry area is MISSED', () => {
  const d = evaluateEntryModel(setup(), { price: 1050, atr: 5, htfDirection: 'RISE' });
  assert.equal(d.state, 'MISSED');
  assert.ok(d.qualityScore <= 30);
});

test('price beyond the stop invalidates the setup regardless of model support', () => {
  const d = evaluateEntryModel(setup(), { price: 985, atr: 5, htfDirection: 'RISE' });
  assert.equal(d.state, 'INVALIDATED');
  assert.ok(d.qualityScore <= 30);
});

test('a setup with no recognisable evidence yields no manufactured model', () => {
  const d = evaluateEntryModel(
    setup({ originatingModelLabel: 'MYSTERY', reasons: [], evidence: [], entryPrice: 1000, entryZoneLow: 999, entryZoneHigh: 1001 }),
    { price: 995, atr: 5, htfDirection: null }
  );
  assert.equal(d.model, null);
  assert.equal(d.state, 'WATCHING');
  assert.ok(d.explanation.toLowerCase().includes('standing aside'));
});

test('conflicting HTF direction lowers quality and is called out', () => {
  const aligned = evaluateEntryModel(setup(), { price: 1000, atr: 5, htfDirection: 'RISE' });
  const opposed = evaluateEntryModel(setup(), { price: 1000, atr: 5, htfDirection: 'FALL' });
  assert.ok(opposed.qualityScore < aligned.qualityScore);
  assert.ok(opposed.explanation.toLowerCase().includes('does not align'));
});

test('compatible reinforcing models are combined, never the whole library', () => {
  const d = evaluateEntryModel(
    setup({
      originatingModelLabel: 'BOS_RETEST',
      reasons: ['Break of structure', 'Retest', 'Displacement close'],
      evidence: ['BOS', 'displacement', 'strong close'],
    }),
    ctx
  );
  assert.ok(d.combinedWith.length <= 2);
  assert.ok(d.combinedWith.includes('DISPLACEMENT_REJECTION') || d.combinedWith.length === 0);
});

test('a swing-high/low rejection setup selects the swing model', () => {
  const d = evaluateEntryModel(
    setup({ originatingModelLabel: 'SWING_LOW_REJECTION', reasons: ['Swing low rejection'], evidence: ['swing low held'] }),
    ctx
  );
  assert.equal(d.model, 'SWING_HIGH_LOW_REJECTION');
});

test('evaluateEntryModels skips setups without a market context', () => {
  const contexts = new Map([['k1', ctx]]);
  const out = evaluateEntryModels([setup(), setup({ key: 'k2' })], contexts);
  assert.equal(out.length, 1);
});

test('performance aggregation withholds win rate below a meaningful sample', () => {
  const records = Array.from({ length: 5 }, () => ({
    model: 'BOS_RETEST' as const,
    modelLabel: 'BOS & Retest Entry',
    symbol: 'R_50',
    displayName: 'V50',
    marketFamily: 'VOLATILITY' as const,
    timeframe: 'M5' as const,
    direction: 'RISE' as const,
    riskRewardRatio: 2,
    outcome: 'TARGET_HIT' as const,
    settledAt: 1,
  }));
  const perf = aggregateEntryModelPerformance(records);
  assert.equal(perf[0].winRatePercent, null);
  assert.equal(perf[0].reliable, false);
  assert.equal(perf[0].avgRiskReward, 2);
});

test('performance aggregation reports a reliable win rate once the sample is large enough', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({
    model: 'BOS_RETEST' as const,
    modelLabel: 'BOS & Retest Entry',
    symbol: 'R_50',
    displayName: 'V50',
    marketFamily: 'VOLATILITY' as const,
    timeframe: 'M5' as const,
    direction: 'RISE' as const,
    riskRewardRatio: 2,
    outcome: (i < 14 ? 'TARGET_HIT' : 'STOP_HIT') as 'TARGET_HIT' | 'STOP_HIT',
    settledAt: 1,
  }));
  const perf = aggregateEntryModelPerformance(records);
  assert.equal(perf[0].reliable, true);
  assert.equal(perf[0].winRatePercent, 70);
});

test('historical bonus rewards reliable winners and penalises reliable losers', () => {
  const bonus = historicalBonusFromPerformance([
    { model: 'BOS_RETEST', label: 'x', sampleSize: 20, wins: 14, losses: 6, missed: 0, winRatePercent: 70, avgRiskReward: 2, reliable: true },
    { model: 'FVG_ENTRY', label: 'y', sampleSize: 20, wins: 6, losses: 14, missed: 0, winRatePercent: 30, avgRiskReward: 1, reliable: true },
    { model: 'ORDER_BLOCK_MITIGATION', label: 'z', sampleSize: 5, wins: 5, losses: 0, missed: 0, winRatePercent: null, avgRiskReward: 2, reliable: false },
  ]);
  assert.equal(bonus.BOS_RETEST, 8);
  assert.equal(bonus.FVG_ENTRY, -6);
  assert.equal(bonus.ORDER_BLOCK_MITIGATION, undefined);
});

test('a genuinely stronger historical model is preferred when evidence ties', () => {
  const tie = setup({
    originatingModelLabel: 'RETEST',
    reasons: ['retest', 'fvg', 'imbalance'],
    evidence: ['fvg'],
  });
  const plain = evaluateEntryModel(tie, { price: 1000, atr: 5, htfDirection: 'RISE' });
  const learned = evaluateEntryModel(tie, {
    price: 1000,
    atr: 5,
    htfDirection: 'RISE',
    historicalBonus: { FVG_ENTRY: 8 },
  });
  const plainFvg = plain.evaluations.find((e) => e.kind === 'FVG_ENTRY')!;
  const learnedFvg = learned.evaluations.find((e) => e.kind === 'FVG_ENTRY')!;
  assert.ok(learnedFvg.supportScore > plainFvg.supportScore);
});
