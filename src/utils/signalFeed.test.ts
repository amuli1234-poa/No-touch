import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalFeed } from './signalFeed';
import type { SignalFeedItem } from '../types/signals';

function item(over: Partial<SignalFeedItem> = {}): SignalFeedItem {
  return {
    id: 'id',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    direction: 'RISE',
    model: 'MODEL_1_TREND_PULLBACK_CONTINUATION',
    modelLabel: 'Model 1 — Trend Pullback Continuation',
    condition: 'STRONG_UPTREND',
    state: 'CONFIRMED',
    quality: null,
    source: 'SCANNER',
    confidence: 87,
    entryPrice: 500,
    stopLoss: 496,
    takeProfit1: 505,
    takeProfit2: null,
    riskRewardRatio: 2,
    validated: false,
    coAnalysis: null,
    createdAt: 1000,
    snapshot: null,
    target: { symbol: 'R_100', timeframe: 'M5' },
    ...over,
  };
}

test('buildSignalFeed drops null items', () => {
  const feed = buildSignalFeed([null, item(), null]);
  assert.equal(feed.length, 1);
});

test('buildSignalFeed keeps only the strongest source for the same symbol/tf/direction', () => {
  const feed = buildSignalFeed([
    item({ source: 'SCANNER', id: 'a' }),
    item({ source: 'CO-ANALYSIS', id: 'b', validated: true }),
  ]);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, 'CO-ANALYSIS');
  assert.equal(feed[0].validated, true);
});

test('buildSignalFeed keeps separate directions for the same instrument', () => {
  const feed = buildSignalFeed([
    item({ direction: 'RISE', source: 'SCANNER' }),
    item({ direction: 'FALL', source: 'ANALYSER' }),
  ]);
  assert.equal(feed.length, 2);
});

test('buildSignalFeed sorts newest first', () => {
  const feed = buildSignalFeed([
    item({ symbol: 'R_10', createdAt: 100 }),
    item({ symbol: 'R_25', createdAt: 900 }),
  ]);
  assert.equal(feed[0].symbol, 'R_25');
});
