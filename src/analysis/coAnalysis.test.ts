import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEngines } from './coAnalysis';
import type { FullAnalysisReport, TradeSignalCard } from '../types/analysis';
import type { EngineSignal, QualityBreakdown } from '../types/engine';

const QUALITY: QualityBreakdown = {
  structure: 18,
  levelZone: 18,
  entryConfirmation: 22,
  momentum: 13,
  multiTimeframe: 8,
  availableSpace: 8,
  total: 87,
  tier: 'HIGH_QUALITY',
  publishable: true,
};

function engineSignal(over: Partial<EngineSignal> = {}): EngineSignal {
  return {
    id: 'sig',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    precision: 2,
    direction: 'RISE',
    model: 'MODEL_1_TREND_PULLBACK_CONTINUATION',
    modelLabel: 'Model 1 — Trend Pullback Continuation',
    condition: 'STRONG_UPTREND',
    analysisTimeframe: 'M5',
    quality: QUALITY,
    entryPrice: 500,
    entryZone: [498, 500],
    invalidationPrice: 496,
    invalidationCondition: 'Close below 496',
    target1: 505,
    target2: 508,
    stopLoss: 496,
    riskRewardRatio: 2,
    confirmationExplanation: 'Confirmed pullback continuation.',
    bosChochEvidence: ['BOS above 499'],
    supportResistance: [499],
    momentumEvidence: [],
    reasons: [],
    invalidations: [],
    availableSpaceAtr: 3,
    availableSpaceLabel: 'Adequate',
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
    instrumentLabel: 'Volatility 100',
    explanation: 'Model 1 preferred for this instrument.',
    createdAt: 0,
    confirmedBarTime: 0,
    lastUpdated: 0,
    ...over,
  };
}

function signalCard(over: Partial<TradeSignalCard> = {}): TradeSignalCard {
  return {
    id: 'sig',
    direction: 'RISE',
    marketName: 'Volatility 100 Index',
    symbol: 'R_100',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    model: 'MODEL_1_TREND_PULLBACK_CONTINUATION',
    modelLabel: 'Model 1 — Trend Pullback Continuation',
    signalStatus: 'CONFIRMED',
    state: 'CONFIRMED',
    condition: 'STRONG_UPTREND',
    bosConfirmationPrice: 501,
    structuralLevelPrice: 498,
    retestPrice: 499,
    retestTime: 0,
    entryTrigger: 'retest',
    entryPrice: 500,
    entryCandleTime: 0,
    invalidationPrice: 496,
    invalidationCondition: 'Close below 496',
    takeProfit1: 505,
    takeProfit2: 508,
    stopLoss: 496,
    riskRewardRatio: 2,
    availableSpaceAtr: 3,
    availableSpaceLabel: 'Adequate',
    reasons: [],
    invalidations: [],
    confirmationExplanation: '',
    bosChochEvidence: [],
    momentumEvidence: [],
    quality: QUALITY,
    confluenceScore: 5,
    maxConfluenceScore: 6,
    confluenceFactors: [],
    ...over,
  };
}

function report(over: Partial<FullAnalysisReport> = {}): FullAnalysisReport {
  const base = {
    symbol: 'R_100',
    marketName: 'Volatility 100 Index',
    timeframe: 'M5' as const,
    recommendedDirection: 'RISE' as const,
    confluenceScore: 5,
    maxConfluenceScore: 6,
    analyzedAt: 0,
    overlays: { signal: signalCard() },
  };
  return { ...base, ...over } as unknown as FullAnalysisReport;
}

test('ALIGNED when both engines agree on direction and model', () => {
  const co = reconcileEngines({
    symbol: 'R_100',
    timeframe: 'M5',
    scanner: engineSignal(),
    analyser: report(),
  });
  assert.equal(co.verdict, 'ALIGNED');
  assert.equal(co.validated, true);
  assert.equal(co.agreedDirection, 'RISE');
  assert.equal(co.modelAgreement, true);
  assert.ok(co.combinedConfidence !== null);
});

test('CONFLICT when engines disagree on direction', () => {
  const co = reconcileEngines({
    symbol: 'R_100',
    timeframe: 'M5',
    scanner: engineSignal({ direction: 'RISE' }),
    analyser: report({ overlays: { signal: signalCard({ direction: 'FALL' }) } } as never),
  });
  assert.equal(co.verdict, 'CONFLICT');
  assert.equal(co.validated, false);
  assert.equal(co.agreedDirection, null);
});

test('SCANNER_ONLY when the analyser has no confirmed signal', () => {
  const co = reconcileEngines({
    symbol: 'R_100',
    timeframe: 'M5',
    scanner: engineSignal(),
    analyser: report({ overlays: { signal: null }, recommendedDirection: 'WAIT' } as never),
  });
  assert.equal(co.verdict, 'SCANNER_ONLY');
  assert.equal(co.validated, false);
});

test('ANALYSER_ONLY when the scanner found nothing', () => {
  const co = reconcileEngines({
    symbol: 'R_100',
    timeframe: 'M5',
    scanner: null,
    analyser: report(),
  });
  assert.equal(co.verdict, 'ANALYSER_ONLY');
  assert.equal(co.validated, false);
});

test('NO_SIGNAL when neither engine confirms', () => {
  const co = reconcileEngines({
    symbol: 'R_100',
    timeframe: 'M5',
    scanner: null,
    analyser: null,
  });
  assert.equal(co.verdict, 'NO_SIGNAL');
  assert.equal(co.combinedConfidence, null);
});

test('PARTIAL when direction agrees but models differ', () => {
  const co = reconcileEngines({
    symbol: 'R_100',
    timeframe: 'M5',
    scanner: engineSignal({ model: 'MODEL_2_BREAKOUT_AND_RETEST' }),
    analyser: report(),
  });
  assert.equal(co.verdict, 'PARTIAL');
  assert.equal(co.validated, true);
  assert.equal(co.modelAgreement, false);
});
