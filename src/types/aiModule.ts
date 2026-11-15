import type { MarketFamily, TimeframeKey } from './market';

/**
 * Shared vocabulary for the independent AI strategy modules (Support & Resistance AI,
 * Chart Patterns AI, BOS & CHOCH AI, Technical AI, SMC/ICT & Price Action AI).
 *
 * Each module owns its OWN analysis engine and produces these shapes. The shared
 * framework only provides plumbing (fetching, scanning, lifecycle, drawing) — never a
 * decision. A module never copies another module's conclusions.
 */

export type AiDirection = 'RISE' | 'FALL';

/** Adaptive market read every module classifies before it searches for a setup. */
export type AiMarketCondition =
  | 'STRONG_BULLISH'
  | 'STRONG_BEARISH'
  | 'WEAK_TREND'
  | 'RANGING'
  | 'CONSOLIDATION'
  | 'POTENTIAL_REVERSAL'
  | 'VOLATILITY_EXPANSION'
  | 'VOLATILITY_CONTRACTION'
  | 'UNCLEAR';

export const AI_CONDITION_LABELS: Record<AiMarketCondition, string> = {
  STRONG_BULLISH: 'Strong bullish trend',
  STRONG_BEARISH: 'Strong bearish trend',
  WEAK_TREND: 'Weak trend',
  RANGING: 'Ranging market',
  CONSOLIDATION: 'Consolidation',
  POTENTIAL_REVERSAL: 'Potential reversal',
  VOLATILITY_EXPANSION: 'Volatility expansion',
  VOLATILITY_CONTRACTION: 'Volatility contraction',
  UNCLEAR: 'Unclear / conflicting',
};

/** Full status vocabulary shared by every module (developing never reads as confirmed). */
export type AiSignalStatus =
  | 'ANALYSING'
  | 'WATCHING'
  | 'WAITING_FOR_SETUP'
  | 'WAITING_FOR_CONFIRMATION'
  | 'CONFIRMED'
  | 'INVALIDATED'
  | 'NO_VALID_SETUP'
  // Module-specific developing / regime states (never read as confirmed entries).
  | 'FRESH_ZONE'
  | 'APPROACHING'
  | 'APPROACHING_ENTRY'
  | 'DEVELOPING'
  | 'WAITING_FOR_REJECTION'
  | 'MOMENTUM_BUILDING'
  | 'MOMENTUM_WEAKENING'
  | 'VOLATILITY_COMPRESSION'
  | 'BREAKOUT_DEVELOPING'
  | 'TRENDING'
  | 'RANGING'
  | 'CONSOLIDATING'
  | 'COMPRESSION'
  | 'EXPANSION_DEVELOPING'
  | 'TRANSITIONING'
  | 'CONFIRMED_BREAKOUT'
  | 'UNCLEAR'
  | 'ACTIVE'
  | 'TARGET_REACHED'
  | 'EXPIRED'
  | 'NO_HIGH_QUALITY_OPPORTUNITY';

export const AI_STATUS_LABELS: Record<AiSignalStatus, string> = {
  ANALYSING: 'Analysing',
  WATCHING: 'Watching',
  WAITING_FOR_SETUP: 'Waiting For Setup',
  WAITING_FOR_CONFIRMATION: 'Waiting For Confirmation',
  CONFIRMED: 'Confirmed',
  INVALIDATED: 'Invalidated',
  NO_VALID_SETUP: 'No Valid Setup',
  FRESH_ZONE: 'Fresh Zone',
  APPROACHING: 'Approaching',
  APPROACHING_ENTRY: 'Approaching Entry',
  DEVELOPING: 'Developing',
  WAITING_FOR_REJECTION: 'Waiting For Rejection',
  MOMENTUM_BUILDING: 'Momentum Building',
  MOMENTUM_WEAKENING: 'Momentum Weakening',
  VOLATILITY_COMPRESSION: 'Volatility Compression',
  BREAKOUT_DEVELOPING: 'Breakout Developing',
  TRENDING: 'Trending',
  RANGING: 'Ranging',
  CONSOLIDATING: 'Consolidating',
  COMPRESSION: 'Compression',
  EXPANSION_DEVELOPING: 'Expansion Developing',
  TRANSITIONING: 'Transitioning',
  CONFIRMED_BREAKOUT: 'Confirmed Breakout',
  UNCLEAR: 'Unclear',
  ACTIVE: 'Active',
  TARGET_REACHED: 'Target Reached',
  EXPIRED: 'Expired',
  NO_HIGH_QUALITY_OPPORTUNITY: 'No High-Quality Opportunity',
};

/** Chart-drawable level kinds (blue bullish / red bearish, minimal labels). */
export type AiLevelKind = 'entry' | 'stop' | 'target' | 'level' | 'liquidity';

export interface AiLevel {
  price: number;
  label: string;
  kind: AiLevelKind;
  /** Optional timestamp the level is anchored to (structure point). */
  time?: number;
}

/** A reaction zone the chart may draw (entry zone, S/R band, order block, pattern neckline…). */
export interface AiZone {
  id: string;
  /** Expected reaction direction. */
  direction: AiDirection;
  /** Short label, e.g. "SUPPORT", "DEMAND", "BULLISH OB", "BOS". */
  label: string;
  upperPrice: number;
  lowerPrice: number;
  /** 0–100 structural quality. */
  quality: number;
  fresh: boolean;
  /** True when this is a FUTURE watch zone: ahead of price and still valid. */
  watch: boolean;
  reason: string;
}

export interface AiTimeframeRead {
  timeframe: TimeframeKey;
  label: string;
  detail: string;
  tone: 'bull' | 'bear' | 'warn' | 'neutral';
}

export interface AiSignal {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  direction: AiDirection;
  /** Module-specific model id + label (e.g. `SR_ROLE_FLIP`, `TECH_EMA_PULLBACK`). */
  modelId: string;
  modelLabel: string;
  /** Module-specific strategy / condition read. */
  strategyLabel: string;
  status: AiSignalStatus;
  /** Trade lifecycle tracked against fresh candles (entry/stop locked at publication). */
  lifecycle: AiSignalLifecycle;
  score: number;
  condition: AiMarketCondition;
  entryPrice: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
  riskRewardRatio: number;
  invalidationCondition: string;
  reasons: string[];
  confirmations: string[];
  timeframes: AiTimeframeRead[];
  /** Chart levels (entry / stop / targets / structural levels). */
  levels: AiLevel[];
  createdAt: number;
  confirmedBarTime: number;
  lastUpdated: number;
}

export interface AiInstrumentAnalysis {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  price: number;
  status: AiSignalStatus;
  statusExplanation: string;
  condition: AiMarketCondition;
  timeframes: AiTimeframeRead[];
  /** Published signal (only when it clears the module's gate). */
  signal: AiSignal | null;
  /** Current valid zones in play (nearest first). */
  activeZones: AiZone[];
  /** FUTURE watch zones — ahead of price, still valid. */
  watchZones: AiZone[];
  /** Best candidate score this pass, even when it does not publish. */
  bestScore: number;
  atr: number;
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  lastUpdated: number;
  rejectionReason?: string;
}

export interface AiScanSummary {
  winner: AiSignal | null;
  winnerAnalysis: AiInstrumentAnalysis | null;
  opportunities: AiSignal[];
  scannedCount: number;
  confirmedCount: number;
  scannedAt: number;
  statusBanner: string;
}

export type AiSignalLifecycle = 'CONFIRMED' | 'ACTIVE' | 'INVALIDATED' | 'COMPLETED';
