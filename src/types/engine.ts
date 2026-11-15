import type { MarketDirection } from './analysis';
import type { MarketIntelligence, EngineFindings, TargetReachability, FalseSignalReport } from './intelligence';
import type { InstrumentProfile } from './instrument';
import type { MarketFamily, TimeframeKey } from './market';
import type { StructureOverlayData } from './structure';

/**
 * Market condition classification (duration-free). The engine chooses entry models
 * appropriate to the current condition and refuses to force setups in poor conditions.
 */
export type MarketCondition =
  | 'STRONG_UPTREND'
  | 'STRONG_DOWNTREND'
  | 'CONSOLIDATION'
  | 'SIDEWAYS_RANGE'
  | 'TRANSITIONAL'
  | 'CHOPPY';

/**
 * Which third of a sideways range price is currently trading in. The engine only
 * trades the extremes; the middle band is a hard no-trade zone.
 */
export type RangeZone = 'UPPER' | 'MIDDLE' | 'LOWER' | 'ABOVE_RANGE' | 'BELOW_RANGE';

/**
 * A validated sideways range built from confirmed M15 swing highs/lows. `resistance`
 * is the range high, `support` the range low, `equilibrium` the midpoint. `tradingArea`
 * is the 25% extreme band and `noTradeBand` the middle 50%. Only a valid range (enough
 * confirmed touches on both boundaries) may produce range-extreme signals.
 */
export interface RangeAnalysis {
  resistance: number;
  support: number;
  equilibrium: number;
  /** Range height (resistance - support). */
  height: number;
  /** Confirmed swing touches on the resistance boundary. */
  resistanceTouches: number;
  /** Confirmed swing touches on the support boundary. */
  supportTouches: number;
  /** Latest confirmed M15 bar time used to build the range. */
  asOfTime: number;
  valid: boolean;
  /** Human-readable reason when the range is not valid. */
  reason: string;
  /** Current price's zone within the range (uses the live close). */
  zone: RangeZone;
  /** Upper 25% band: [lower, upper]. */
  tradingArea: { lower: number; upper: number };
  /** Middle 50% band: [lower, upper] — hard no-trade. */
  noTradeBand: { lower: number; upper: number };
}

/**
 * The eight price-action entry models, each valid for both RISE and FALL.
 * These are analysis models — they have nothing to do with contract duration.
 */
export type EntryModelId =
  | 'MODEL_1_TREND_PULLBACK_CONTINUATION'
  | 'MODEL_2_BREAKOUT_AND_RETEST'
  | 'MODEL_3_SUPPORT_RESISTANCE_REJECTION'
  | 'MODEL_4_SUPPLY_DEMAND_REACTION'
  | 'MODEL_5_LIQUIDITY_SWEEP_CHOCH'
  | 'MODEL_6_TRENDLINE_BREAK_RETEST'
  | 'MODEL_7_CHART_PATTERN_BREAKOUT'
  | 'MODEL_8_MOMENTUM_BOS';

export const ENTRY_MODEL_LABELS: Record<EntryModelId, string> = {
  MODEL_1_TREND_PULLBACK_CONTINUATION: 'Model 1 — Trend Pullback Continuation',
  MODEL_2_BREAKOUT_AND_RETEST: 'Model 2 — Breakout & Retest',
  MODEL_3_SUPPORT_RESISTANCE_REJECTION: 'Model 3 — Support/Resistance Rejection',
  MODEL_4_SUPPLY_DEMAND_REACTION: 'Model 4 — Supply & Demand Reaction',
  MODEL_5_LIQUIDITY_SWEEP_CHOCH: 'Model 5 — Liquidity Sweep & CHoCH',
  MODEL_6_TRENDLINE_BREAK_RETEST: 'Model 6 — Trendline Break & Retest',
  MODEL_7_CHART_PATTERN_BREAKOUT: 'Model 7 — Chart Pattern Breakout',
  MODEL_8_MOMENTUM_BOS: 'Model 8 — Momentum BOS',
};

export const ENTRY_MODEL_IDS: readonly EntryModelId[] = [
  'MODEL_1_TREND_PULLBACK_CONTINUATION',
  'MODEL_2_BREAKOUT_AND_RETEST',
  'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
  'MODEL_4_SUPPLY_DEMAND_REACTION',
  'MODEL_5_LIQUIDITY_SWEEP_CHOCH',
  'MODEL_6_TRENDLINE_BREAK_RETEST',
  'MODEL_7_CHART_PATTERN_BREAKOUT',
  'MODEL_8_MOMENTUM_BOS',
];

export type SignalState =
  | 'SCANNING'
  | 'DEVELOPING'
  | 'AWAITING_CONFIRMATION'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'INVALIDATED'
  | 'COMPLETED';

/**
 * Optional indicator snapshot. Indicators CONFIRM price action; they never replace it.
 */
export interface IndicatorSnapshot {
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  adx14: number | null;
  /** EMA/price relationship used only as a confirming filter. */
  trendConfirm: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** MACD + RSI alignment used only as a confirming filter. */
  momentumConfirm: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** ADX above threshold => trending conditions confirmed. */
  strengthConfirm: boolean;
  notes: string[];
}

export type QualityTier = 'EXCEPTIONAL' | 'HIGH_QUALITY' | 'DEVELOPING' | 'REJECTED';

