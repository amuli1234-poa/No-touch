import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceManagedSignal,
  assertSignalIntegrity,
  createManagedSignal,
  liveTakeProfitIsValid,
} from './signalManagement';
import {
  applyTakeProfit,
  isValidTakeProfit,
  takeProfitAheadOfPrice,
} from './takeProfit';
import { backtestModel, backtestModels, computeBacktestStats } from './backtest';
import { aggregateTrades, collectTrades, segmentTrades } from './training';
import { managedSignalFromFeed } from './signalManagement';
import { scoreCandidate } from './qualityScore';
import type { EntryModelCandidate } from '../types/engine';
import type { Candle } from '../types/market';
import type { ManagedSignal } from '../types/training';

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

function makeCandidate(overrides: Partial<EntryModelCandidate> = {}): EntryModelCandidate {
  const base: EntryModelCandidate = {
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    modelLabel: 'Model 2 — Breakout & Retest',
    direction: 'RISE',
    entryPrice: 100,
    structuralLevelPrice: 99.5,
    retestPrice: 99.5,
    retestTime: 1_700_000_000,
    invalidationPrice: 98,
    invalidationCondition: 'Close below 98 invalidates.',
    target1: 106,
    target2: 110,
    stopLoss: 98,
    riskRewardRatio: 3,
    confirmationExplanation: 'Breakout above 99.5 retested and held with a bullish close.',
    bosChochEvidence: ['BOS above 99.5'],
    supportResistance: [99.5, 106],
    momentumEvidence: ['Bullish displacement'],
    reasons: ['Structure aligned'],
    invalidations: ['Close below 98'],
    availableSpaceAtr: 2,
    availableSpaceLabel: '2x ATR to 106',
    scores: {
      structure: 20,
      levelZone: 20,
      entryConfirmation: 24,
      momentum: 14,
      multiTimeframe: 8,
      availableSpace: 10,
    },
  };
  return { ...base, ...overrides };
}

function makeSignal(overrides: Partial<ManagedSignal> = {}): ManagedSignal {
  const candidate = makeCandidate();
  const signal = createManagedSignal({
    candidate,
    id: 'test-signal',
    confirmedBarTime: 1_700_000_000,
    createdAt: 1_700_000_000_000,
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    precision: 2,
    condition: 'STRONG_UPTREND',
    quality: scoreCandidate(candidate),
  });
  return { ...signal, ...overrides };
}

test('entry and stop-loss are locked and never moved by take-profit updates', () => {
  const signal = makeSignal();
  const entryBefore = signal.entry;
  const slBefore = signal.stopLoss;
  const applied = applyTakeProfit(
    { direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit },
    108,
    'Strong continuation',
    101,
    1_700_000_300_000,
    1_700_000_300,
    signal.tpHistory
  );
  assert.ok(applied);
  assert.equal(applied!.signal.entry, entryBefore);
  assert.equal(applied!.signal.stopLoss, slBefore);
  assert.equal(applied!.signal.takeProfit, 108);
  assert.equal(applied!.history.at(-1)?.reason, 'Strong continuation');
});

test('a take-profit behind market price is rejected', () => {
  assert.equal(takeProfitAheadOfPrice('RISE', 99, 100), false);
  assert.equal(takeProfitAheadOfPrice('FALL', 101, 100), false);
  const signal = makeSignal();
  assert.equal(isValidTakeProfit(signal, 99, 100), false);
  assert.equal(isValidTakeProfit(signal, 101, 100), true);
});

test('a take-profit crossing the locked entry or stop-loss is rejected', () => {
  const signal = makeSignal(); // entry 100, SL 98, RISE
  assert.equal(liveTakeProfitIsValid(signal, 100, 100), false); // at entry
  assert.equal(liveTakeProfitIsValid(signal, 98, 99), false); // at stop
  assert.equal(liveTakeProfitIsValid(signal, 104, 100), true);
});

test('the initial take-profit is set at publication', () => {
  const signal = makeSignal();
  assert.equal(signal.takeProfit, 106);
  assert.equal(signal.tpHistory.length, 1);
  assert.equal(signal.tpHistory[0].kind, 'INITIAL');
});

test('a PENDING signal becomes MISSED when price moves beyond its entry zone', () => {
  const signal = makeSignal(); // entry zone ~[99.5, 100]
  const bars = [candle(1_700_000_000, 100, 100.2, 99.8, 100), candle(1_700_000_300, 100, 105, 104.5, 104.8)];
  const advanced = advanceManagedSignal(signal, bars[1], {
    candles: bars,
    supportResistance: [],
    supplyDemand: [],
    precision: 2,
    now: 0,
  });
  assert.equal(advanced.status, 'MISSED');
});

