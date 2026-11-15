import type { AiDirection } from './aiModule';
import type { TimeframeKey } from './market';

/**
 * AI ALERTS & NOTIFICATION MANAGER — shared vocabulary.
 *
 * The alert layer is a COLLECTOR: it never decides anything about the market. Every module
 * keeps its own analysis logic; this layer only receives their published state, filters it,
 * de-duplicates it and communicates the events that actually matter.
 */

export type AlertPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Alert lifecycle — an alert is updated in place as the setup develops. */
export type AlertStatus =
  | 'DEVELOPING'
  | 'APPROACHING'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'TARGET_REACHED'
  | 'STOP_LOSS'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'MISSED';

export type AlertCategory =
  | 'SETUP_DEVELOPING'
  | 'ZONE_APPROACHING'
  | 'ZONE_ENTERED'
  | 'LIQUIDITY_SWEEP'
  | 'STRUCTURE_BREAK'
  | 'DISPLACEMENT'
  | 'FVG_RETEST'
  | 'ORDER_BLOCK_RETEST'
  | 'BREAKOUT_CONFIRMED'
  | 'BREAKOUT_FAILED'
  | 'MOMENTUM_CONFIRMATION'
  | 'EXECUTION_READY'
  | 'SETUP_INVALIDATED'
  | 'ENTRY_MISSED'
  | 'TARGET_REACHED'
  | 'STOP_LOSS_REACHED'
  | 'REGIME_CHANGE'
  | 'QUALITY_LOST'
  | 'DATA_ISSUE'
  | 'RISK_LIMIT';

export const ALERT_PRIORITY_ORDER: readonly AlertPriority[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
];

export const ALERT_PRIORITY_LABELS: Record<AlertPriority, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  DEVELOPING: 'Developing',
  APPROACHING: 'Approaching',
  CONFIRMED: 'Confirmed',
  ACTIVE: 'Active',
  TARGET_REACHED: 'Target Reached',
  STOP_LOSS: 'Stop-Loss',
  INVALIDATED: 'Invalidated',
  EXPIRED: 'Expired',
  MISSED: 'Entry Missed',
};

export const ALERT_CATEGORY_LABELS: Record<AlertCategory, string> = {
  SETUP_DEVELOPING: 'Setup developing',
  ZONE_APPROACHING: 'Price approaching zone',
  ZONE_ENTERED: 'Price entered zone',
  LIQUIDITY_SWEEP: 'Liquidity sweep',
  STRUCTURE_BREAK: 'BOS / CHOCH confirmed',
  DISPLACEMENT: 'Strong displacement',
  FVG_RETEST: 'FVG / imbalance retest',
  ORDER_BLOCK_RETEST: 'Order block / breaker retest',
  BREAKOUT_CONFIRMED: 'Breakout confirmed',
  BREAKOUT_FAILED: 'Breakout failed',
  MOMENTUM_CONFIRMATION: 'Momentum confirmation',
  EXECUTION_READY: 'Execution ready',
  SETUP_INVALIDATED: 'Setup invalidated',
  ENTRY_MISSED: 'Entry missed',
  TARGET_REACHED: 'Target reached',
  STOP_LOSS_REACHED: 'Stop-loss reached',
  REGIME_CHANGE: 'Regime / direction change',
  QUALITY_LOST: 'Opportunity quality lost',
  DATA_ISSUE: 'Data / connection issue',
  RISK_LIMIT: 'Risk limit reached',
};

/** Where the alert was observed. The alert layer never invents a source. */
export type AlertSource = 'AI_MODULE' | 'JOURNAL' | 'MANAGED' | 'FEED' | 'SYSTEM';

export interface AiAlert {
  /** Stable de-duplication key (symbol + direction + model + zone). */
  id: string;
  symbol: string;
  displayName: string;
  direction: AiDirection | null;
  price: number;
  timeframe: TimeframeKey;
  /** Module that produced the evidence (never merged across modules). */
  module: string;
  /** Stable module id (drives per-module enable/disable). */
  moduleId: string;
  source: AlertSource;
  modelId: string;
  modelLabel: string;
  entryPrice: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskRewardRatio: number | null;
  quality: number;
  priority: AlertPriority;
  category: AlertCategory;
  status: AlertStatus;
  explanation: string;
  evidence: string[];
  confidence: number;
  firstSeenAt: number;
  createdAt: number;
  updatedAt: number;
  /** Number of meaningful revisions since the alert was first raised. */
  revisions: number;
  read: boolean;
  dismissed: boolean;
  /** True once the user has been actively notified (channel delivery succeeded). */
  notified: boolean;
}

export type AlertChannel = 'IN_APP' | 'SOUND' | 'BROWSER';

export interface QuietHours {
  enabled: boolean;
  /** Local hour (0–23) the quiet window starts. */
  startHour: number;
  /** Local hour (0–23) the quiet window ends. */
  endHour: number;
}

export interface AlertSettings {
  /** Master switch. When off nothing is delivered (events are still recorded). */
  enabled: boolean;
  /** Modules whose events may raise alerts (by module id). */
  enabledModules: Record<string, boolean>;
  /** Priorities allowed to deliver a notification. */
  enabledPriorities: Record<AlertPriority, boolean>;
  /** Preferred indices (empty = all). */
  enabledSymbols: string[];
  /** Timeframes that may raise alerts (empty = all). */
  enabledTimeframes: TimeframeKey[];
  channels: Record<AlertChannel, boolean>;
  quietHours: QuietHours;
  /** Minimum setup quality (0–100) required to alert. */
  minQuality: number;
  /** Maximum delivered notifications per rolling hour. */
  maxPerHour: number;
  /** Whether developing (not yet confirmed) setups may alert. */
  developingAlerts: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  enabledModules: {},
  enabledPriorities: { CRITICAL: true, HIGH: true, MEDIUM: true, LOW: false },
  enabledSymbols: [],
  enabledTimeframes: [],
  channels: { IN_APP: true, SOUND: true, BROWSER: false },
  quietHours: { enabled: false, startHour: 22, endHour: 7 },
  minQuality: 70,
  maxPerHour: 20,
  developingAlerts: true,
};

export interface AlertFilters {
  symbol: string | 'ALL';
  direction: AiDirection | 'ALL';
  module: string | 'ALL';
  priority: AlertPriority | 'ALL';
  timeframe: TimeframeKey | 'ALL';
  status: AlertStatus | 'ALL';
  /** Epoch ms lower bound, or null for all time. */
  since: number | null;
  /** Only show unread alerts. */
  unreadOnly: boolean;
  /** Include dismissed alerts. */
  includeDismissed: boolean;
}

export const DEFAULT_ALERT_FILTERS: AlertFilters = {
  symbol: 'ALL',
  direction: 'ALL',
  module: 'ALL',
  priority: 'ALL',
  timeframe: 'ALL',
  status: 'ALL',
  since: null,
  unreadOnly: false,
  includeDismissed: false,
};

/** Aggregated alert accuracy, separated from trades actually executed. */
export interface AlertOutcomeStats {
  total: number;
  read: number;
  dismissed: number;
  byPriority: Record<AlertPriority, number>;
  confirmed: number;
  invalidated: number;
  targetReached: number;
  stopLoss: number;
  missed: number;
  expired: number;
  /** Alerts that resolved to a target vs. alerts that resolved either way. */
  accuracyPercent: number | null;
}
