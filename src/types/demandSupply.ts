import type { TopDownAnalysis } from './topDown';
import type { MarketFamily, TimeframeKey } from './market';

/**
 * DEMAND & SUPPLY AI types — a fully independent strategy module.
 *
 * Primary supply/demand identification is performed on M15; the trend and market structure
 * are read on M7; zones are refined and setups developed on M5; the entry setup is confirmed
 * on M3; entries are confirmed on M1. Nothing here shares state with the price-action engine
 * or the Trendline AI.
 */

/** Which side of the market a zone supplies liquidity from. */
export type DsZoneType = 'demand' | 'supply';

/** The five base/leg formations a valid zone can originate from. */
export type DsZoneFormation =
  | 'DBR' // Drop-Base-Rally → demand
  | 'RBR' // Rally-Base-Rally → demand
  | 'RBD' // Rally-Base-Drop → supply
  | 'DBD' // Drop-Base-Drop → supply
  | 'NONE';

export const DS_FORMATION_LABELS: Record<DsZoneFormation, string> = {
  DBR: 'Drop-Base-Rally',
  RBR: 'Rally-Base-Rally',
  RBD: 'Rally-Base-Drop',
  DBD: 'Drop-Base-Drop',
  NONE: 'Unclassified',
};

/**
 * Zone lifecycle. A zone is never deleted while it is current — its state is tracked:
 *  - FRESH      : untested since it formed (proximal edge intact);
 *  - TESTED     : price has touched the proximal edge but the zone is still valid;
 *  - PARTIALLY_MITIGATED : price traded into the body without reaching the distal edge;
 *  - FULLY_MITIGATED     : price reached the distal edge (zone consumed);
 *  - INVALIDATED : price closed decisively beyond the distal edge (zone failed).
 */
export type DsZoneState =
  | 'FRESH'
  | 'TESTED'
  | 'PARTIALLY_MITIGATED'
  | 'FULLY_MITIGATED'
  | 'INVALIDATED';

/** The independent entry models on each side (RISE / FALL). */
export type DsEntryModelId =
  | 'DS_FRESH_REJECTION'
  | 'DS_RETEST_CONTINUATION'
  | 'DS_LIQUIDITY_SWEEP_RECLAIM'
  | 'DS_FVG_CONFLUENCE'
  | 'DS_ORDER_BLOCK_RETEST'
  | 'DS_BREAKER_RETEST'
  | 'DS_M1_BOS_CHOCH'
  | 'DS_ENGULFING_CONFIRMATION';

export const DS_MODEL_LABELS: Record<DsEntryModelId, string> = {
  DS_FRESH_REJECTION: 'Fresh Zone Rejection',
  DS_RETEST_CONTINUATION: 'Zone Retest Continuation',
  DS_LIQUIDITY_SWEEP_RECLAIM: 'Liquidity Sweep & Reclaim',
  DS_FVG_CONFLUENCE: 'Zone + FVG Confluence',
  DS_ORDER_BLOCK_RETEST: 'Order Block Retest',
  DS_BREAKER_RETEST: 'Breaker Block Retest',
  DS_M1_BOS_CHOCH: 'M1 BOS / CHOCH Confirmation',
  DS_ENGULFING_CONFIRMATION: 'Engulfing Confirmation',
};

export const DS_MODEL_IDS: readonly DsEntryModelId[] = [
  'DS_FRESH_REJECTION',
  'DS_RETEST_CONTINUATION',
  'DS_LIQUIDITY_SWEEP_RECLAIM',
  'DS_FVG_CONFLUENCE',
  'DS_ORDER_BLOCK_RETEST',
  'DS_BREAKER_RETEST',
  'DS_M1_BOS_CHOCH',
  'DS_ENGULFING_CONFIRMATION',
];

/** Concise label for chips / list rows. */
export const DS_MODEL_SHORT: Record<DsEntryModelId, string> = {
  DS_FRESH_REJECTION: 'Fresh Rejection',
  DS_RETEST_CONTINUATION: 'Retest Continuation',
  DS_LIQUIDITY_SWEEP_RECLAIM: 'Sweep & Reclaim',
  DS_FVG_CONFLUENCE: 'FVG Confluence',
  DS_ORDER_BLOCK_RETEST: 'Order Block',
  DS_BREAKER_RETEST: 'Breaker',
  DS_M1_BOS_CHOCH: 'M1 BOS/CHOCH',
  DS_ENGULFING_CONFIRMATION: 'Engulfing',
};

/**
 * The evidence that ORIGINATED a zone. A genuine zone is left by a departure, not merely
 * by a candle high/low — these flags record which structural evidence is present.
 */
