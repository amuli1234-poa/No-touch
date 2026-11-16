import type { Candle, MarketFamily, TimeframeKey } from './market';
import type { EntryModelId, MarketCondition, QualityBreakdown, SignalState, IndicatorSnapshot, EvaluatedModelOutcome, RangeAnalysis } from './engine';
import type {
  MarketIntelligence,
  MajorTrendline,
  MajorZone,
  EngineFindings,
  TargetReachability,
  FalseSignalReport,
} from './intelligence';
import type { StructureOverlayData } from './structure';

export type AnalysisRunState =
  | 'READY TO ANALYZE'
  | 'ANALYZING MARKET'
  | 'WAITING FOR CONFIRMATION'
  | 'VALID RISE SETUP'
  | 'VALID FALL SETUP'
  | 'NO VALID SETUP'
  | 'SETUP INVALIDATED';

export type SignalDecisionState = 'CONFIRMED' | 'INVALIDATED' | 'WAIT';

export type AnalysisControlMode = 'idle' | 'running' | 'paused';

export type MarketDirection = 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL';

export type ZoneStatus = 'fresh' | 'tested' | 'mitigated' | 'invalidated';

export type SignalQualityTier =
  | 'EXCEPTIONAL'
  | 'HIGH QUALITY'
  | 'DEVELOPING'
  | 'INVALID SETUP';

// Re-export the canonical model taxonomy so UI/tests can import from either module.
export type { EntryModelId } from './engine';
export { ENTRY_MODEL_LABELS } from './engine';

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'high' | 'low';
  swingLabel?: 'HH' | 'HL' | 'LH' | 'LL';
}

export interface SupportResistanceLevel {
  id: string;
  price: number;
  type: 'support' | 'resistance';
  touches: number;
  firstTouchTime: number;
  lastTouchTime: number;
  status: 'active' | 'broken';
  importance: 'major' | 'minor';
  reason: string;
}

export interface SupplyDemandZone {
  id: string;
  type: 'demand' | 'supply';
  upperPrice: number;
  lowerPrice: number;
  originTime: number;
  originIndex: number;
  status: ZoneStatus;
  touches: number;
  displacementAtr: number;
  reason: string;
}

export interface StructureBreakEvent {
  id: string;
  kind: 'BOS' | 'CHOCH';
  direction: 'bullish' | 'bearish';
  time: number;
  index: number;
  price: number;
  brokenLevel: number;
  momentumConfirmed: boolean;
  reason: string;
}

export interface LiquiditySweepEvent {
  id: string;
  type: 'BULLISH_SWEEP' | 'BEARISH_SWEEP';
  time: number;
  index: number;
  sweepPrice: number;
  reversalClosePrice: number;
  sweptLevel: number;
  reason: string;
}

export interface TrendlineStructure {
  id: string;
  direction: 'bullish' | 'bearish';
  startTime: number;
  startPrice: number;
  endTime: number;
  endPrice: number;
  slopePerSec: number;
  touches: number;
  broken: boolean;
  breakDirection?: 'bullish' | 'bearish';
  breakTime?: number;
  breakPrice?: number;
  reason: string;
}

export type ChartPatternName =
  | 'Double Top'
  | 'Double Bottom'
  | 'Ascending Triangle'
  | 'Descending Triangle'
  | 'Symmetrical Triangle'
  | 'Bullish Flag'
  | 'Bearish Flag'
  | 'Rectangle'
  | 'Head and Shoulders'
  | 'Inverse Head and Shoulders'
  | 'Bullish Pennant'
  | 'Bearish Pennant';

export interface PatternLineSegment {
  startTime: number;
  startPrice: number;
  endTime: number;
  endPrice: number;
}

export interface ChartPatternStructure {
  id: string;
  name: ChartPatternName;
  bias: 'bullish' | 'bearish';
  confirmed: boolean;
  breakTime?: number;
  breakPrice?: number;
  necklinePrice?: number;
  lines: PatternLineSegment[];
  reason: string;
}

export interface BreakoutRetestOverlay {
  direction: 'RISE' | 'FALL';
  breakoutLevel: number;
  breakoutTime: number;
  retestTime: number | null;
  retestPrice: number | null;
  confirmationTime: number;
  confirmationPrice: number;
  label: string;
}

