import type { EntryModelId, MarketCondition, QualityBreakdown } from './engine';
import type { MarketFamily, TimeframeKey } from './market';

/**
 * Lifecycle of a managed trade signal. Entry and stop-loss are LOCKED at creation;
 * only the take-profit is dynamic. Duration-free — settlement is structural.
 */
export type ManagedSignalStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'MISSED'
  | 'TARGET_HIT'
  | 'STOP_HIT'
  | 'INVALIDATED';

/** A single dynamic take-profit adjustment with full provenance. */
export interface TpAdjustment {
  previous: number;
  next: number;
  timestamp: number;
  /** Technical justification — never a bare number change. */
  reason: string;
  kind: 'EXTEND' | 'TIGHTEN' | 'INITIAL';
  /** Bar time that triggered the adjustment (for historical replay). */
  barTime: number;
}

/**
 * The immutable entry/stop-loss + dynamic take-profit contract. Mirrors the
 * required implementation shape while adding the fields live validation needs.
 */
export interface ManagedSignal {
  id: string;
  market: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  model: EntryModelId;
  modelLabel: string;
  condition: MarketCondition;
  quality: QualityBreakdown;

  /** LOCKED at publication. Never moved, never replaced. */
  entry: number;
  entryZone: [number, number];
  stopLoss: number;
  /** LOCKED structural invalidation reference (stop-loss is derived from it). */
  invalidationPrice: number;

  /** DYNAMIC — the only mutable price level. */
  takeProfit: number;
  tpHistory: TpAdjustment[];

  status: ManagedSignalStatus;
  qualityScore: number;
  riskRewardRatio: number;
  explanation: string;

  /** Bar time at which the setup was confirmed. */
  createdAt: number;
  confirmedBarTime: number;
  /** Bar time the entry zone was filled (null while PENDING / MISSED). */
  filledAt: number | null;
  /** Bar time the position settled (target/stop/invalidation). */
  settledAt: number | null;
  exitPrice: number | null;
  /** Highest bar time already processed by the manager (guards against re-processing). */
  lastAdvancedBarTime: number;

  /** Excursions measured while ACTIVE (percentage of entry). */
  maxFavourableExcursionPct: number;
  maxAdverseExcursionPct: number;
  lastUpdated: number;
}

/** A completed (or open) backtest trade, derived from a ManagedSignal. */
export interface BacktestTrade {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  model: EntryModelId;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  condition: MarketCondition;
  qualityScore: number;
  entry: number;
  stopLoss: number;
  finalTakeProfit: number;
  exitPrice: number | null;
  status: ManagedSignalStatus;
  /** Realized reward-to-risk (null when never filled). */
  realizedRr: number | null;
  maxFavourableExcursionPct: number;
  maxAdverseExcursionPct: number;
  barsHeld: number;
  confirmedBarTime: number;
  settledBarTime: number | null;
  tpAdjustments: TpAdjustment[];
  /** Static targets derived at publication (structural levels, never invented). */
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
  /** Highest static target index reached (0 = none, 1 = TP1 …). */
  highestTargetReached: 0 | 1 | 2 | 3;
  /** True when both the stop and a target fell inside one candle (sequence unknowable). */
  ambiguous: boolean;
}

export interface EquityPoint {
  index: number;
  barTime: number;
  /** Cumulative reward-to-risk multiple (R) at this trade. */
  equityR: number;
  drawdownR: number;
}

export interface BacktestStats {
  totalSetups: number;
  filledTrades: number;
  wins: number;
  losses: number;
  missed: number;
  invalidated: number;
  winRatePercent: number | null;
  averageRr: number | null;
  maxConsecutiveLosses: number;
  maxDrawdownR: number;
  avgFavourablePct: number | null;
  avgAdversePct: number | null;
  profitFactor: number | null;
}

export interface BacktestReport {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  model: EntryModelId;
  modelLabel: string;
  /** In-sample vs out-of-sample split metadata. */
  totalBars: number;
  warmupBars: number;
  inSampleBars: number;
  outOfSampleBars: number;
  /** Bar time separating in-sample from out-of-sample trades. */
  splitBarTime: number;
  inSample: BacktestStats;
  outOfSample: BacktestStats;
  overall: BacktestStats;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  /** Human-readable notes about data provenance and method. */
  notes: string[];
}

export type TrainingStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'CANCELLED';

export interface TrainingProgress {
  status: TrainingStatus;
  completed: number;
  total: number;
  currentLabel: string;
  message: string;
}

/** Aggregated per-segment performance across all backtest runs. */
export interface TrainingSegment {
  key: string;
  label: string;
  sampleCount: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
  averageRr: number | null;
  maxDrawdownR: number | null;
  avgFavourablePct: number | null;
  avgAdversePct: number | null;
}

export interface TrainingRunResult {
  reports: BacktestReport[];
  generatedAt: number;
  marketCount: number;
  timeframeCount: number;
  modelCount: number;
  totalBarsAnalyzed: number;
}
