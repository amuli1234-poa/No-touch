import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiSignal } from '../types/aiModule';
import type { DsSignal } from '../types/demandSupply';
import type { EngineSignal } from '../types/engine';
import type { TrendlineSignal } from '../types/trendline';
import type { RankedSetup } from '../types/ranking';
import {
  buildRankedSetups,
  buildRanking,
  rankSetups,
  topRankedSetups,
} from './signalRanking';

function engineSignal(over: Partial<EngineSignal> = {}): EngineSignal {
  return {
    id: 'e1',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    direction: 'RISE',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    modelLabel: 'Model 2',
    condition: 'STRONG_UPTREND',
    analysisTimeframe: 'M5',
    quality: {
      structure: 20,
      levelZone: 18,
      entryConfirmation: 24,
      momentum: 14,
      multiTimeframe: 9,
      availableSpace: 8,
      total: 90,
      tier: 'EXCEPTIONAL',
      publishable: true,
    },
    entryPrice: 100,
    entryZone: null,
    invalidationPrice: 98,
    invalidationCondition: 'Close below 98.',
    target1: 106,
    target2: 110,
    stopLoss: 98,
    riskRewardRatio: 3,
    confirmationExplanation: 'Breakout retested.',
    bosChochEvidence: ['BOS'],
    supportResistance: [98, 106],
    momentumEvidence: ['Displacement'],
    reasons: ['Structure aligned', 'Fresh zone'],
    invalidations: [],
    availableSpaceAtr: 2,
    availableSpaceLabel: '2x ATR',
    indicators: {
      ema20: null,
      ema50: null,
      rsi14: null,
      macdLine: null,
      macdSignal: null,
      macdHistogram: null,
      adx14: null,
      trendConfirm: 'NEUTRAL',
      momentumConfirm: 'NEUTRAL',
      strengthConfirm: false,
      notes: [],
    },
    state: 'CONFIRMED',
    instrumentLabel: 'Volatility',
    explanation: 'Best fit.',
    createdAt: 1_700_000_000_000,
    confirmedBarTime: 1_700_000_000,
    lastUpdated: 1_700_000_000_000,
    ...over,
  };
}

function trendlineSignal(over: Partial<TrendlineSignal> = {}): TrendlineSignal {
  return {
    id: 't1',
    symbol: 'JD10',
    displayName: 'Jump 10 Index',
    marketFamily: 'JUMP',
    precision: 2,
    direction: 'FALL',
    model: 'TRENDLINE_BREAKOUT_RETEST',
    modelLabel: 'Trendline break & retest',
    condition: 'DOWNTREND',
    structureTimeframe: 'M15',
    trendTimeframe: 'M7',
    setupTimeframe: 'M5',
    confirmTimeframe: 'M3',
    entryTimeframe: 'M1',
    score: 88,
    entryPrice: 500,
    stopLoss: 505,
    takeProfit: 485,
    invalidationPrice: 505,
    invalidationCondition: 'Close above 505.',
    riskRewardRatio: 3,
    trendline: {} as TrendlineSignal['trendline'],
    rejection: {} as TrendlineSignal['rejection'],
    zone: null,
    entryConfirmation: {} as TrendlineSignal['entryConfirmation'],
    continuationBos: null,
    reasons: ['Descending trendline held'],
    confirmations: [],
    m15Context: '',
    m5Confirmation: '',
    m1Confirmation: '',
    status: 'CONFIRMED',
    createdAt: 1_700_000_100_000,
    confirmedBarTime: 1_700_000_100,
    lastUpdated: 1_700_000_100_000,
    ...over,
  };
}

function dsSignal(over: Partial<DsSignal> = {}): DsSignal {
  return {
    id: 'd1',
    symbol: 'stpRNG',
    displayName: 'Step Index 100',
    marketFamily: 'STEP',
    precision: 2,
    direction: 'RISE',
    model: 'DS_FRESH_REJECTION',
    modelLabel: 'Zone rejection',
    structureTimeframe: 'M15',
    trendTimeframe: 'M7',
    setupTimeframe: 'M5',
    confirmTimeframe: 'M3',
    entryTimeframe: 'M1',
    score: 82,
    zoneQuality: 70,
    entryPrice: 1000,
    entryZoneLow: 998,
    entryZoneHigh: 1002,
    stopLoss: 994,
    takeProfit1: 1012,
    takeProfit2: 1018,
    takeProfit3: null,
    invalidationPrice: 994,
    invalidationCondition: 'Close below 994.',
    riskRewardRatio: 2,
    zone: {} as DsSignal['zone'],
    confirmation: {} as DsSignal['confirmation'],
    setupStage: 'AT_ZONE',
    reasons: ['Demand zone held'],
    confirmations: [],
    m15Context: '',
    m5Setup: '',
    m1Confirmation: '',
    status: 'CONFIRMED',
    createdAt: 1_700_000_200_000,
    confirmedBarTime: 1_700_000_200,
    lastUpdated: 1_700_000_200_000,
    ...over,
  };
}

