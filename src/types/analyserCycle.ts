import type { MarketFamily, TimeframeKey } from './market';
import type { EntryModelId, MarketCondition, QualityBreakdown } from './engine';
import type { EntryModelKind } from './entryModelAI';

/**
 * AUTOMATIC CHART RESET & FRESH-ENTRY CYCLE — types.
 *
 * The Chart Analyser AI runs one automatic trade-completion cycle:
 *   Active setup → TP/SL hit → verify against live price → save trade data →
 *   clear the completed chart markings → re-analyse → validate a new setup →
 *   display the fresh entry (or stay clean and WAITING).
 *
 * Nothing here invents data: a completion is only ever recorded when price genuinely
 * reached the locked target or stop, and every completed trade is permanent history.
 */

/** How a displayed analyser setup finally resolved. */
export type AnalyserTradeOutcome = 'TARGET_HIT' | 'STOP_HIT';

/** Where the completion was verified. */
export type AnalyserVerificationSource = 'LIVE_PRICE' | 'CONFIRMED_CANDLE';

/** The phases of the automatic cycle (matches the expected flow). */
export type AnalyserCyclePhase =
  | 'WAITING' // no active setup — the chart is clean
  | 'ACTIVE_SETUP' // a setup is displayed and being monitored
  | 'VERIFYING' // TP/SL verification against live price in progress
  | 'RECORDING' // saving the completed trade data
  | 'CLEARING' // erasing the completed chart markings
  | 'REANALYSING' // fresh analysis running on current price action
  | 'VALIDATING' // validating the newly generated setup
  | 'FRESH_ENTRY'; // a fresh, valid setup is displayed

/** Accuracy statistics for one completed trade. */
export interface AnalyserTradeAccuracy {
  /** Planned reward-to-risk at entry (reward distance ÷ risk distance). */
  plannedRr: number | null;
  /** Realised R multiple at exit (+plannedRr on a target, −1 on a stop). */
  realisedRr: number;
  /** Distance from entry to the take-profit (price units). */
  rewardDistance: number;
  /** Distance from entry to the stop-loss (price units). */
  riskDistance: number;
  /** 100 when the target was reached, 0 when the stop was hit. */
  accuracyPercent: number;
  /** The win rate this setup needed to break even: 100 ÷ (1 + planned R:R). */
  breakEvenAccuracyPercent: number | null;
  /** Signed outcome for aggregation: +1 win, −1 loss. */
  signedOutcome: 1 | -1;
}

/** The chart-analysis evidence preserved with a completed trade. */
export interface AnalyserTradeChartData {
  qualityScore: number;
  quality: QualityBreakdown;
  condition: MarketCondition;
  confirmationExplanation: string;
  reasons: string[];
  bosChochEvidence: string[];
  momentumEvidence: string[];
  entryTrigger: string;
  availableSpaceAtr: number;
  availableSpaceLabel: string;
  confluenceScore: number;
  maxConfluenceScore: number;
  htfAlignmentSummary: string;
  currentStructureSummary: string;
  /** Bar time of the candle that confirmed the setup. */
  confirmedBarTime: number;
}

/**
 * A permanently-recorded completed analyser trade. Append-only: an id already in the
 * ledger is never overwritten, and the ledger is never cleared by normal operation.
 */
export interface CompletedAnalyserTrade {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  /** Originating strategy label (e.g. 'Chart Analyser'). */
  strategyLabel: string;
  /** The strategy/model the analyser itself detected. */
  strategyId: string;
  modelId: EntryModelId;
  modelLabel: string;
  /** The entry model the universal Entry Model AI selected (when available). */
  entryModel: EntryModelKind | 'UNKNOWN';
  entryModelLabel: string;

  entry: number;
  takeProfit: number;
  stopLoss: number;
  invalidationPrice: number;
  entryZone: [number, number] | null;
  riskRewardRatio: number;

  outcome: AnalyserTradeOutcome;
  exitPrice: number;
  /** Bar time the trade settled (seconds). */
  settledBarTime: number;
  /** Epoch ms the setup was confirmed. */
  confirmedAt: number;
  /** Wall-clock ms the trade was recorded. */
  settledAt: number;
  barsHeld: number;
  verified: boolean;
  verificationSource: AnalyserVerificationSource;

  accuracy: AnalyserTradeAccuracy;
  chartAnalysis: AnalyserTradeChartData;
}

/** The verdict of verifying one setup against fresh candles + live price. */
export interface AnalyserCompletionVerdict {
  completed: boolean;
  outcome: AnalyserTradeOutcome | null;
  exitPrice: number | null;
  /** Bar time of the settling candle (seconds). */
  settledBarTime: number | null;
  barsHeld: number;
  verified: boolean;
  verificationSource: AnalyserVerificationSource;
  note: string;
}

/** The minimal shape the completion verifier needs from a displayed setup. */
export interface AnalyserSetupForCompletion {
  id: string;
  symbol: string;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  entry: number;
  takeProfit: number;
  stopLoss: number;
  confirmedBarTime: number;
}

/** Duplicate / conflict prevention input: the currently displayed setup. */
export interface DisplayedSetupIdentity {
  id: string;
  symbol: string;
  timeframe: TimeframeKey;
  strategyId: string;
  direction: 'RISE' | 'FALL';
  createdAt: number;
}

/** A candidate setup attempting to reach the chart. */
export interface DisplayGuardInput {
  id: string;
  symbol: string;
  timeframe: TimeframeKey;
  strategyId: string;
  direction: 'RISE' | 'FALL';
  createdAt: number;
  /** Bar time of the candle that confirmed the candidate. */
  confirmedBarTime: number;
  /** The newest confirmed candle bar time available for this instrument. */
  latestConfirmedBarTime: number;
}

export interface DisplayGuardResult {
  display: boolean;
  reason: string;
}

/** Live cycle state exposed to the UI. */
export interface AnalyserCycleState {
  phase: AnalyserCyclePhase;
  /** The setup currently displayed (null while clean/WAITING). */
  activeSetupId: string | null;
  /** The most recently completed trade (null before the first completion). */
  lastTrade: CompletedAnalyserTrade | null;
  /** Number of trades completed this session. */
  completedCount: number;
  /** Human-readable status for the current phase. */
  message: string;
}