test('a PENDING signal becomes ACTIVE when the entry zone is filled', () => {
  const signal = makeSignal();
  const bars = [candle(1_700_000_000, 100, 100.2, 99.8, 100), candle(1_700_000_300, 100.1, 100.3, 99.6, 100)];
  const advanced = advanceManagedSignal(signal, bars[1], {
    candles: bars,
    supportResistance: [],
    supplyDemand: [],
    precision: 2,
    now: 0,
  });
  assert.equal(advanced.status, 'ACTIVE');
});

test('an ACTIVE signal hits its target when price reaches the take-profit', () => {
  const signal = makeSignal({ status: 'ACTIVE', filledAt: 1_700_000_000 });
  const bars = [
    candle(1_700_000_000, 100, 100.5, 99.9, 100.4),
    candle(1_700_000_300, 100.4, 106.5, 100.3, 106.2),
  ];
  const advanced = advanceManagedSignal(signal, bars[1], {
    candles: bars,
    supportResistance: [],
    supplyDemand: [],
    precision: 2,
    now: 0,
  });
  assert.equal(advanced.status, 'TARGET_HIT');
  assert.equal(advanced.exitPrice, 106);
  assert.equal(advanced.entry, 100);
  assert.equal(advanced.stopLoss, 98);
});

test('a bar spanning both stop and target is settled as a loss (conservative)', () => {
  const signal = makeSignal({ status: 'ACTIVE', filledAt: 1_700_000_000 });
  const bars = [
    candle(1_700_000_000, 100, 100.5, 99.9, 100.4),
    candle(1_700_000_300, 100.4, 107, 97, 100),
  ];
  const advanced = advanceManagedSignal(signal, bars[1], {
    candles: bars,
    supportResistance: [],
    supplyDemand: [],
    precision: 2,
    now: 0,
  });
  assert.equal(advanced.status, 'STOP_HIT');
  assert.equal(advanced.exitPrice, 98);
});

test('an ACTIVE signal is invalidated when price closes beyond the locked stop', () => {
  const signal = makeSignal({ status: 'ACTIVE', filledAt: 1_700_000_000 });
  const bars = [
    candle(1_700_000_000, 100, 100.2, 99.9, 100),
    candle(1_700_000_300, 100, 100.1, 97.5, 97.8),
  ];
  const advanced = advanceManagedSignal(signal, bars[1], {
    candles: bars,
    supportResistance: [],
    supplyDemand: [],
    precision: 2,
    now: 0,
  });
  assert.equal(advanced.status, 'STOP_HIT');
});

test('signal integrity holds for rise and fall after creation', () => {
  assert.ok(assertSignalIntegrity(makeSignal()));
  const fall = makeSignal({
    direction: 'FALL',
    entry: 100,
    stopLoss: 102,
    takeProfit: 94,
  });
  assert.ok(assertSignalIntegrity(fall));
});

// --- Backtest ---

function syntheticTrendBars(count: number): Candle[] {
  const bars: Candle[] = [];
  let price = 1000;
  let t = 1_600_000_000;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 9) * 1.6 + (i % 2 === 0 ? 0.9 : -0.4);
    const o = price;
    const c = price + drift;
    const h = Math.max(o, c) + 0.7;
    const l = Math.min(o, c) - 0.7;
    bars.push(candle(t, o, h, l, c));
    price = c;
    t += 300;
  }
  return bars;
}

test('backtest never fabricates statistics and reports provenance notes', () => {
  const report = backtestModel({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    timeframe: 'M5',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    candles: syntheticTrendBars(400),
  });
  assert.ok(report.notes.length > 0);
  assert.equal(report.totalBars, 400);
  // Every trade's entry/SL integrity is preserved through the replay.
  for (const trade of report.trades) {
    const risk = Math.abs(trade.entry - trade.stopLoss);
    assert.ok(risk > 0);
  }
  // In-sample + out-of-sample together account for all trades.
  assert.equal(
    report.inSample.totalSetups + report.outOfSample.totalSetups,
    report.overall.totalSetups
  );
});