function aiSignal(over: Partial<AiSignal> = {}): AiSignal {
  return {
    id: 'a1',
    symbol: '1HZ100V',
    displayName: 'Volatility 100 (1s) Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    direction: 'RISE',
    modelId: 'BOS_CONTINUATION',
    modelLabel: 'BOS continuation',
    strategyLabel: 'Momentum',
    status: 'CONFIRMED',
    lifecycle: 'CONFIRMED',
    score: 95,
    condition: 'STRONG_BULLISH',
    entryPrice: 2000,
    entryZoneLow: 1998,
    entryZoneHigh: 2002,
    stopLoss: 1990,
    takeProfit1: 2020,
    takeProfit2: 2030,
    takeProfit3: null,
    riskRewardRatio: 2,
    invalidationCondition: 'Close below 1990.',
    reasons: ['BOS confirmed', 'Displacement up'],
    confirmations: ['Higher high'],
    timeframes: [{ timeframe: 'M5', label: 'M5', detail: 'bullish', tone: 'bull' }],
    levels: [],
    createdAt: 1_700_000_300_000,
    confirmedBarTime: 1_700_000_300,
    lastUpdated: 1_700_000_300_000,
    ...over,
  };
}

const emptyInput = { engineSignals: [], trendlineSignals: [], dsSignals: [], aiSignals: [] };

test('ranking: aggregates signals from every engine into one ranked list', () => {
  const ranked = buildRanking({
    engineSignals: [engineSignal()],
    trendlineSignals: [trendlineSignal()],
    dsSignals: [dsSignal()],
    aiSignals: [{ moduleLabel: 'BOS & CHOCH AI', signal: aiSignal() }],
  });
  assert.equal(ranked.length, 4);
  // Strongest (95) first, then 90, 88, 82.
  assert.deepEqual(
    ranked.map((s) => s.score),
    [95, 90, 88, 82]
  );
  assert.equal(ranked[0].sourceLabel, 'BOS & CHOCH AI');
  assert.equal(ranked[1].sourceLabel, 'Market Scanner');
});

test('ranking: Jump and Step setups are ranked alongside volatility indices', () => {
  const ranked = buildRanking({
    ...emptyInput,
    trendlineSignals: [trendlineSignal()],
    dsSignals: [dsSignal()],
  });
  assert.equal(ranked.length, 2);
  const families = ranked.map((s) => s.marketFamily).sort();
  assert.deepEqual(families, ['JUMP', 'STEP']);
});

test('ranking: duplicate setups (same engine/symbol/direction/model) collapse to one', () => {
  const a = engineSignal({ id: 'x1', createdAt: 1_700_000_000_000 });
  const b = engineSignal({ id: 'x2', createdAt: 1_700_000_500_000 });
  const setups = buildRankedSetups({ ...emptyInput, engineSignals: [a, b] });
  assert.equal(setups.length, 1);
});

test('ranking: a higher-scoring duplicate replaces the lower one', () => {
  const low = engineSignal({
    id: 'lo',
    quality: { ...engineSignal().quality, total: 86 },
  });
  const high = engineSignal({
    id: 'hi',
    quality: { ...engineSignal().quality, total: 97 },
  });
  const [setup] = buildRankedSetups({ ...emptyInput, engineSignals: [low, high] });
  assert.equal(setup.score, 97);
});

test('ranking: identical scores break on risk:reward, then recency', () => {
  const a = engineSignal({ id: 'a', riskRewardRatio: 2, symbol: 'R_10', displayName: 'Volatility 10 Index' });
  const b = engineSignal({ id: 'b', riskRewardRatio: 4, symbol: 'R_25', displayName: 'Volatility 25 Index' });
  const ranked = rankSetups(buildRankedSetups({ ...emptyInput, engineSignals: [a, b] }));
  assert.equal(ranked[0].symbol, 'R_25');
});

test('ranking: topRankedSetups keeps only the strongest N above the score gate', () => {
  const ranked = buildRanking({
    engineSignals: [engineSignal()],
    trendlineSignals: [trendlineSignal()],
    dsSignals: [dsSignal()],
    aiSignals: [{ moduleLabel: 'M', signal: aiSignal() }],
  });
  const top3 = topRankedSetups(ranked, 3);
  assert.equal(top3.length, 3);
  assert.deepEqual(top3.map((s) => s.score), [95, 90, 88]);
  const gated = topRankedSetups(ranked, 5, 85);
  assert.deepEqual(gated.map((s) => s.score), [95, 90, 88]);
});

test('ranking: empty input yields an empty ranking', () => {
  assert.deepEqual(buildRanking(emptyInput), []);
});

test('ranking: every ranked setup carries a stable key and no invented levels', () => {
  const [setup] = buildRanking({ ...emptyInput, engineSignals: [engineSignal()] });
  assert.ok(setup.key.includes('PRICE_ACTION'));
  assert.ok(setup.key.includes('R_100'));
  assert.equal(setup.entryPrice, 100);
  assert.equal(setup.stopLoss, 98);
  assert.equal(setup.takeProfit1, 106);
});

// Keep the unused import from being flagged while documenting the shape contract.
const _typeCheck: RankedSetup = buildRanking(emptyInput)[0] as RankedSetup;
void _typeCheck;