/** 100-point technical quality breakdown (not a win probability). */
export interface QualityBreakdown {
  structure: number; // /20
  levelZone: number; // /20
  entryConfirmation: number; // /25
  momentum: number; // /15
  multiTimeframe: number; // /10
  availableSpace: number; // /10
  total: number; // /100
  tier: QualityTier;
  /** Publication gate: total >= 85 AND all mandatory confirmations satisfied. */
  publishable: boolean;
}

export interface EntryModelCandidate {
  model: EntryModelId;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  entryPrice: number;
  structuralLevelPrice: number;
  retestPrice: number | null;
  retestTime: number | null;
  invalidationPrice: number;
  invalidationCondition: string;
  target1: number | null;
  target2: number | null;
  stopLoss: number;
  riskRewardRatio: number;
  confirmationExplanation: string;
  bosChochEvidence: string[];
  supportResistance: number[];
  momentumEvidence: string[];
  reasons: string[];
  invalidations: string[];
  availableSpaceAtr: number;
  availableSpaceLabel: string;
  /** Component scores before aggregation. */
  scores: {
    structure: number;
    levelZone: number;
    entryConfirmation: number;
    momentum: number;
    multiTimeframe: number;
    availableSpace: number;
  };
}

export interface EngineSignal {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  direction: 'RISE' | 'FALL';
  model: EntryModelId;
  modelLabel: string;
  condition: MarketCondition;
  analysisTimeframe: TimeframeKey;
  quality: QualityBreakdown;
  entryPrice: number;
  entryZone: [number, number] | null;
  invalidationPrice: number;
  invalidationCondition: string;
  target1: number | null;
  target2: number | null;
  stopLoss: number;
  riskRewardRatio: number;
  confirmationExplanation: string;
  bosChochEvidence: string[];
  supportResistance: number[];
  momentumEvidence: string[];
  reasons: string[];
  invalidations: string[];
  availableSpaceAtr: number;
  availableSpaceLabel: string;
  indicators: IndicatorSnapshot;
  state: SignalState;
  /** Per-instrument label (e.g. 'Jump', 'Volatility 1s') this signal was selected for. */
  instrumentLabel: string;
  /** Why THIS model was selected over the competing models, for this instrument. */
  explanation: string;
  createdAt: number;
  confirmedBarTime: number;
  lastUpdated: number;
}

export interface EvaluatedModelOutcome {
  model: EntryModelId;
  modelLabel: string;
  direction: 'RISE' | 'FALL' | null;
  qualified: boolean;
  score: number;
  rejectionReason?: string;
}

export interface InstrumentAnalysis {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  timeframe: TimeframeKey;
  price: number;
  condition: MarketCondition;
  conditionExplanation: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  structureDirection: MarketDirection;
  structureLabel: string;
  bosChochEvidence: string[];
  momentumSummary: string;
  indicators: IndicatorSnapshot;
  htfAlignmentSummary: string;
  evaluatedModels: EvaluatedModelOutcome[];
  bestCandidate: EntryModelCandidate | null;
  /** Validated sideways range used for range-extreme gating (null when not sideways). */
  range: RangeAnalysis | null;
  /** Forward-looking structure & fresh future reaction zones (null when history is short). */
  structure: StructureOverlayData | null;
  /**
   * Phase-1/2 market intelligence: the independent read of the current market that is
   * produced BEFORE any opportunity is searched for. Null only when history is short.
   */
  intelligence: MarketIntelligence | null;
  /** Per-instrument intelligence: how THIS index behaves and which models suit it. */
  instrument: InstrumentProfile;
  /** Four-lens read (SMC / ICT / price action / technical) for the selected direction. */
  findings: EngineFindings | null;
  /** Target-first reachability estimate for the selected setup (null with no candidate). */
  reachability: TargetReachability | null;
  /** False-signal / trap detection for the selected setup (null with no candidate). */
  falseSignal: FalseSignalReport | null;
  /** Every candidate detected this run (one per eligible model), for independent per-model evaluation. */
  allCandidates: EntryModelCandidate[];
  signal: EngineSignal | null;
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  candlesCount: number;
  atr: number;
  normalizedAtr: number;
  rejectionReason?: string;
  lastUpdated: number;
}

export interface EngineScanSummary {
  winner: EngineSignal | null;
  winnerAnalysis: InstrumentAnalysis | null;
  scannedCount: number;
  confirmedCount: number;
  developingCount: number;
  familyCounts: Record<'VOLATILITY' | 'JUMP' | 'STEP' | 'RANGE_BREAK', number>;
  topRejectionReasons: string[];
  scannedAt: number;
  timeframe: TimeframeKey;
  statusBanner: string;
}

export type SignalOutcome = 'PENDING' | 'WIN' | 'LOSS' | 'TIE' | 'INVALIDATED';

/** One tracked model performance sample — entry, invalidation, target, MFE/MAE, outcome. */
export interface ModelPerformanceRecord {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  model: EntryModelId;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  timeframe: TimeframeKey;
  condition: MarketCondition;
  qualityScore: number;
  entryPrice: number;
  invalidationPrice: number;
  target1: number | null;
  maxFavourableExcursionPct: number;
  maxAdverseExcursionPct: number;
  outcome: SignalOutcome;
  exitPrice: number | null;
  createdAt: number;
  settledAt: number | null;
}

export interface SegmentedModelPerformance {
  key: string;
  label: string;
  sampleCount: number;
  wins: number;
  losses: number;
  pendingCount: number;
  winRatePercent: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
  uncertaintyNote: string;
}