test('computeBacktestStats derives drawdown and consecutive losses without inventing values', () => {
  type BacktestTradeStatus =
    | 'TARGET_HIT'
    | 'STOP_HIT'
    | 'MISSED'
    | 'INVALIDATED'
    | 'PENDING'
    | 'ACTIVE';
  const mk = (status: BacktestTradeStatus, rr: number | null) => ({
    id: 'x',
    symbol: 'R_100',
    displayName: 'V100',
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
    exitPrice: null,
    status,
    realizedRr: rr,
    maxFavourableExcursionPct: 1,
    maxAdverseExcursionPct: 0.5,
    barsHeld: 5,
    confirmedBarTime: 0,
    settledBarTime: 0,
    tpAdjustments: [],
    takeProfit1: 104,
    takeProfit2: 106,
    takeProfit3: 110,
    highestTargetReached: 1 as const,
    ambiguous: false,
  });
  const stats = computeBacktestStats([
    mk('TARGET_HIT', 2),
    mk('STOP_HIT', -1),
    mk('STOP_HIT', -1),
    mk('TARGET_HIT', 3),
  ]);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 2);
  assert.equal(stats.winRatePercent, 50);
  assert.equal(stats.maxConsecutiveLosses, 2);
  // Equity: +2, +1, 0, +3 → peak 2 before the losing pair → max drawdown 2R.
  assert.equal(stats.maxDrawdownR, 2);
});

// --- Training aggregation ---

test('backtestModels scores every requested model in one pass and keeps them separate', () => {
  const reports = backtestModels(
    {
      symbol: 'R_100',
      displayName: 'Volatility 100 Index',
      marketFamily: 'VOLATILITY',
      precision: 2,
      timeframe: 'M5',
      candles: syntheticTrendBars(400),
    },
    ['MODEL_1_TREND_PULLBACK_CONTINUATION', 'MODEL_2_BREAKOUT_AND_RETEST']
  );
  assert.equal(reports.length, 2);
  const models = reports.map((r) => r.model);
  assert.deepEqual(models, [
    'MODEL_1_TREND_PULLBACK_CONTINUATION',
    'MODEL_2_BREAKOUT_AND_RETEST',
  ]);
  // Each report contains only its own model's trades.
  for (const report of reports) {
    for (const trade of report.trades) {
      assert.equal(trade.model, report.model);
    }
  }
});

test('segmentTrades never blends models together and flags small samples', () => {
  const report = backtestModel({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    timeframe: 'M5',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    candles: syntheticTrendBars(400),
  });
  const segments = segmentTrades(report.trades, 'model');
  // A single-model report yields at most one segment bucket.
  assert.ok(segments.length <= 1);
  for (const seg of segments) {
    assert.equal(seg.key, 'MODEL_2_BREAKOUT_AND_RETEST');
    if (seg.sampleCount < 10) assert.equal(seg.winRatePercent, null);
  }
});

test('aggregateTrades derives honest statistics without inventing values', () => {
  const report = backtestModel({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    timeframe: 'M5',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    candles: syntheticTrendBars(400),
  });
  const stats = aggregateTrades(report.trades);
  assert.equal(stats.totalSetups, report.trades.length);
  assert.equal(stats.wins + stats.losses, stats.filledTrades);
  if (stats.filledTrades === 0) {
    assert.equal(stats.winRatePercent, null);
    assert.equal(stats.averageRr, null);
  }
});

test('collectTrades splits in-sample and out-of-sample without overlap', () => {
  const report = backtestModel({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    timeframe: 'M5',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    candles: syntheticTrendBars(400),
  });
  const inSample = collectTrades([report], 'inSample');
  const outOfSample = collectTrades([report], 'outOfSample');
  const ids = new Set(inSample.map((t) => t.id));
  for (const t of outOfSample) {
    assert.ok(!ids.has(t.id), 'a trade must not appear in both samples');
  }
  assert.equal(inSample.length + outOfSample.length, report.trades.length);
});

test('managedSignalFromFeed locks the entry/stop-loss and seeds a dynamic take-profit', () => {
  const signal = managedSignalFromFeed({
    id: 'feed-1',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    direction: 'RISE',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    modelLabel: 'Model 2 — Breakout & Retest',
    condition: 'STRONG_UPTREND',
    quality: null,
    entryPrice: 500,
    stopLoss: 495,
    takeProfit1: 515,
    takeProfit2: 520,
    confidence: 82,
    createdAt: 1_700_000_000_000,
  });
  assert.equal(signal.entry, 500);
  assert.equal(signal.stopLoss, 495);
  assert.equal(signal.takeProfit, 515);
  assert.equal(signal.status, 'PENDING');
  assert.equal(signal.tpHistory.length, 1);
  assert.ok(assertSignalIntegrity(signal));
  // A feed signal with no take-profit still gets a valid, risk-derived one.
  const noTp = managedSignalFromFeed({
    id: 'feed-2',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    direction: 'FALL',
    model: null,
    modelLabel: null,
    condition: 'STRONG_DOWNTREND',
    quality: null,
    entryPrice: 500,
    stopLoss: 505,
    takeProfit1: null,
    takeProfit2: null,
    confidence: 70,
    createdAt: 1_700_000_000_000,
  });
  assert.ok(noTp.takeProfit < noTp.entry);
  assert.ok(assertSignalIntegrity(noTp));
});