export type DsZoneOrigin =
  | 'DISPLACEMENT'
  | 'ENGULFING'
  | 'LIQUIDITY_SWEEP'
  | 'IMBALANCE'
  | 'BOS';

export const DS_ORIGIN_LABELS: Record<DsZoneOrigin, string> = {
  DISPLACEMENT: 'Strong displacement',
  ENGULFING: 'Engulfing departure',
  LIQUIDITY_SWEEP: 'Liquidity sweep',
  IMBALANCE: 'Imbalance / FVG',
  BOS: 'Break of structure',
};

/** Component scores (100-point zone-quality / setup technical quality — NOT a win rate). */
export interface DsZoneScore {
  /** Zone origin quality: formation clarity + displacement strength + base tightness. /25 */
  formationQuality: number;
  /** Displacement magnitude that left the zone (in ATR). /15 */
  displacement: number;
  /** Lifecycle / freshness weighting (fresh > tested > mitigated). /15 */
  freshness: number;
  /** BOS originated by this zone (the zone caused structure to break). /10 */
  bosOrigin: number;
  /** FVG confluence inside / adjacent to the zone. /10 */
  fvgConfluence: number;
  /** Alignment with the higher-timeframe (M15) directional context. /15 */
  htfAlignment: number;
  /** Available room from the zone to the nearest opposing level (realistic reaction). /10 */
  roomToTarget: number;
  total: number; // /100
}

/** Zone lifecycle timeline (times are candle open times, seconds). */
export interface DsZoneLifecycle {
  formedTime: number;
  formedIndex: number;
  /** First time price returned into the proximal edge after formation. */
  firstTestTime: number | null;
  /** Time price reached the distal edge (fully mitigated), if it has. */
  distalReachedTime: number | null;
  /** Time price closed beyond the distal edge (invalidated), if it has. */
  invalidatedTime: number | null;
}

/** A single demand or supply zone, refined on the entry timeframe. */
export interface DsZone {
  id: string;
  type: DsZoneType;
  formation: DsZoneFormation;
  formationLabel: string;
  state: DsZoneState;
  /** Proximal edge — the nearest boundary to current price (entry side). */
  proximalPrice: number;
  /** Distal edge — the far boundary (invalidation side). */
  distalPrice: number;
  upperPrice: number;
  lowerPrice: number;
  /** Origin candle (base) of the zone, on M15. */
  originTime: number;
  originIndex: number;
  /** Displacement that left the zone, in ATR. */
  displacementAtr: number;
  /** How many times price has interacted with the zone since it formed. */
  touches: number;
  /** True when the zone has never been tested (proximal edge untouched). */
  untested: boolean;
  /** True when a BOS was produced by the move out of this zone. */
  causedBos: boolean;
  /** The structural evidence that originated this zone (displacement / engulfing / …). */
  origins: DsZoneOrigin[];
  /** A same-direction fair value gap overlaps this zone. */
  hasFvgConfluence: boolean;
  /** The overlapping FVG's bounds, when present. */
  fvg: { upperPrice: number; lowerPrice: number } | null;
  /** The zone's role has flipped (broken demand acting as supply, etc.). */
  flipped: boolean;
  /** Current distance from price to the proximal edge, in ATR. */
  distanceAtr: number;
  /** True when this is a FUTURE watch zone: still ahead of price and untouched. */
  isFutureWatch: boolean;
  lifecycle: DsZoneLifecycle;
  score: DsZoneScore;
  reason: string;
}

/** Mandatory M1 rejection confirmation attached to every confirmed signal. */
export interface DsConfirmation {
  confirmed: boolean;
  kind: 'BULLISH_REJECTION' | 'BEARISH_REJECTION' | 'NONE';
  timeframe: TimeframeKey;
  time: number;
  /** Wick extreme that probed the zone. */
  wickPrice: number;
  close: number;
  /** 0–1 (wick dominance + close conviction). */
  strength: number;
  reason: string;
}

/** M5 setup development stage, tracked independently of the M1 confirmation. */
export type DsSetupStage =
  | 'NONE'
  | 'PRICE_APPROACHING'
  | 'AT_ZONE'
  | 'SETUP_DEVELOPING'
  | 'READY_FOR_CONFIRMATION';

export interface DsCandidate {
  model: DsEntryModelId;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  zone: DsZone;
  /** The M5 bar the setup was detected on. */
  setupTime: number;
  entryPrice: number;
  /** The entry range (proximal–distal band the order is placed within). */
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  /** TP3 is only present when a third structural target is technically justified. */
  takeProfit3: number | null;
  invalidationPrice: number;
  invalidationCondition: string;
  riskRewardRatio: number;
  /** Mandatory M1 rejection confirmation. */
  confirmation: DsConfirmation;
  setupStage: DsSetupStage;
  score: number; // 0–100
  reasons: string[];
  confirmations: string[];
  /** M15 zone context line for the UI. */
  m15Context: string;
  /** M5 setup line for the UI. */
  m5Setup: string;
  /** M1 confirmation line for the UI. */
  m1Confirmation: string;
}

