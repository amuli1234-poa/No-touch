import type { MarketFamily, TimeframeKey } from './market';
import type { AiTimeframeRead } from './aiModule';

/**
 * Trendline Scanner types — a fully independent strategy module.
 *
 * Structural analysis (swings, trendlines, market condition) is performed on M15, with the
 * trend and market structure read on M7. The rejection setup develops on M5, the entry setup
 * is confirmed on M3, and the precise entry trigger is taken on M1. Nothing here touches the
 * existing price-action engine's model taxonomy.
 */

/** Which side of price a trendline acts on. */
export type TrendlineKind = 'support' | 'resistance';
/** Slope orientation of a trendline. */
export type TrendlineTrend = 'ascending' | 'descending' | 'horizontal';

/** A validated trendline built from confirmed M15 swing points. */
export interface TrendlineLine {
  id: string;
  kind: TrendlineKind;
  trend: TrendlineTrend;
  startTime: number;
  startPrice: number;
  endTime: number;
  endPrice: number;
  /** Price change per second (linear projection). */
  slopePerSec: number;
  touches: number;
  touchPoints: { time: number; price: number }[];
  valid: boolean;
  /** Why the candidate was rejected as invalid (empty when valid). */
  invalidReason: string;
  broken: boolean;
  breakDirection?: 'bullish' | 'bearish';
  breakTime?: number;
  breakPrice?: number;
  /** Projected line value at the latest confirmed structural bar. */
  currentPrice: number;
  reason: string;
}

/**
 * Trendline-module market condition. Separate from the price-action engine's
 * `MarketCondition` so the two strategies never share classification state.
 */
export type TrendlineMarketCondition =
  | 'UPTREND'
  | 'DOWNTREND'
  | 'SIDEWAYS'
  | 'RANGE_EXTREME'
  | 'CHOPPY';

/** The four trendline entry models. Rejection confirmation is mandatory for all. */
export type TrendlineEntryModelId =
  | 'TRENDLINE_REJECTION'
  | 'TRENDLINE_BREAKOUT'
  | 'TRENDLINE_BREAKOUT_RETEST'
  | 'TRENDLINE_LIQUIDITY_SWEEP_RECLAIM';

export const TRENDLINE_MODEL_LABELS: Record<TrendlineEntryModelId, string> = {
  TRENDLINE_REJECTION: 'Model T1 — Trendline Rejection',
  TRENDLINE_BREAKOUT: 'Model T2 — Trendline Breakout',
  TRENDLINE_BREAKOUT_RETEST: 'Model T3 — Breakout & Retest',
  TRENDLINE_LIQUIDITY_SWEEP_RECLAIM: 'Model T4 — Liquidity Sweep & Reclaim',
};

export const TRENDLINE_MODEL_IDS: readonly TrendlineEntryModelId[] = [
  'TRENDLINE_REJECTION',
  'TRENDLINE_BREAKOUT',
  'TRENDLINE_BREAKOUT_RETEST',
  'TRENDLINE_LIQUIDITY_SWEEP_RECLAIM',
];

export const TRENDLINE_MODEL_SHORT: Record<TrendlineEntryModelId, string> = {
  TRENDLINE_REJECTION: 'Rejection',
  TRENDLINE_BREAKOUT: 'Breakout',
  TRENDLINE_BREAKOUT_RETEST: 'Break & Retest',
  TRENDLINE_LIQUIDITY_SWEEP_RECLAIM: 'Sweep & Reclaim',
};

/** Mandatory rejection confirmation attached to every model. */
export interface TrendlineRejection {
  confirmed: boolean;
  kind: 'BULLISH_REJECTION' | 'BEARISH_REJECTION' | 'NONE';
  time: number;
  /** Wick extreme that probed the trendline / level. */
  wickPrice: number;
  close: number;
  /** 0–1 strength (wick dominance + close conviction). */
  strength: number;
  reason: string;
}

/**
 * The precise entry confirmation taken on M1 — the lowest timeframe in the top-down
 * chain (M15 structure → M7 trend & structure → M5 setup → M3 confirmation → M1 entry).
 * It must AGREE with the higher-timeframe direction unless a validated reversal has
 * flipped the bias.
 */
export type TrendlineEntryConfirmationKind =
  | 'BULLISH_ENGULFING'
  | 'BEARISH_ENGULFING'
  | 'BULLISH_BOS'
  | 'BEARISH_BOS'
  | 'MICRO_REJECTION'
  | 'NONE';