export interface MomentumAssessment {
  state:
    | 'STRONG_BULLISH'
    | 'STRONG_BEARISH'
    | 'WEAK'
    | 'OVEREXTENDED'
    | 'NEUTRAL';
  bodyRatio: number;
  closeConviction: number;
  consecutiveDirectional: number;
  breakoutAtrDistance: number;
  isOverextended: boolean;
  nearOpposingStructure: boolean;
  directionalEfficiency: number;
  displacementCandle: boolean;
  isExhausted: boolean;
  pullbackQuality: 'CLEAN' | 'CHOPPY' | 'AGGRESSIVE_COUNTER';
  summary: string;
}

export interface TimeframeAnalysisSummary {
  timeframe: TimeframeKey;
  direction: MarketDirection;
  structureLabel: string;
  candleCount: number;
  keySupport: number | null;
  keyResistance: number | null;
  latestBreak: StructureBreakEvent | null;
  freshZonesCount: number;
  notes: string[];
}

export interface ConfluenceFactor {
  label: string;
  satisfied: boolean;
  detail: string;
}

export interface OpportunityFreshness {
  status: 'FRESH' | 'EXPIRED' | 'EXTENDED_CHASE_BLOCKED' | 'INVALIDATED';
  createdAt: number;
  confirmationTime: number;
  entryReferencePrice: number;
  invalidationPrice: number;
  invalidationCondition: string;
  currentExtensionAtr: number;
  maxPermittedExtensionAtr: number;
  chaseBlocked: boolean;
  isFresh: boolean;
  summary: string;
}

/**
 * The analyser's signal card. Duration-free: it describes a confirmed structural
 * setup, never a contract horizon.
 */
export interface TradeSignalCard {
  id: string;
  direction: 'RISE' | 'FALL';
  marketName: string;
  symbol: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  model: EntryModelId;
  modelLabel: string;
  signalStatus: 'CONFIRMED' | 'INVALIDATED';
  state: SignalState;
  condition: MarketCondition;
  bosConfirmationPrice: number;
  structuralLevelPrice: number;
  retestPrice: number | null;
  retestTime: number | null;
  entryTrigger: string;
  entryPrice: number;
  entryCandleTime: number;
  invalidationPrice: number;
  invalidationCondition: string;
  takeProfit1: number;
  takeProfit2: number;
  stopLoss: number;
  riskRewardRatio: number;
  availableSpaceAtr: number;
  availableSpaceLabel: string;
  reasons: string[];
  invalidations: string[];
  confirmationExplanation: string;
  bosChochEvidence: string[];
  momentumEvidence: string[];
  quality: QualityBreakdown;
  confluenceScore: number;
  maxConfluenceScore: number;
  confluenceFactors: ConfluenceFactor[];
  freshness?: OpportunityFreshness;
  /** Per-instrument label this signal was selected for. */
  instrumentLabel?: string;
  /** Why this model was selected over competing models, for this instrument. */
  explanation?: string;
}

export interface ChartOverlayData {
  supportResistance: SupportResistanceLevel[];
  supplyDemand: SupplyDemandZone[];
  structureBreaks: StructureBreakEvent[];
  liquiditySweeps: LiquiditySweepEvent[];
  trendlines: TrendlineStructure[];
  patterns: ChartPatternStructure[];
  /** Confirmed swing points labelled HH / HL / LH / LL. */
  swingPoints: SwingPoint[];
  /** MAJOR trendlines built on significant swings only (clean-chart layer). */
  majorTrendlines: MajorTrendline[];
  /** MAJOR support/resistance ZONES (rectangles) from significant structure. */
  majorZones: MajorZone[];
  /** Validated sideways range (M15) with its support / resistance / equilibrium bands. */
  range: RangeAnalysis | null;
  /** High-probability entry band (structural level → confirmation close). */
  entryZone: { low: number; high: number; label: string } | null;
  breakoutRetest: BreakoutRetestOverlay | null;
  signal: TradeSignalCard | null;
  /** Forward-looking structure & fresh future reaction zones (clean-chart layer). */
  structure: StructureOverlayData | null;
}

