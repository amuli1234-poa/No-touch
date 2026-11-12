export interface Candle {
  epoch: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Timeframe = '1m' | '2m' | '5m' | '15m' | '1h';

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
}

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface PivotPoint {
  index: number;
  epoch: number;
  price: number;
  type: 'HIGH' | 'LOW';
  isSwept: boolean;
  sweepEpoch?: number;
  isExternal?: boolean; // 5m external vs 2m internal
}

export interface LiquidityPool {
  id: string;
  type: 'BUYSIDE' | 'SELLSIDE';
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
  confirmedByClose: boolean;
  displacementScore: number; // 0 to 1
  candleBodyRatio: number;
}

export interface SupportResistanceZone {
  id: string;
  timeframe: '5m' | '2m';
  type: 'SUPPORT' | 'RESISTANCE' | 'SUPPLY' | 'DEMAND';
  upperPrice: number;
  lowerPrice: number;
  testCount: number;
  fresh: boolean;
  broken: boolean;
  lastTestEpoch?: number;
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
    | 'NONE';
  direction: TrendDirection;
  epoch: number;
  strength: number; // 0.0 to 1.0
  rejectionWickRatio: number;
  bodyRatio: number;
  description: string;
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

export interface BarrierProposal {
  contractType: 'NOTOUCH';
  barrier: string; // e.g. "+15.20" or "-12.50"
  barrierLevel: number;
  barrierOffset: number;
  direction: 'ABOVE' | 'BELOW'; // Upper barrier (Above) vs Lower barrier (Below)
  durationMinutes: number;
  durationSeconds: number;
  payout: number;
  askPrice: number;
  impliedProb: number;
  pathSurvivalProb: number;
  expectedValue: number;
  isViable: boolean;
  spotPriceAtQuote: number;
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
  structureAlignment: number; // Max 20
  liquidityAndProtectedSwing: number; // Max 15
  candlestickConfirmation: number; // Max 10
  confirmedMarketShift: number; // Max 15
  fvgAndDisplacement: number; // Max 15
  tradeableRangeAndRetracement: number; // Max 15
  barrierSurvival: number; // Max 10
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
  status: OpportunityStatus;
  detectedEpoch: number;
  direction: TrendDirection;
  score: OpportunityScoreBreakdown;
  barrierProposal?: BarrierProposal;
  tradeableRange?: TradeableRange;
  activeFvg?: FVG;
  reversalPattern?: CandlestickSignal;
  marketShift?: StructuralShift;
  sweptPool?: LiquidityPool;
  stepAudit: StepAuditItem[];
  rejectionReasons: string[];
  explanation: string;
  volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH';
  atr: number;
}

export interface PerformanceRecord {
  id: string;
  symbol: string;
  displayName: string;
  is1s: boolean;
  detectedEpoch: number;
  direction: TrendDirection;
  technicalScore: number;
  predictedTouchProb: number;
  barrierTouched: boolean;
  contractSettledWon: boolean;
  expirySeconds: number;
  payout: number;
  askPrice: number;
  profit: number;
  fvgMitigationDepth: number;
  barrierLevel: number;
  barrierDirection: 'ABOVE' | 'BELOW';
}

export interface ScannerSettings {
  appId: number;
  expiryMode: 'AUTO' | 'FIXED';
  fixedDurationMinutes: number;
  minScoreThreshold: number;
  fvgMinDisplacement: number;
  filterMarket: 'ALL' | 'STANDARD' | '1S';
  autoRefreshIntervalSec: number;
  soundAlerts: boolean;
}
