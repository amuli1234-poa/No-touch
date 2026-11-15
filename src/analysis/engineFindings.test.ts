import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEngineFindings, summariseFindings } from './engineFindings';
import { assessTargetReachability, detectFalseSignal } from './advancedIntelligence';
import type { MomentumAssessment, SupportResistanceLevel, SupplyDemandZone } from '../types/analysis';
import type { IndicatorSnapshot } from '../types/engine';
import type { MarketIntelligence } from '../types/intelligence';
import type { InstrumentProfile } from '../types/instrument';

function baseMomentum(over: Partial<MomentumAssessment> = {}): MomentumAssessment {
  return {
    state: 'STRONG_BULLISH',
    bodyRatio: 0.8,
    closeConviction: 0.8,
    consecutiveDirectional: 3,
    breakoutAtrDistance: 1.4,
    isOverextended: false,
    nearOpposingStructure: false,
    directionalEfficiency: 0.7,
    displacementCandle: true,
    isExhausted: false,
    pullbackQuality: 'CLEAN',
    summary: 'Clean bullish momentum.',
    ...over,
  };
}

function baseIndicators(over: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    ema20: 1.05,
    ema50: 1.02,
    rsi14: 61,
    macdLine: 0.01,
    macdSignal: 0.005,
    macdHistogram: 0.005,
    adx14: 28,
    trendConfirm: 'BULLISH',
    momentumConfirm: 'BULLISH',
    strengthConfirm: true,
    notes: [],
    ...over,
  };
}

function baseIntelligence(over: Partial<MarketIntelligence> = {}): MarketIntelligence {
  return {
    symbol: 'R_100',
    timeframe: 'M5',
    asOfTime: 1_700_000_000,
    price: 1.05,
    atr: 0.01,
    bias: 'bullish',
    condition: 'TRENDING',
    conditionExplanation: 'Clean uptrend.',
    majorSwings: [
      {
        index: 1,
        time: 1,
        price: 1.0,
        type: 'low',
        strength: 0.8,
        displacementAtr: 1.2,
        rejectionScore: 0.6,
        structuralImportance: 0.7,
        tier: 'strong',
        label: 'HL',
        reason: 'Higher low.',
      },
      {
        index: 2,
        time: 2,
        price: 1.1,
        type: 'high',
        strength: 0.8,
        displacementAtr: 1.2,
        rejectionScore: 0.6,
        structuralImportance: 0.7,
        tier: 'strong',
        label: 'HH',
        reason: 'Higher high.',
      },
    ],
    strongHighs: [1.1],
    strongLows: [1.0],
    breaks: [],
    trendlines: [],
    zones: [],
    supplyDemand: [],
    fvg: [],
    liquidityPools: [],
    liquiditySweeps: [],
    rejectionZones: [],
    displacement: { direction: 'bullish', atr: 1.3 },
    report: {
      biasSummary: 'Bullish.',
      structuralLevels: [],
      strongestZones: [],
      liquidityObjectives: [],
      bullishScenario: {
        direction: 'bullish',
        summary: '',
        trigger: '',
        targets: [],
        invalidation: '',
        invalidationPrice: null,
      },
      bearishScenario: {
        direction: 'bearish',
        summary: '',
        trigger: '',
        targets: [],
        invalidation: '',
        invalidationPrice: null,
      },
      noTradeAreas: [],
    },
    tradeable: true,
    noTradeReason: null,
    ...over,
  };
}

function profile(over: Partial<InstrumentProfile> = {}): InstrumentProfile {
  return {
    kind: 'STANDARD_VOLATILITY',
    label: 'Standard Volatility',
    family: 'VOLATILITY',
    behaviour: {
      volatilityTier: 3,
      trendTendency: 0.6,
      rangeTendency: 0.5,
      spikeRisk: 0.2,
      breakoutQuality: 0.6,
      abnormalVolatilityCapable: false,
    },
    preferredModels: [],
    discouragedModels: [],
    targetRoomAtr: 1.5,
    requiresStabilisation: false,
    notes: '',
    ...over,
  };
}

const RESISTANCE: SupportResistanceLevel = {
  id: 'r1',
  price: 1.2,
  type: 'resistance',
  touches: 2,
  firstTouchTime: 1,
  lastTouchTime: 2,
  status: 'active',
  importance: 'major',
  reason: 'swing high',
};

