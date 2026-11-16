import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type { ManagedRankedSetup, RankedSetup } from '../types/ranking';
import { advanceSetupLifecycles, evaluateSetupLifecycle, isSettledStatus } from './setupLifecycle';

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

function setup(over: Partial<RankedSetup> = {}): RankedSetup {
  return {
    key: 'PRICE_ACTION:R_100:M5:RISE:MODEL_2',
    source: 'PRICE_ACTION',
    sourceLabel: 'Market Scanner',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    precision: 2,
    direction: 'RISE',
    modelLabel: 'Model 2',
    score: 90,
    entryPrice: 100,
    stopLoss: 98,
    takeProfit1: 106,
    takeProfit2: 110,
    riskRewardRatio: 3,
    reasons: ['Structure aligned'],
    confirmedBarTime: 1000,
    createdAt: 1_000_000,
    sequence: 0,
    ...over,
  };
}

test('lifecycle: a RISE setup completes when its target is reached', () => {
  const candles = [candle(1000, 100, 102, 99, 101), candle(1300, 101, 107, 100, 106)];
  const verdict = evaluateSetupLifecycle(setup(), candles);
  assert.equal(verdict.status, 'COMPLETED');
  assert.equal(verdict.outcome, 'TARGET_HIT');
  assert.equal(verdict.exitPrice, 106);
  assert.equal(verdict.settledAt, 1300);
});

test('lifecycle: a RISE setup is invalidated when its stop is hit', () => {
  const candles = [candle(1000, 100, 101, 99, 100), candle(1300, 100, 100.5, 97, 97.5)];
  const verdict = evaluateSetupLifecycle(setup(), candles);
  assert.equal(verdict.status, 'INVALIDATED');
  assert.equal(verdict.outcome, 'STOP_HIT');
  assert.equal(verdict.exitPrice, 98);
});

test('lifecycle: a FALL setup completes on a lower target and stops on an upper stop', () => {
  const base = setup({
    direction: 'FALL',
    entryPrice: 100,
    stopLoss: 103,
    takeProfit1: 94,
  });
  assert.equal(evaluateSetupLifecycle(base, [candle(1300, 100, 100, 93, 94)]).status, 'COMPLETED');
  assert.equal(evaluateSetupLifecycle(base, [candle(1300, 100, 104, 99, 103.5)]).status, 'INVALIDATED');
});

test('lifecycle: the stop wins when both stop and target sit inside one bar', () => {
  const candles = [candle(1300, 100, 107, 97, 100)];
  const verdict = evaluateSetupLifecycle(setup(), candles);
  assert.equal(verdict.status, 'INVALIDATED');
  assert.equal(verdict.outcome, 'STOP_HIT');
});

test('lifecycle: bars before the confirmation bar cannot settle a setup', () => {
  const candles = [candle(700, 100, 107, 97, 106), candle(1300, 100, 101, 99, 100)];
  const verdict = evaluateSetupLifecycle(setup(), candles);
  assert.equal(verdict.status, 'ACTIVE');
});

test('lifecycle: a setup with no target hit or stop hit stays ACTIVE', () => {
  const candles = [candle(1300, 100, 102, 99, 101)];
  assert.equal(evaluateSetupLifecycle(setup(), candles).status, 'ACTIVE');
});

test('advanceSetupLifecycles splits setups into active and settled', () => {
  const active = setup({ key: 'k-active', symbol: 'R_100' });
  const won = setup({ key: 'k-won', symbol: 'R_25', takeProfit1: 106 });
  const lost = setup({ key: 'k-lost', symbol: 'JD10', stopLoss: 98 });
  const bySymbol = new Map<string, Candle[]>([
    ['R_100', [candle(1300, 100, 102, 99, 101)]],
    ['R_25', [candle(1300, 100, 107, 99, 106)]],
    ['JD10', [candle(1300, 100, 100.5, 96, 97)]],
  ]);
  const { active: a, settled: s } = advanceSetupLifecycles([active, won, lost], bySymbol);
  assert.deepEqual(a.map((x) => x.key), ['k-active']);
  assert.deepEqual(s.map((x) => x.key).sort(), ['k-lost', 'k-won']);
  assert.equal(s.find((x) => x.key === 'k-won')!.outcome, 'TARGET_HIT');
  assert.equal(s.find((x) => x.key === 'k-lost')!.outcome, 'STOP_HIT');
});

test('a settled setup is never re-opened, even if fresh candles no longer show the hit', () => {
  const prior: ManagedRankedSetup = {
    ...setup({ key: 'k' }),
    status: 'INVALIDATED',
    wasActive: true,
    settledAt: 1300,
    outcome: 'STOP_HIT',
  };
  const previous = new Map([[prior.key, prior]]);
  // Fresh candles would read ACTIVE if evaluated cold — the prior terminal state wins.
  const { active, settled } = advanceSetupLifecycles(
    [setup({ key: 'k' })],
    new Map([['R_100', [candle(1300, 100, 102, 99, 101)]]]),
    previous
  );
  assert.equal(active.length, 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'INVALIDATED');
});

test('isSettledStatus flags terminal statuses only', () => {
  assert.equal(isSettledStatus('ACTIVE'), false);
  assert.equal(isSettledStatus('COMPLETED'), true);
  assert.equal(isSettledStatus('INVALIDATED'), true);
});