export interface TrendlineEntryConfirmation {
  confirmed: boolean;
  kind: TrendlineEntryConfirmationKind;
  timeframe: TimeframeKey;
  time: number;
  close: number;
  /** 0–1 strength (close conviction + body/engulf size). */
  strength: number;
  /** True when the M1 confirmation agrees with the higher-timeframe direction. */
  agreesWithTrend: boolean;
  reason: string;
}

/** Component scores (100-point technical quality; NOT a win probability). */
export interface TrendlineScoreBreakdown {
  trendlineQuality: number; // /20
  rejectionStrength: number; // /20
  trendAlignment: number; // /15
  zoneFreshness: number; // /15
  confirmation: number; // /20 (BOS continuation + close conviction)
  spaceToTarget: number; // /10
  total: number; // /100
}

/**
 * The dominant trend established from the higher timeframe (M15). The trendline module
 * only searches for setups that continue this trend: an uptrend searches RISE only, a
 * downtrend searches FALL only, and a range / unclear direction produces WAIT.
 */
export type TrendlineDominantTrend = 'UPTREND' | 'DOWNTREND' | 'RANGING';

/** A rejection boundary the trend-aligned setup can lean on. */
export type TrendlineZoneSource =
  | 'trendline'
  | 'support'
  | 'resistance'
  | 'demand'
  | 'supply'
  | 'flipped-support'
  | 'flipped-resistance';

/** Freshness of a reaction zone — untested zones are preferred over well-worn ones. */
export type TrendlineZoneFreshness = 'FRESH' | 'TESTED' | 'WEAKENED';

/**
 * A potential trend-continuation setup zone shown on the chart. In an uptrend these sit
 * BELOW price (blue); in a downtrend they sit ABOVE price (red). They are locations to
 * WATCH for a trend-aligned rejection — never an entry on their own.
 */
export interface TrendlineSetupZone {
  id: string;
  /** Direction the trend-aligned rejection would produce. */
  direction: 'RISE' | 'FALL';
  source: TrendlineZoneSource;
  label: string;
  /** Zone band (a trendline boundary is a thin band around the projected price). */
  upperPrice: number;
  lowerPrice: number;
  /** Where price would meet the zone (projected for a sloping trendline). */
  projectedPrice: number;
  distanceAtr: number;
  freshness: TrendlineZoneFreshness;
  touches: number;
  /** True when the zone has never been tested since it formed. */
  untested: boolean;
  valid: boolean;
  invalidReason: string;
  /** The trendline this zone is built from, when the source is a trendline. */
  trendline: TrendlineLine | null;
  reason: string;
}

/** The trend-alignment verdict for the current instrument. */
export interface TrendlineAlignment {
  dominantTrend: TrendlineDominantTrend;
  /** Higher-timeframe (M15) structure label backing the dominant trend. */
  structureLabel: string;
  /** Direction the module is allowed to search for, or null when it must WAIT. */
  tradableDirection: 'RISE' | 'FALL' | null;
  /** True when the dominant trend is confirmed (HH/HL for up, LH/LL for down). */
  trendConfirmed: boolean;
  /** True when a confirmed market-structure reversal has flipped the bias. */
  reversalConfirmed: boolean;
  /** Human-readable explanation of the alignment decision. */
  reason: string;
  /** The continuation BOS that confirms the trend, when one is present. */
  continuationBos: string | null;
}

export interface TrendlineCandidate {
  model: TrendlineEntryModelId;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  trendline: TrendlineLine;
  /** Trendline value at the entry bar's time. */
  trendlinePriceAtEntry: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  invalidationPrice: number;
  invalidationCondition: string;
  riskRewardRatio: number;
  rejection: TrendlineRejection;
  /** The trend-aligned setup zone (boundary) this candidate rejected from. */
  zone: TrendlineSetupZone | null;
  /** The M1 precise-entry confirmation (lowest timeframe in the top-down chain). */
  entryConfirmation: TrendlineEntryConfirmation;
  /** Continuation BOS that confirms the trend after the rejection, when present. */
  continuationBos: string | null;
  scores: TrendlineScoreBreakdown;
  reasons: string[];
  confirmations: string[];
  /** M15 structural context line for the UI. */
  m15Context: string;
  /** M5 confirmation line for the UI. */
  m5Confirmation: string;
  /** M1 precise-entry confirmation line for the UI. */
  m1Confirmation: string;
}

/**
 * Signal status vocabulary surfaced in the scanner results table. The scanner only ever
 * records CONFIRMED opportunities (a real M3/M1 confirmation), but the enum carries
 * WAITING / INVALIDATED so the UI can express every state the module can be in.
 */