test('buildEngineFindings reports all four lenses', () => {
  const findings = buildEngineFindings({
    direction: 'RISE',
    precision: 2,
    intelligence: baseIntelligence(),
    structure: null,
    momentum: baseMomentum(),
    indicators: baseIndicators(),
    supportResistance: [],
    supplyDemand: [],
  });
  assert.ok(findings.smc.length > 0);
  assert.ok(findings.ict.length > 0);
  assert.ok(findings.priceAction.length > 0);
  assert.ok(findings.technical.length > 0);
});

test('aligned momentum, structure and indicators support a RISE read', () => {
  const findings = buildEngineFindings({
    direction: 'RISE',
    precision: 2,
    intelligence: baseIntelligence(),
    structure: null,
    momentum: baseMomentum(),
    indicators: baseIndicators(),
    supportResistance: [],
    supplyDemand: [],
  });
  const smc = summariseFindings(findings.smc);
  const tech = summariseFindings(findings.technical);
  assert.ok(smc.support > 0);
  assert.ok(tech.support > 0);
  assert.equal(tech.oppose, 0);
});

test('opposing indicators and momentum do not support a RISE read', () => {
  const findings = buildEngineFindings({
    direction: 'RISE',
    precision: 2,
    intelligence: baseIntelligence({ displacement: { direction: 'bearish', atr: 1.4 } }),
    structure: null,
    momentum: baseMomentum({ state: 'STRONG_BEARISH', pullbackQuality: 'AGGRESSIVE_COUNTER' }),
    indicators: baseIndicators({ trendConfirm: 'BEARISH', rsi14: 38, macdHistogram: -0.004 }),
    supportResistance: [],
    supplyDemand: [],
  });
  const tech = summariseFindings(findings.technical);
  assert.ok(tech.oppose > 0);
  const ict = summariseFindings(findings.ict);
  assert.ok(ict.oppose > 0);
});

test('assessTargetReachability flags a blocked target when an opposing level is too close', () => {
  const supply: SupplyDemandZone = {
    id: 's1',
    type: 'supply',
    upperPrice: 1.07,
    lowerPrice: 1.055,
    originTime: 1,
    originIndex: 1,
    status: 'fresh',
    touches: 0,
    displacementAtr: 1.2,
    reason: 'supply',
  };
  const reach = assessTargetReachability({
    direction: 'RISE',
    entryPrice: 1.05,
    target1: 1.1,
    target2: 1.15,
    atr: 0.01,
    instrument: profile({ targetRoomAtr: 1.5 }),
    supportResistance: [],
    supplyDemand: [supply],
    intelligence: baseIntelligence(),
  });
  assert.equal(reach.blocked, true);
  assert.equal(reach.tp1Reachable, false);
  assert.ok(reach.reason.length > 0);
});

test('assessTargetReachability clears a target with open room', () => {
  const reach = assessTargetReachability({
    direction: 'RISE',
    entryPrice: 1.05,
    target1: 1.1,
    target2: 1.15,
    atr: 0.01,
    instrument: profile({ targetRoomAtr: 1.5 }),
    supportResistance: [RESISTANCE],
    supplyDemand: [],
    intelligence: baseIntelligence(),
  });
  assert.equal(reach.blocked, false);
  assert.equal(reach.tp1Reachable, true);
});

test('detectFalseSignal flags overextended, choppy and room-less setups', () => {
  const reach = assessTargetReachability({
    direction: 'RISE',
    entryPrice: 1.05,
    target1: 1.055,
    target2: 1.06,
    atr: 0.01,
    instrument: profile({ targetRoomAtr: 1.5 }),
    supportResistance: [],
    supplyDemand: [],
    intelligence: baseIntelligence(),
  });
  const report = detectFalseSignal({
    direction: 'RISE',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    instrument: profile(),
    momentum: baseMomentum({ isOverextended: true }),
    intelligence: baseIntelligence({ condition: 'TRANSITIONING' }),
    structure: null,
    reachability: reach,
    condition: 'CHOPPY',
  });
  assert.equal(report.flagged, true);
  assert.ok(report.traps.length >= 2);
});

test('detectFalseSignal clears a clean setup', () => {
  const reach = assessTargetReachability({
    direction: 'RISE',
    entryPrice: 1.05,
    target1: 1.1,
    target2: 1.15,
    atr: 0.01,
    instrument: profile({ targetRoomAtr: 1.5 }),
    supportResistance: [RESISTANCE],
    supplyDemand: [],
    intelligence: baseIntelligence(),
  });
  const report = detectFalseSignal({
    direction: 'RISE',
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    instrument: profile(),
    momentum: baseMomentum(),
    intelligence: baseIntelligence(),
    structure: null,
    reachability: reach,
    condition: 'STRONG_UPTREND',
  });
  assert.equal(report.flagged, false);
  assert.equal(report.traps.length, 0);
});
