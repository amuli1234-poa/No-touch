import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiJournalRecord,
  evaluateAiJournalRecord,
  mergeJournalSignals,
  type AiJournalRecord,
} from './aiJournal';
import { segmentPerformance, summarizePerformance, weakModulesForAutoTrading } from './aiPerformance';
import { buildAiSignal } from './aiCommon';
import type { Candle } from '../types/market';

const T0 = 1_700_000_000;

function mkSignal(id: string, overrides: Partial<Parameters<typeof buildAiSignal>[0]> = {}) {
  return buildAiSignal({
    id,
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
    confirmedBarTime: T0,
    ...overrides,
  });
}

function bar(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

test('createAiJournalRecord starts PENDING with no fabricated outcome', () => {
  const record = createAiJournalRecord(mkSignal('s1'), 'BOS & CHOCH AI');
  assert.equal(record.outcome, 'PENDING');
  assert.equal(record.settledAt, null);
  assert.equal(record.highestTargetReached, 0);
});

test('evaluateAiJournalRecord settles a WIN when the first target is reached', () => {
  const record = createAiJournalRecord(mkSignal('s1'), 'Technical AI');
  const settled = evaluateAiJournalRecord(record, [bar(T0 + 60, 100, 105, 99, 104)]);
  assert.equal(settled.outcome, 'WIN');
  assert.equal(settled.highestTargetReached, 1);
  assert.equal(settled.exitPrice, 104);
});

test('evaluateAiJournalRecord settles a LOSS when the stop is reached', () => {
  const record = createAiJournalRecord(mkSignal('s1'), 'Technical AI');
  const settled = evaluateAiJournalRecord(record, [bar(T0 + 60, 100, 101, 97, 97.5)]);
  assert.equal(settled.outcome, 'LOSS');
  assert.equal(settled.exitPrice, 98);
});

test('evaluateAiJournalRecord marks AMBIGUOUS when target and stop hit in the same candle', () => {
  const record = createAiJournalRecord(mkSignal('s1'), 'Technical AI');
  const settled = evaluateAiJournalRecord(record, [bar(T0 + 60, 100, 105, 97, 100)]);
  assert.equal(settled.outcome, 'AMBIGUOUS');
});

test('evaluateAiJournalRecord keeps a record PENDING until resolution', () => {
  const record = createAiJournalRecord(mkSignal('s1'), 'Technical AI');
  const settled = evaluateAiJournalRecord(record, [bar(T0 + 60, 100, 101, 99, 100.5)]);
  assert.equal(settled.outcome, 'PENDING');
  assert.ok(settled.mfePct >= 0);
});

test('mergeJournalSignals never duplicates and preserves existing history', () => {
  const first = mergeJournalSignals([], [{ module: 'Liquidity AI', signal: mkSignal('a') }]);
  const second = mergeJournalSignals(first, [
    { module: 'Liquidity AI', signal: mkSignal('a') },
    { module: 'FVG & Imbalance AI', signal: mkSignal('b') },
  ]);
  assert.equal(second.length, 2);
  assert.deepEqual(
    second.map((r) => r.id).sort(),
    ['a', 'b']
  );
});

test('summarizePerformance withholds win rates below a meaningful sample size', () => {
  const records: AiJournalRecord[] = ['a', 'b', 'c'].map((id) => ({
    ...createAiJournalRecord(mkSignal(id), 'Technical AI'),
    outcome: 'WIN',
  }));
  const summary = summarizePerformance(records);
  assert.equal(summary.settled, 3);
  assert.equal(summary.winRatePercent, null, 'n<5 must not report a percentage');
});

test('summarizePerformance reports a win rate once the sample is meaningful', () => {
  const wins: AiJournalRecord[] = Array.from({ length: 7 }, (_, i) => ({
    ...createAiJournalRecord(mkSignal(`w${i}`), 'Technical AI'),
    outcome: 'WIN' as const,
  }));
  const losses: AiJournalRecord[] = Array.from({ length: 3 }, (_, i) => ({
    ...createAiJournalRecord(mkSignal(`l${i}`), 'Technical AI'),
    outcome: 'LOSS' as const,
  }));
  const summary = summarizePerformance([...wins, ...losses]);
  assert.equal(summary.settled, 10);
  assert.equal(summary.winRatePercent, 70);
});

test('segmentPerformance labels small samples instead of overstating reliability', () => {
  const records: AiJournalRecord[] = [
    { ...createAiJournalRecord(mkSignal('a'), 'Technical AI'), outcome: 'WIN' },
  ];
  const segments = segmentPerformance(records, 'module');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].rating, 'DEVELOPING');
  assert.match(segments[0].note, /insufficient|small/i);
});

function settled(module: string, wins: number, losses: number): AiJournalRecord[] {
  return [
    ...Array.from({ length: wins }, (_, i) => ({
      ...createAiJournalRecord(mkSignal(`${module}-w${i}`), module),
      outcome: 'WIN' as const,
    })),
    ...Array.from({ length: losses }, (_, i) => ({
      ...createAiJournalRecord(mkSignal(`${module}-l${i}`), module),
      outcome: 'LOSS' as const,
    })),
  ];
}

test('weakModulesForAutoTrading withholds a module only once its record is proven weak', () => {
  const records = [
    ...settled('weak', 3, 7), // 30% over n=10 → held back
    ...settled('strong', 8, 2), // 80% over n=10 → allowed
    ...settled('unproven', 0, 3), // 0% but only n=3 → left in play
  ];
  const weak = weakModulesForAutoTrading(records);
  assert.ok(weak.has('weak'), 'a proven-weak module is held back');
  assert.ok(!weak.has('strong'), 'a proven-strong module is allowed');
  assert.ok(!weak.has('unproven'), 'an unproven module is not judged on a tiny sample');
});