export type TrendlineSignalStatus =
  | 'WAITING'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'INVALIDATED'
  | 'COMPLETED';

export const TRENDLINE_STATUS_LABELS: Record<TrendlineSignalStatus, string> = {
  WAITING: 'WAITING',
  CONFIRMED: 'CONFIRMED',
  ACTIVE: 'CONFIRMED',
  INVALIDATED: 'INVALIDATED',
  COMPLETED: 'COMPLETED',
};

/** The setup types surfaced in the scanner results (the four entry models, humanised). */
export const TRENDLINE_SETUP_TYPE: Record<TrendlineEntryModelId, string> = {
  TRENDLINE_REJECTION: 'Trendline Rejection',
  TRENDLINE_BREAKOUT: 'Trendline Breakout',
  TRENDLINE_BREAKOUT_RETEST: 'Breakout & Retest',
  TRENDLINE_LIQUIDITY_SWEEP_RECLAIM: 'Liquidity Sweep & Reclaim',
};

export interface TrendlineSignal {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  direction: 'RISE' | 'FALL';
  model: TrendlineEntryModelId;
  modelLabel: string;
  condition: TrendlineMarketCondition;
  /** Structural timeframe (M15) and precise-entry timeframe (M1) for the published signal. */
  structureTimeframe: TimeframeKey;
  /** M7 trend & market-structure timeframe. */
  trendTimeframe: TimeframeKey;
  /** M5 setup timeframe the rejection developed on. */
  setupTimeframe: TimeframeKey;
  /** M3 entry-setup confirmation timeframe. */
  confirmTimeframe: TimeframeKey;
  entryTimeframe: TimeframeKey;
  score: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  invalidationPrice: number;
  invalidationCondition: string;
  riskRewardRatio: number;
  trendline: TrendlineLine;
  rejection: TrendlineRejection;
  zone: TrendlineSetupZone | null;
  /** The M1 precise-entry confirmation that authorised the entry. */
  entryConfirmation: TrendlineEntryConfirmation;
  continuationBos: string | null;
  reasons: string[];
  confirmations: string[];
  m15Context: string;
  m5Confirmation: string;
  m1Confirmation: string;
  status: TrendlineSignalStatus;
  createdAt: number;
  confirmedBarTime: number;
  lastUpdated: number;
}

export interface TrendlineInstrumentAnalysis {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  price: number;
  condition: TrendlineMarketCondition;
  conditionExplanation: string;
  structureLabel: string;
  /** Trend-alignment verdict — which direction (if any) the module may search. */
  alignment: TrendlineAlignment;
  /** Nearest valid future setup zones (blue below price / red above), freshest first. */
  setupZones: TrendlineSetupZone[];
  trendlines: TrendlineLine[];
  range: {
    support: number;
    resistance: number;
    equilibrium: number;
    zone: 'UPPER' | 'MIDDLE' | 'LOWER' | 'ABOVE_RANGE' | 'BELOW_RANGE';
  } | null;
  /** Best qualifying candidate this pass (null when nothing clears the 85 gate). */
  bestCandidate: TrendlineCandidate | null;
  signal: TrendlineSignal | null;
  /** Every candidate detected (for per-model transparency), regardless of score. */
  allCandidates: TrendlineCandidate[];
  rejection: TrendlineRejection;
  /** The M1 precise-entry confirmation for the current instrument (may be unconfirmed). */
  entryConfirmation: TrendlineEntryConfirmation;
  /** M15 structure → M7 trend → M5 setup → M3 confirmation → M1 entry (see `timeframes`). */
  structureTimeframe: TimeframeKey;
  setupTimeframe: TimeframeKey;
  entryTimeframe: TimeframeKey;
  /**
   * Top-down timeframe reads: M15 bias, M7 trend & structure, M5 setup, M3 confirmation,
   * M1 entry. M7/M3 entries are present only when those series were supplied.
   */
  timeframes: AiTimeframeRead[];
  atr: number;
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  lastUpdated: number;
  rejectionReason?: string;
}

export interface TrendlineScanSummary {
  winner: TrendlineSignal | null;
  winnerAnalysis: TrendlineInstrumentAnalysis | null;
  /** Every confirmed opportunity across the scanned markets, strongest first. */
  opportunities: TrendlineSignal[];
  scannedCount: number;
  confirmedCount: number;
  scannedAt: number;
  statusBanner: string;
  structureTimeframe: TimeframeKey;
  setupTimeframe: TimeframeKey;
  entryTimeframe: TimeframeKey;
}
