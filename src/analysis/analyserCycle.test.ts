import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type { CompletedAnalyserTrade } from '../types/analyserCycle';
import type { EntryModelId } from '../types/engine';
import { ENTRY_MODEL_LABELS } from '../types/engine';
import {
  buildCompletedAnalyserTrade,
  canDisplaySetup,
  completedTradeToLearningRecord,
  computeTradeAccuracy,
  evaluateAnalyserCompletion,
  mergeCompletedTrades,
} from './analyserCycle';
import type { AnalyserSetupForCompletion } from '../types/analyserCycle';

const STEP = 300;
const T0 = 1_700_000_000;

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

function setup(over: Partial<AnalyserSetupForCompletion> = {}): AnalyserSetupForCompletion {
  return {
    id: 'R_100-M5-MODEL_2-RISE-1000',
    symbol: 'R_100',
    timeframe: 'M5',
    direction: 'RISE',
    entry: 100,
    takeProfit: 106,
    stopLoss: 98,
    confirmedBarTime: T0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// TP / SL detection
// ---------------------------------------------------------------------------

test('detects a take-profit hit on a confirmed RISE candle', () => {
  const candles = [
    candle(T0, 100, 101, 99.5, 100.5),
    candle(T0 + STEP, 100.5, 106.5, 100.2, 106),
  ];
  const verdict = evaluateAnalyserCompletion(setup(), candles);
  assert.equal(verdict.completed, true);
  assert.equal(verdict.outcome, 'TARGET_HIT');
  assert.equal(verdict.exitPrice, 106);
  assert.equal(verdict.settledBarTime, T0 + STEP);
  assert.equal(verdict.verificationSource, 'CONFIRMED_CANDLE');
});

test('detects a stop-loss hit on a confirmed RISE candle', () => {
  const candles = [candle(T0 + STEP, 100, 100.4, 97.5, 97.8)];
  const verdict = evaluateAnalyserCompletion(setup(), candles);
  assert.equal(verdict.outcome, 'STOP_HIT');
  assert.equal(verdict.exitPrice, 98);
});

test('a FALL setup targets down and stops up', () => {
  const fall = setup({ direction: 'FALL', takeProfit: 94, stopLoss: 103 });
  assert.equal(evaluateAnalyserCompletion(fall, [candle(T0 + STEP, 100, 100.2, 93.8, 94)]).outcome, 'TARGET_HIT');
  assert.equal(evaluateAnalyserCompletion(fall, [candle(T0 + STEP, 100, 103.5, 99, 103.2)]).outcome, 'STOP_HIT');
});

test('the stop wins when a single bar spans both the stop and the target', () => {
  const verdict = evaluateAnalyserCompletion(setup(), [candle(T0 + STEP, 100, 107, 97, 100)]);
  assert.equal(verdict.outcome, 'STOP_HIT');
});

test('bars before the confirmation bar cannot settle a setup', () => {
  const candles = [candle(T0 - STEP, 100, 107, 97, 106)];
  assert.equal(evaluateAnalyserCompletion(setup(), candles).completed, false);
});

test('an open setup (neither level touched) is not completed', () => {
  const candles = [candle(T0 + STEP, 100, 102, 99.5, 101)];
  const verdict = evaluateAnalyserCompletion(setup(), candles);
  assert.equal(verdict.completed, false);
  assert.equal(verdict.outcome, null);
});

// ---------------------------------------------------------------------------
// Live-price verification
// ---------------------------------------------------------------------------

test('the live price can confirm a completion the confirmed bar has not yet recorded', () => {
  const candles = [candle(T0 + STEP, 100, 102, 99.5, 101)];
  const verdict = evaluateAnalyserCompletion(setup(), candles, 106.2);
  assert.equal(verdict.completed, true);
  assert.equal(verdict.outcome, 'TARGET_HIT');
  assert.equal(verdict.verificationSource, 'LIVE_PRICE');
});

test('a live price between the levels does not complete a setup', () => {
  const candles = [candle(T0 + STEP, 100, 102, 99.5, 101)];
  assert.equal(evaluateAnalyserCompletion(setup(), candles, 101).completed, false);
});

test('a live price that has breached the stop verifies a loss', () => {
  const verdict = evaluateAnalyserCompletion(setup(), [], 97.4);
  assert.equal(verdict.outcome, 'STOP_HIT');
  assert.equal(verdict.verificationSource, 'LIVE_PRICE');
});

// ---------------------------------------------------------------------------
// Accuracy maths
// ---------------------------------------------------------------------------

test('accuracy: a win realises the planned R:R and 100% accuracy', () => {
  const acc = computeTradeAccuracy('RISE', 100, 106, 98, 'TARGET_HIT');
  assert.equal(acc.plannedRr, 3);
  assert.equal(acc.realisedRr, 3);
  assert.equal(acc.accuracyPercent, 100);
  assert.equal(acc.signedOutcome, 1);
  assert.equal(acc.breakEvenAccuracyPercent, 25);
});

test('accuracy: a loss realises −1R and 0% accuracy', () => {
  const acc = computeTradeAccuracy('FALL', 100, 94, 103, 'STOP_HIT');
  assert.equal(acc.plannedRr, 2);
  assert.equal(acc.realisedRr, -1);
  assert.equal(acc.accuracyPercent, 0);
  assert.equal(acc.signedOutcome, -1);
});

// ---------------------------------------------------------------------------
// Completed-trade record
// ---------------------------------------------------------------------------

function buildTrade(over: Partial<Parameters<typeof buildCompletedAnalyserTrade>[0]> = {}): CompletedAnalyserTrade {
  const base: Parameters<typeof buildCompletedAnalyserTrade>[0] = {
    id: 'R_100-M5-MODEL_2-RISE-1000',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    timeframe: 'M5',
    direction: 'RISE',
    strategyLabel: 'Chart Analyser',
    strategyId: 'PRICE_ACTION',
    modelId: 'MODEL_2_BREAKOUT_AND_RETEST',
    modelLabel: 'Breakout & Retest',
    entryModel: 'BREAKOUT_RETEST',
    entryModelLabel: 'Breakout & Retest',
    entry: 100,
    takeProfit: 106,
    stopLoss: 98,
    invalidationPrice: 98,
    entryZone: [99, 100],
    riskRewardRatio: 3,
    verdict: {
      completed: true,
      outcome: 'TARGET_HIT',
      exitPrice: 106,
      settledBarTime: T0 + STEP,
      barsHeld: 2,
      verified: true,
      verificationSource: 'CONFIRMED_CANDLE',
      note: 'hit',
    },
    confirmedAt: T0 * 1000,
    chartAnalysis: {
      qualityScore: 88,
      quality: {
        structure: 20,
        levelZone: 18,
        entryConfirmation: 20,
        momentum: 12,
        multiTimeframe: 9,
        availableSpace: 9,
        total: 88,
        tier: 'HIGH_QUALITY',
        publishable: true,
      },
      condition: 'STRONG_UPTREND',
      confirmationExplanation: 'BOS then retest held.',
      reasons: ['Structure aligned', 'Retest confirmed'],
      bosChochEvidence: ['BOS at 101'],
      momentumEvidence: ['Strong bullish candle'],
      entryTrigger: 'Enter on RISE at 100',
      availableSpaceAtr: 1.4,
      availableSpaceLabel: 'Good room to target',
      confluenceScore: 5,
      maxConfluenceScore: 6,
      htfAlignmentSummary: 'M15 bullish',
      currentStructureSummary: 'Bullish structure',
      confirmedBarTime: T0,
    },
    now: T0 * 1000 + 60_000,
  };
  return buildCompletedAnalyserTrade({ ...base, ...over });
}

test('builds a permanent completed-trade record with full attribution', () => {
  const trade = buildTrade();
  assert.equal(trade.outcome, 'TARGET_HIT');
  assert.equal(trade.exitPrice, 106);
  assert.equal(trade.accuracy.realisedRr, 3);
  assert.equal(trade.entryModel, 'BREAKOUT_RETEST');
  assert.equal(trade.chartAnalysis.qualityScore, 88);
  assert.equal(trade.strategyLabel, 'Chart Analyser');
  assert.equal(trade.verified, true);
});

test('refuses to build a record without a verified completion', () => {
  assert.throws(() =>
    buildTrade({
      verdict: {
        completed: false,
        outcome: null,
        exitPrice: null,
        settledBarTime: null,
        barsHeld: 0,
        verified: false,
        verificationSource: 'CONFIRMED_CANDLE',
        note: 'open',
      },
    })
  );
});

test('mergeCompletedTrades is append-only and never overwrites or drops history', () => {
  const a = buildTrade({ id: 'a' });
  const b = buildTrade({ id: 'b', now: T0 * 1000 + 120_000 });
  const merged = mergeCompletedTrades([a], [a, b]);
  assert.deepEqual(merged.map((t) => t.id).sort(), ['a', 'b']);
  // Re-merging the same records changes nothing (immutability).
  const again = mergeCompletedTrades(merged, [a, b]);
  assert.equal(again, merged);
});

// ---------------------------------------------------------------------------
// Duplicate / conflict prevention
// ---------------------------------------------------------------------------

const candidate = {
  id: 'cand-1',
  symbol: 'R_100',
  timeframe: 'M5' as const,
  strategyId: 'PRICE_ACTION',
  direction: 'RISE' as const,
  createdAt: T0 * 1000,
  confirmedBarTime: T0,
  latestConfirmedBarTime: T0 + STEP,
};

test('a completed setup id can never be displayed again', () => {
  const guard = canDisplaySetup(candidate, null, new Set([candidate.id]));
  assert.equal(guard.display, false);
  assert.match(guard.reason, /already completed/i);
});

test('an unconfirmed candidate (future confirmation bar) is not displayed', () => {
  const guard = canDisplaySetup(
    { ...candidate, confirmedBarTime: T0 + 10 * STEP },
    null,
    new Set()
  );
  assert.equal(guard.display, false);
});

test('a fresh candidate is displayed when nothing is active', () => {
  assert.equal(canDisplaySetup(candidate, null, new Set()).display, true);
});

test('a second setup for the same market and strategy is blocked while one is active', () => {
  const displayed = {
    id: 'other',
    symbol: 'R_100',
    timeframe: 'M5' as const,
    strategyId: 'PRICE_ACTION',
    direction: 'RISE' as const,
    createdAt: T0 * 1000,
  };
  const guard = canDisplaySetup(candidate, displayed, new Set());
  assert.equal(guard.display, false);
  assert.match(guard.reason, /already active|conflict/i);
});

test('a different market or strategy is not blocked by the active setup', () => {
  const displayed = {
    id: 'other',
    symbol: 'R_25',
    timeframe: 'M5' as const,
    strategyId: 'PRICE_ACTION',
    direction: 'RISE' as const,
    createdAt: T0 * 1000,
  };
  assert.equal(canDisplaySetup(candidate, displayed, new Set()).display, true);
});

// ---------------------------------------------------------------------------
// Learning mapping
// ---------------------------------------------------------------------------

test('maps a completed trade onto a learning outcome record with full attribution', () => {
  const trade = buildTrade();
  const record = completedTradeToLearningRecord(trade);
  assert.equal(record.id, trade.id);
  assert.equal(record.outcome, 'TARGET_HIT');
  assert.equal(record.realisedRr, 3);
  assert.equal(record.plannedRr, 3);
  assert.equal(record.entryModel, 'BREAKOUT_RETEST');
  assert.equal(record.strategyLabel, 'Chart Analyser');
  assert.equal(record.symbol, 'R_100');
  assert.deepEqual(record.conditions, trade.chartAnalysis.reasons);
});

// ---------------------------------------------------------------------------
// END-TO-END CYCLE — every eligible index × every strategy model × both directions.
// The full flow: Active setup → TP/SL hit → verify → save → clear (guard blocks the
// completed id) → re-analyse (fresh id) → validate → display the fresh entry.
// ---------------------------------------------------------------------------

const UNIVERSE: { symbol: string; displayName: string; family: CompletedAnalyserTrade['marketFamily'] }[] = [
  { symbol: 'R_10', displayName: 'Volatility 10 Index', family: 'VOLATILITY' },
  { symbol: 'R_25', displayName: 'Volatility 25 Index', family: 'VOLATILITY' },
  { symbol: 'R_50', displayName: 'Volatility 50 Index', family: 'VOLATILITY' },
  { symbol: 'R_75', displayName: 'Volatility 75 Index', family: 'VOLATILITY' },
  { symbol: 'R_100', displayName: 'Volatility 100 Index', family: 'VOLATILITY' },
  { symbol: '1HZ10V', displayName: 'Volatility 10 (1s) Index', family: 'VOLATILITY' },
  { symbol: '1HZ25V', displayName: 'Volatility 25 (1s) Index', family: 'VOLATILITY' },
  { symbol: '1HZ50V', displayName: 'Volatility 50 (1s) Index', family: 'VOLATILITY' },
  { symbol: '1HZ75V', displayName: 'Volatility 75 (1s) Index', family: 'VOLATILITY' },
  { symbol: '1HZ100V', displayName: 'Volatility 100 (1s) Index', family: 'VOLATILITY' },
  { symbol: 'JD10', displayName: 'Jump 10 Index', family: 'JUMP' },
  { symbol: 'JD25', displayName: 'Jump 25 Index', family: 'JUMP' },
  { symbol: 'JD100', displayName: 'Jump 100 Index', family: 'JUMP' },
  { symbol: 'stpRNG', displayName: 'Step Index', family: 'STEP' },
];

const MODELS: EntryModelId[] = [
  'MODEL_1_TREND_PULLBACK_CONTINUATION',
  'MODEL_2_BREAKOUT_AND_RETEST',
  'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
  'MODEL_4_SUPPLY_DEMAND_REACTION',
  'MODEL_5_LIQUIDITY_SWEEP_CHOCH',
  'MODEL_6_TRENDLINE_BREAK_RETEST',
  'MODEL_7_CHART_PATTERN_BREAKOUT',
  'MODEL_8_MOMENTUM_BOS',
];

const TIMEFRAMES: CompletedAnalyserTrade['timeframe'][] = ['M15', 'M7', 'M5', 'M3', 'M1'];

test('the full cycle works for every eligible index × strategy model × direction × timeframe', () => {
  let cycles = 0;
  let wins = 0;
  let losses = 0;

  for (const market of UNIVERSE) {
    for (const model of MODELS) {
      for (const direction of ['RISE', 'FALL'] as const) {
        for (const timeframe of TIMEFRAMES) {
          const rise = direction === 'RISE';
          const entry = 1000;
          const stop = rise ? 995 : 1005;
          const target = rise ? 1015 : 985;
          const id = `${market.symbol}-${timeframe}-${model}-${direction}-${T0}`;

          // Phase 1 — ACTIVE SETUP is displayed (a fresh, non-conflicting candidate).
          const candidate = {
            id,
            symbol: market.symbol,
            timeframe,
            strategyId: 'PRICE_ACTION',
            direction,
            createdAt: T0 * 1000,
            confirmedBarTime: T0,
            latestConfirmedBarTime: T0 + STEP,
          };
          assert.equal(canDisplaySetup(candidate, null, new Set()).display, true, market.symbol);

          const active = setup({
            id,
            symbol: market.symbol,
            timeframe,
            direction,
            entry,
            takeProfit: target,
            stopLoss: stop,
            confirmedBarTime: T0,
          });

          // Phase 2 — a bar reaches the target → verified completion (this model variant wins).
          const won = evaluateAnalyserCompletion(active, [
            candle(T0 + STEP, entry, rise ? target + 0.5 : entry + 1, rise ? entry - 1 : target - 0.5, target),
          ]);
          // Phase 3 — the same level hit as a stop is a verified loss.
          const lost = evaluateAnalyserCompletion(active, [
            candle(T0 + STEP, entry, rise ? entry + 1 : stop + 0.5, rise ? stop - 0.5 : entry - 1, stop),
          ]);

          assert.equal(won.completed, true);
          assert.equal(won.outcome, 'TARGET_HIT');
          assert.equal(lost.completed, true);
          assert.equal(lost.outcome, 'STOP_HIT');
          cycles += 2;
          if (won.outcome === 'TARGET_HIT') wins++;
          if (lost.outcome === 'STOP_HIT') losses++;

          // Phase 4 — SAVE the completed trade with full chart-analysis data.
          const trade = buildCompletedAnalyserTrade({
            id,
            symbol: market.symbol,
            displayName: market.displayName,
            marketFamily: market.family,
            precision: 2,
            timeframe,
            direction,
            strategyLabel: 'Chart Analyser',
            strategyId: 'PRICE_ACTION',
            modelId: model,
            modelLabel: ENTRY_MODEL_LABELS[model],
            entryModel: 'BREAKOUT_RETEST',
            entryModelLabel: 'Breakout & Retest',
            entry,
            takeProfit: target,
            stopLoss: stop,
            invalidationPrice: stop,
            entryZone: [Math.min(entry, stop), Math.max(entry, stop)],
            riskRewardRatio: Math.abs(target - entry) / Math.abs(entry - stop),
            verdict: won,
            confirmedAt: T0 * 1000,
            chartAnalysis: {
              qualityScore: 90,
              quality: {
                structure: 20,
                levelZone: 20,
                entryConfirmation: 20,
                momentum: 12,
                multiTimeframe: 9,
                availableSpace: 9,
                total: 90,
                tier: 'HIGH_QUALITY',
                publishable: true,
              },
              condition: rise ? 'STRONG_UPTREND' : 'STRONG_DOWNTREND',
              confirmationExplanation: `${model} confirmed.`,
              reasons: ['Structure aligned'],
              bosChochEvidence: ['BOS'],
              momentumEvidence: ['Momentum'],
              entryTrigger: `Enter on ${direction} at ${entry}`,
              availableSpaceAtr: 1.5,
              availableSpaceLabel: 'Good room',
              confluenceScore: 5,
              maxConfluenceScore: 6,
              htfAlignmentSummary: 'Aligned',
              currentStructureSummary: 'Clear structure',
              confirmedBarTime: T0,
            },
            now: T0 * 1000 + 60_000,
          });
          assert.equal(trade.outcome, 'TARGET_HIT');
          assert.equal(trade.accuracy.signedOutcome, 1);
          assert.equal(trade.symbol, market.symbol);
          assert.equal(trade.modelId, model);

          // Phase 5 — CLEAR: the completed id can never be displayed again.
          assert.equal(canDisplaySetup(candidate, null, new Set([id])).display, false);

          // Phase 6 — RE-ANALYSE produces a fresh id, VALIDATE + DISPLAY the fresh entry.
          const freshId = `${market.symbol}-${timeframe}-${model}-${direction}-${T0 + 10 * STEP}`;
          const fresh = {
            ...candidate,
            id: freshId,
            confirmedBarTime: T0 + 10 * STEP,
            latestConfirmedBarTime: T0 + 11 * STEP,
          };
          assert.equal(canDisplaySetup(fresh, null, new Set([id])).display, true);

          // Phase 7 — the LEARNING AI receives the completed outcome (permanent attribution).
          const record = completedTradeToLearningRecord(trade);
          assert.equal(record.symbol, market.symbol);
          assert.equal(record.entryModel, 'BREAKOUT_RETEST');
          assert.equal(record.realisedRr, 3);
        }
      }
    }
  }

  assert.ok(cycles >= 14 * 8 * 2 * 5, `expected a large cycle matrix, got ${cycles}`);
  assert.equal(wins, losses);
});

test('the ledger survives across the whole matrix without losing or duplicating records', () => {
  const trades: CompletedAnalyserTrade[] = [];
  for (const market of UNIVERSE) {
    for (const direction of ['RISE', 'FALL'] as const) {
      const trade = buildTrade({
        id: `${market.symbol}-${direction}`,
        symbol: market.symbol,
        displayName: market.displayName,
        marketFamily: market.family,
        direction,
      });
      trades.push(trade);
    }
  }
  let ledger: CompletedAnalyserTrade[] = [];
  for (const t of trades) ledger = mergeCompletedTrades(ledger, [t]);
  assert.equal(ledger.length, trades.length);
  // Re-merging the entire history is a no-op (nothing duplicated, nothing dropped).
  const before = ledger;
  ledger = mergeCompletedTrades(ledger, trades);
  assert.equal(ledger, before);
});
