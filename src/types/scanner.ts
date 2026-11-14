export interface Candle {
  epoch: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Timeframe = '1m' | '2m' | '5m' | '15m' | '1h' | '4h';

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type RiseFallDirection = 'BUY / RISE' | 'SELL / FALL' | 'WAIT';

export type MarketCondition =
  | 'UPTRENDING'
  | 'DOWNTRENDING'
  | 'CONSOLIDATING'
  | 'REVERSING'
  | 'UNCLEAR';

export type DetailedMarketRegime =
  | 'STRONG_UPTREND'
  | 'STRONG_DOWNTREND'
  | 'CONSOLIDATION'
  | 'RANGE_BOUND'
  | 'BREAKOUT_DEVELOPING'
  | 'POTENTIAL_REVERSAL';

export type StrategyCategory =
  | 'Trendline'
  | 'Breakout'
  | 'Support & Resistance'
  | 'Supply & Demand'
  | 'Chart Pattern';

export type StrategyId =
  | 'TRENDLINE_CONTINUATION'
  | 'SR_BREAKOUT_RETEST'
  | 'CONSOLIDATION_BREAKOUT'
  | 'FLIP_SUPPORT_RESISTANCE'
  | 'SUPPLY_DEMAND_REACTION'
  | 'CHART_PATTERN';

export interface StrategySetupCandidate {
  strategyId: StrategyId;
  category: StrategyCategory;
  label: string;
  status: 'CONFIRMED' | 'PENDING' | 'INACTIVE';
  regimePrioritized: boolean;
  direction: TrendDirection;
  riseFallLabel: RiseFallDirection;
  confluenceScore: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskRewardRatio?: number;
  entryCondition: string;
  invalidationCondition: string;
  confirmationReasons: string[];
  missingConditions: string[];
  expectedHoldingTime: string;
  timeframesUsed: ('4H' | '1H' | '15M' | '5M' | '1M')[];
}

export type TradingStrategyType =
  | 'TRENDLINE_CONTINUATION'
  | 'SR_BREAKOUT_RETEST'
  | 'CONSOLIDATION_BREAKOUT'
  | 'FLIP_SUPPORT_RESISTANCE'
  | 'SUPPLY_DEMAND_REACTION'
  | 'CHART_PATTERN'
  | 'NONE';

export interface StrategySelectionResult {
  strategy: TradingStrategyType;
  label: string;
  rationale: string;
  matched: boolean;
}

export type ZoneStrength =
  | 'STRONG_SUPPLY'
  | 'WEAK_SUPPLY'
  | 'STRONG_DEMAND'
  | 'WEAK_DEMAND';

export type SetupQualityTier = 'HIGH_QUALITY' | 'DEVELOPING' | 'WEAK' | 'AVOID';

export interface ActiveSymbol {
  symbol: string;
  displayName: string;
  market: string;
  is1s: boolean;
  isOpen: boolean;
  pipSize: number;
  lastQuote?: number;
  lastTickEpoch?: number;
  isStale?: boolean;
  missedTicks?: number;
  lastLatencyMs?: number;
}

export interface PivotPoint {
  index: number;
  epoch: number;
  price: number;
  type: 'HIGH' | 'LOW';
  isSwept: boolean;
  sweepEpoch?: number;
  isExternal?: boolean;
  structureTag?: 'HH' | 'HL' | 'LH' | 'LL' | 'EQH' | 'EQL';
}

export interface LiquidityPool {
  id: string;
  type: 'BUYSIDE' | 'SELLSIDE';
  label?: 'BSL' | 'SSL' | 'EQH' | 'EQL';
  priceLevel: number;
  epochEstablished: number;
  swept: boolean;
  sweptEpoch?: number;
}

export interface StructuralShift {
  type: 'BOS' | 'CHOCH';
  direction: TrendDirection;
  brokenLevel: number;
  breakEpoch: number;
  originEpoch?: number;
  confirmedByClose: boolean;
  displacementScore: number; // 0 to 1
  candleBodyRatio: number;
}

export interface SupportResistanceZone {
  id: string;
  timeframe: Timeframe;
  type: 'SUPPORT' | 'RESISTANCE' | 'SUPPLY' | 'DEMAND';
  strength: ZoneStrength;
  tier?: 'MAJOR' | 'MINOR';
  isFlip?: boolean;
  flipType?: 'R_TO_S' | 'S_TO_R';
  flipState?: 'NONE' | 'CONFIRMED_FLIP_RETEST' | 'FALSE_BREAKOUT' | 'FAILED_RETEST';
  flipLevel?: number;
  breakoutCloseEpoch?: number;
  retestEpoch?: number;
  retestRejection?: boolean;
  hasBaseFormation?: boolean;
  upperPrice: number;
  lowerPrice: number;
  originEpoch: number;
  testCount: number;
  fresh: boolean;
  broken: boolean;
  causedDisplacement: boolean;
  lastTestEpoch?: number;
}

export interface FlipSrAssessment {
  flipZones: SupportResistanceZone[];
  activeBullishFlip: SupportResistanceZone | null;
  activeBearishFlip: SupportResistanceZone | null;
  falseBreakoutDetected: boolean;
  failedRetestDetected: boolean;
  detail: string;
}

export interface PositionDrawing {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  source: 'AUTO' | 'MANUAL';
  signalId?: string;
  startEpoch: number;
  endEpoch: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  customized?: boolean;
}

export interface OrderBlock {
  id: string;
  timeframe: Timeframe;
  type: 'BULLISH_OB' | 'BEARISH_OB';
  strength: ZoneStrength;
  upperPrice: number;
  lowerPrice: number;
  epoch: number;
  mitigated: boolean;
  valid: boolean;
}

export interface FVG {
  id: string;
  timeframe: Timeframe;
  direction: TrendDirection;
  candle1Epoch: number;
  candle2Epoch: number;
  candle3Epoch: number;
  upperBoundary: number;
  lowerBoundary: number;
  midpoint: number;
  size: number;
  sizePercent: number;
  displacementPips: number;
  partialFilled: boolean;
  fillPercentage: number;
  completelyFilled: boolean;
  fresh: boolean;
}

export interface Trendline {
  id: string;
  timeframe: Timeframe;
  direction: 'BULLISH' | 'BEARISH' | 'HORIZONTAL';
  startEpoch: number;
  startPrice: number;
  endEpoch: number;
  endPrice: number;
  touches: number;
  broken: boolean;
  retested: boolean;
  falseBreakout: boolean;
  event?: 'BOUNCE' | 'BREAKOUT' | 'RETEST' | 'INTACT';
  slopePerSecond: number;
}

export type ChartPatternType =
  | 'DOUBLE_TOP'
  | 'DOUBLE_BOTTOM'
  | 'HEAD_AND_SHOULDERS'
  | 'INVERSE_HEAD_AND_SHOULDERS'
  | 'ASCENDING_TRIANGLE'
  | 'DESCENDING_TRIANGLE'
  | 'SYMMETRICAL_TRIANGLE'
  | 'RISING_WEDGE'
  | 'FALLING_WEDGE'
  | 'BULL_FLAG'
  | 'BEAR_FLAG'
  | 'BULL_PENNANT'
  | 'BEAR_PENNANT'
  | 'RECTANGLE'
  | 'ASCENDING_CHANNEL'
  | 'DESCENDING_CHANNEL'
  | 'BROADENING_FORMATION';

export interface ChartPatternPoint {
  epoch: number;
  price: number;
}

export interface ChartPatternLine {
  startEpoch: number;
  startPrice: number;
  endEpoch: number;
  endPrice: number;
  kind: 'BOUNDARY' | 'NECKLINE' | 'POLE';
}

export interface ChartPattern {
  id: string;
  type: ChartPatternType;
  label: string;
  timeframe: Timeframe;
  direction: TrendDirection;
  status: 'CONFIRMED_BREAKOUT' | 'FORMED_AT_BOUNDARY';
  confirmedByClose: boolean;
  necklineOrBreakLevel: number;
  targetPrice: number;
  invalidationPrice: number;
  lines: ChartPatternLine[];
  points: ChartPatternPoint[];
  detectedEpoch: number;
  description: string;
}

export interface FibonacciConfluence {
  direction: TrendDirection;
  swingHigh: number;
  swingLow: number;
  retracementPct: number;
  zoneLevel: '0.382' | '0.500' | '0.618' | '0.786' | 'NONE';
  inGoldenZone: boolean;
  target1272: number;
  target1618: number;
}

export interface TradeableRangeBox {
  timeframe: Timeframe;
  isValid: boolean;
  invalidReason?: string;
  condition: MarketCondition;
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  premiumZone: [number, number];
  discountZone: [number, number];
  currentPosition: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  breakoutState: 'INSIDE_RANGE' | 'BULLISH_BREAKOUT_RETEST' | 'BEARISH_BREAKOUT_RETEST' | 'EXTENDED';
  poisInsideRangeCount: number;
  startEpoch: number;
  endEpoch: number;
}

export interface CandlestickSignal {
  name:
    | 'HAMMER'
    | 'SHOOTING_STAR'
    | 'BULLISH_ENGULFING'
    | 'BEARISH_ENGULFING'
    | 'BULLISH_PIN_BAR'
    | 'BEARISH_PIN_BAR'
    | 'MORNING_STAR'
    | 'EVENING_STAR'
    | 'STRONG_BULLISH_REJECTION'
    | 'STRONG_BEARISH_REJECTION'
    | 'INSIDE_BAR'
    | 'OUTSIDE_BAR'
    | 'MOMENTUM_BULLISH'
    | 'MOMENTUM_BEARISH'
    | 'BREAKOUT_BULLISH'
    | 'BREAKOUT_BEARISH'
    | 'FAILED_BREAKOUT_BULLISH'
    | 'FAILED_BREAKOUT_BEARISH'
    | 'TWEEZER_BOTTOM'
    | 'TWEEZER_TOP'
    | 'NONE';
  direction: TrendDirection;
  epoch: number;
  strength: number; // 0.0 to 1.0
  rejectionWickRatio: number;
  bodyRatio: number;
  description: string;
}

export interface CandlestickAnnotation {
  epoch: number;
  name: string;
  shortLabel: string;
  direction: TrendDirection;
  price: number;
  strength: number;
}

export interface TradeableRange {
  sweptLiquidityLevel: number;
  newlyProtectedSwing: number;
  displacementBreakLevel: number;
  adaptiveFillTarget: number;
  fillRationale: string;
  invalidationLevel: number;
  isRetracementValid: boolean;
  rangeDistance: number;
  fillDepthType: 'NEAR_EDGE' | 'INTERMEDIATE_25' | 'MIDPOINT_50' | 'DEEP_75' | 'FULL_100';
}

export interface TechnicalIndicatorsSnapshot {
  rsi14: number;
  rsiState: 'OVERSOLD' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'OVERBOUGHT';
  adx14: number;
  plusDi: number;
  minusDi: number;
  adxRegime: 'STRONG_TREND' | 'TRENDING' | 'WEAK_RANGING';
  ema20: number;
  ema50: number;
  emaBias: TrendDirection;
  macdLine?: number;
  macdSignal?: number;
  macdHistogram?: number;
  macdBias?: TrendDirection;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbPosition: 'UPPER_BAND' | 'LOWER_BAND' | 'MID_ZONE';
  atr14: number;
  technicalVerdict: TrendDirection;
  confirmationNotes: string[];
}

export type MomentumClassification = 'STRONG' | 'MODERATE' | 'WEAK' | 'DEVELOPING';

export interface ProtectedSwing {
  type: 'HIGH' | 'LOW';
  price: number;
  epoch: number;
  label: string;
}

export interface MomentumAssessment {
  passed: boolean;
  classification: MomentumClassification;
  direction: TrendDirection;
  score: number; // 0 to 100
  avgBodyRatio: number;
  opposingWickRatio: number;
  displacementMultiple: number;
  followThroughCandles: number;
  decisiveClose: boolean;
  reason: string;
}

export interface EntryAndTP {
  confirmed: boolean;
  status: 'CONFIRMED_ENTRY' | 'WAIT';
  direction: TrendDirection;
  entryPrice?: number;
  entryRationale?: string;
  takeProfit?: number; // TP1
  takeProfit2?: number; // TP2
  tpRationale?: string;
  tp2Rationale?: string;
  invalidationLevel?: number; // SL
  riskRewardRatio?: number;
  waitReason?: string;
}

export interface TimeframeAnalysisSummary {
  timeframe: Timeframe;
  role: string;
  condition: MarketCondition;
  bias: TrendDirection;
  structureSummary: string;
  keyNote: string;
  bosCount: number;
  chochCount: number;
  validPoiCount: number;
}

export type OpportunityStatus =
  | 'WAITING'
  | 'WATCHLIST'
  | 'QUALIFIED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'DATA_UNAVAILABLE';

export interface OpportunityScoreBreakdown {
  marketStructure: number; // Max 20
  rangeAndPoi: number; // Max 20
  priceActionConfirmation: number; // Max 20
  momentumAndDisplacement: number; // Max 15
  multiTimeframeAlignment: number; // Max 15
  technicalConfirmation: number; // Max 10
  total: number; // Max 100
}

export interface StepAuditItem {
  step: number;
  name: string;
  passed: boolean;
  detail: string;
}

export interface OpportunitySignal {
  id: string;
  symbol: string;
  displayName: string;
  is1s: boolean;
  currentPrice: number;
  pipSize: number;
  status: OpportunityStatus;
  setupTier: SetupQualityTier;
  marketCondition: MarketCondition;
  marketRegime?: DetailedMarketRegime;
  marketRegimeLabel?: string;
  selectedStrategy: StrategySelectionResult;
  riseFallLabel: RiseFallDirection;
  detectedEpoch: number;
  direction: TrendDirection;
  score: OpportunityScoreBreakdown;
  timeframeMatrix: {
    h4: TimeframeAnalysisSummary;
    h1: TimeframeAnalysisSummary;
    m15: TimeframeAnalysisSummary;
    m5: TimeframeAnalysisSummary;
    m1: TimeframeAnalysisSummary;
  };
  tradingRange: TradeableRangeBox;
  momentum: MomentumAssessment;
  indicators: TechnicalIndicatorsSnapshot;
  entryAndTp: EntryAndTP;
  tradeableRange?: TradeableRange;
  activeFvg?: FVG;
  allFvgs: FVG[];
  reversalPattern?: CandlestickSignal;
  candlestickAnnotations: CandlestickAnnotation[];
  marketShift?: StructuralShift;
  structuralShifts: StructuralShift[];
  sweptPool?: LiquidityPool;
  liquidityPools: LiquidityPool[];
  zones: SupportResistanceZone[];
  orderBlocks: OrderBlock[];
  trendlines: Trendline[];
  confirmedPattern?: ChartPattern;
  fibConfluence?: FibonacciConfluence;
  srFlipDetected?: boolean;
  flipSrAssessment?: FlipSrAssessment;
  trendlineEvent?: string;
  candleCloseConfirmed?: boolean;
  protectedHigh?: ProtectedSwing | null;
  protectedLow?: ProtectedSwing | null;
  expectedHoldingTime?: string;
  timeframesUsed?: ('4H' | '1H' | '15M' | '5M' | '1M')[];
  confirmationReasons?: string[];
  strategySetups?: StrategySetupCandidate[];
  stepAudit: StepAuditItem[];
  rejectionReasons: string[];
  rankingReasons: string[];
  explanation: string;
  volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH';
  atr: number;
}

export interface SignalHistoryEntry {
  id: string;
  symbol: string;
  displayName: string;
  is1s: boolean;
  detectedEpoch: number;
  direction: TrendDirection;
  riseFallLabel?: RiseFallDirection;
  selectedStrategy?: string;
  confluenceScore: number;
  setupTier: SetupQualityTier;
  marketCondition: MarketCondition;
  entryPrice?: number;
  takeProfit?: number;
  invalidationLevel?: number;
  outcomeStatus: 'ACTIVE' | 'TP_HIT' | 'INVALIDATED';
  resolvedEpoch?: number;
  resolvedPrice?: number;
  explanation: string;
}

export interface WhatsAppProviderStatus {
  configured: boolean;
  provider: 'meta' | 'twilio' | 'callmebot' | 'webhook' | null;
  recipientMasked: string | null;
  missingFields: string[];
}

export interface WhatsAppSignalRecord {
  id: string;
  symbol: string;
  displayName: string;
  eventType: 'NEW_SIGNAL' | 'MATERIAL_UPDATE' | 'INVALIDATED';
  direction: TrendDirection;
  confluenceScore: number;
  entryPrice?: number;
  takeProfit?: number;
  message: string;
  sent: boolean;
  provider?: string | null;
  messageId?: string;
  error?: string;
  timestampEpoch: number;
  signature: string;
}

export interface ScannerSettings {
  appId: number;
  minScoreThreshold: number; // Enforced >= 75%
  fvgMinDisplacement: number;
  autoRefreshIntervalSec: number;
  soundAlerts: boolean;
  whatsappAutoSend: boolean;
  whatsappNotifyUpdates: boolean;
  showSecondaryIndicators: boolean;
}