/** Full signal status vocabulary for the Demand & Supply AI. */
export type DsSignalStatus =
  | 'ANALYSING'
  | 'FRESH_DEMAND_FOUND'
  | 'FRESH_SUPPLY_FOUND'
  | 'WATCHING_DEMAND'
  | 'WATCHING_SUPPLY'
  | 'WAITING_FOR_CONFIRMATION'
  | 'RISE_CONFIRMED'
  | 'FALL_CONFIRMED'
  | 'SETUP_INVALIDATED'
  | 'NO_VALID_SETUP';

export const DS_STATUS_LABELS: Record<DsSignalStatus, string> = {
  ANALYSING: 'Analysing',
  FRESH_DEMAND_FOUND: 'Fresh Demand Found',
  FRESH_SUPPLY_FOUND: 'Fresh Supply Found',
  WATCHING_DEMAND: 'Watching Demand',
  WATCHING_SUPPLY: 'Watching Supply',
  WAITING_FOR_CONFIRMATION: 'Waiting For Confirmation',
  RISE_CONFIRMED: 'Rise Confirmed',
  FALL_CONFIRMED: 'Fall Confirmed',
  SETUP_INVALIDATED: 'Setup Invalidated',
  NO_VALID_SETUP: 'No Valid Setup',
};

export type DsSignalLifecycle = 'CONFIRMED' | 'ACTIVE' | 'INVALIDATED' | 'COMPLETED';

export interface DsSignal {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  direction: 'RISE' | 'FALL';
  model: DsEntryModelId;
  modelLabel: string;
  /** M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1 top-down chain. */
  structureTimeframe: TimeframeKey;
  trendTimeframe: TimeframeKey;
  setupTimeframe: TimeframeKey;
  confirmTimeframe: TimeframeKey;
  entryTimeframe: TimeframeKey;
  score: number;
  zoneQuality: number;
  entryPrice: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
  invalidationPrice: number;
  invalidationCondition: string;
  riskRewardRatio: number;
  zone: DsZone;
  confirmation: DsConfirmation;
  setupStage: DsSetupStage;
  reasons: string[];
  confirmations: string[];
  m15Context: string;
  m5Setup: string;
  m1Confirmation: string;
  status: DsSignalLifecycle;
  createdAt: number;
  confirmedBarTime: number;
  lastUpdated: number;
}

/** The top-down timeframe context surfaced in the signal panel (M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1). */
export interface DsTimeframeRead {
  timeframe: TimeframeKey;
  label: string;
  /** What this timeframe currently shows. */
  detail: string;
  tone: 'bull' | 'bear' | 'warn' | 'neutral';
}

export interface DsInstrumentAnalysis {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  price: number;
  /** Full signal status for the panel. */
  status: DsSignalStatus;
  statusExplanation: string;
  /** M15 demand/supply context, M5 setup status, M1 confirmation status. */
  timeframes: DsTimeframeRead[];
  /** Current valid zones (demand = blue, supply = red), nearest first. */
  zones: DsZone[];
  /** Nearest fresh demand / supply zone, for the "fresh found" statuses. */
  freshDemand: DsZone | null;
  freshSupply: DsZone | null;
  /** The zone price is currently working with (nearest in play), if any. */
  activeZone: DsZone | null;
  /** Best candidate this pass (null when nothing clears the 85 gate). */
  bestCandidate: DsCandidate | null;
  signal: DsSignal | null;
  allCandidates: DsCandidate[];
  /** FUTURE watch zones: still ahead of price and untested (where price may react NEXT). */
  futureWatchZones: DsZone[];
  /** M15 demand/supply balance read. */
  demandSupplyBalance: 'DEMAND_DOMINANT' | 'SUPPLY_DOMINANT' | 'BALANCED';
  atr: number;
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  lastUpdated: number;
  rejectionReason?: string;
  /** Top-down ten-timeframe ladder read for this index (same shared shape as every AI). */
  topDown?: TopDownAnalysis;
}

export interface DsScanSummary {
  winner: DsSignal | null;
  winnerAnalysis: DsInstrumentAnalysis | null;
  opportunities: DsSignal[];
  scannedCount: number;
  confirmedCount: number;
  scannedAt: number;
  statusBanner: string;
  structureTimeframe: TimeframeKey;
  setupTimeframe: TimeframeKey;
  entryTimeframe: TimeframeKey;
}