export interface DevelopingCandidate {
  model: EntryModelId;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  score: number;
  confirmationExplanation: string;
  condition: MarketCondition;
}

export interface MultiTimeframeSummary {
  macroTf: TimeframeKey;
  structuralTf: TimeframeKey;
  setupTf: TimeframeKey;
  entryTf: TimeframeKey;
  rationale: string;
}

/**
 * An immutable snapshot of the exact evidence that produced a signal. When a
 * scanner signal is opened on the chart, this lets the chart reproduce the precise
 * setup the breadth engine saw at scan time — same model, levels, quality, candle.
 */
export interface SignalSnapshot {
  id: string;
  source: 'SCANNER' | 'ANALYSER' | 'CO-ANALYSIS';
  symbol: string;
  displayName: string;
  direction: 'RISE' | 'FALL';
  model: EntryModelId;
  modelLabel: string;
  condition: MarketCondition;
  timeframe: TimeframeKey;
  qualityTotal: number;
  quality: QualityBreakdown;
  entryPrice: number;
  invalidationPrice: number;
  invalidationCondition: string;
  target1: number | null;
  target2: number | null;
  stopLoss: number;
  riskRewardRatio: number;
  confirmationExplanation: string;
  reasons: string[];
  bosChochEvidence: string[];
  capturedAt: number;
  confirmedBarTime: number;
}

/**
 * Full analyser report. Contains NO contract duration and NO duration fit — market
 * analysis is fully independent of any contract execution setting.
 */
export interface FullAnalysisReport {
  symbol: string;
  marketName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  precision: number;
  multiTimeframe: MultiTimeframeSummary;
  analyzedAt: number;
  confirmedBarTime: number;
  runState: AnalysisRunState;
  signalStatus: SignalDecisionState;
  signalState: SignalState;
  bosConfirmationPrice: number | null;
  overallDirection: MarketDirection;
  marketCondition: MarketCondition;
  conditionExplanation: string;
  htfConflictNote: string | null;
  htfAlignmentSummary: string;
  currentStructureSummary: string;
  momentum: MomentumAssessment;
  indicators: IndicatorSnapshot;
  topDownSummaries: Partial<Record<TimeframeKey, TimeframeAnalysisSummary>>;
  overlays: ChartOverlayData;
  liquiditySweeps: LiquiditySweepEvent[];
  /**
   * Phase-1/2 market intelligence for the active timeframe: the independent read of
   * the current market (bias, major structure, zones, liquidity, scenarios) produced
   * BEFORE any opportunity was searched for. Null only when history is short.
   */
  intelligence: MarketIntelligence | null;
  /** Four-lens read (SMC / ICT / price action / technical) for the analysed direction. */
  findings: EngineFindings | null;
  /** Target-first reachability estimate for the leading setup (null when no candidate). */
  reachability: TargetReachability | null;
  /** False-signal / trap detection for the leading setup (null when no candidate). */
  falseSignal: FalseSignalReport | null;
  recommendedDirection: 'RISE' | 'FALL' | 'WAIT';
  setupQuality: SignalQualityTier;
  /** Best candidate below the 85 publication gate (null when a signal is published). */
  developingCandidate: DevelopingCandidate | null;
  evaluatedModels: EvaluatedModelOutcome[];
  confluenceScore: number;
  maxConfluenceScore: number;
  confluenceFactors: ConfluenceFactor[];
  whyThisSetup: string[];
  entryTriggerText: string;
  invalidationText: string;
  noSetupMessage: string;
  /** The exact scanner/analyser evidence snapshot this report reproduces (null for a live analyser run). */
  snapshot: SignalSnapshot | null;
}

export interface MultiTimeframeCandles {
  H4?: readonly Candle[];
  H1?: readonly Candle[];
  M30?: readonly Candle[];
  M15?: readonly Candle[];
  M10?: readonly Candle[];
  M7?: readonly Candle[];
  M6?: readonly Candle[];
  M5?: readonly Candle[];
  M4?: readonly Candle[];
  M3?: readonly Candle[];
  M2?: readonly Candle[];
  M1?: readonly Candle[];
}
