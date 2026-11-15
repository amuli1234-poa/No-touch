import type { EntryModelId, MarketCondition, QualityBreakdown, SignalState } from './engine';
import type { MarketFamily, TimeframeKey } from './market';
import type { SignalSnapshot } from './analysis';

/**
 * Verdict of the dual-engine co-analysis. The Market Scanner (breadth engine) and
 * the Chart Analyser (depth engine) evaluate setups independently; this describes
 * how their conclusions reconcile for the same instrument/timeframe.
 */
export type CoAnalysisVerdict =
  | 'ALIGNED' // both engines agree on direction and entry model
  | 'PARTIAL' // both engines agree on direction but differ on model/levels
  | 'CONFLICT' // both engines produced a signal but disagree on direction
  | 'SCANNER_ONLY' // breadth engine confirmed, depth engine has not (yet)
  | 'ANALYSER_ONLY' // depth engine confirmed, breadth engine did not
  | 'NO_SIGNAL'; // neither engine produced a confirmed setup

export interface ReconciledLevels {
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskRewardRatio: number | null;
}

export interface CoAnalysisResult {
  verdict: CoAnalysisVerdict;
  symbol: string;
  timeframe: TimeframeKey;
  scannerDirection: 'RISE' | 'FALL' | 'WAIT' | null;
  analyserDirection: 'RISE' | 'FALL' | 'WAIT' | null;
  agreedDirection: 'RISE' | 'FALL' | null;
  scannerModel: EntryModelId | null;
  analyserModel: EntryModelId | null;
  agreedModel: EntryModelId | null;
  scannerModelLabel: string | null;
  analyserModelLabel: string | null;
  /** 0–100 confidence per engine (null when the engine produced no setup). */
  scannerConfidence: number | null;
  analyserConfidence: number | null;
  /** Blended confidence when both engines agree; otherwise the strongest single engine. */
  combinedConfidence: number | null;
  modelAgreement: boolean;
  levelAgreement: boolean;
  levels: ReconciledLevels | null;
  /** True only when both engines confirm the same direction (shared validation). */
  validated: boolean;
  notes: string[];
}

export type SignalSource = 'SCANNER' | 'ANALYSER' | 'CO-ANALYSIS' | 'TRENDLINE';

/**
 * A single, clickable entry in the unified signal feed. Both engines publish into
 * this shape so the UI renders one consistent card and can deep-link to the exact
 * chart that produced it. Duration-free.
 */
export interface SignalFeedItem {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  model: EntryModelId | null;
  modelLabel: string | null;
  condition: MarketCondition;
  state: SignalState;
  quality: QualityBreakdown | null;
  source: SignalSource;
  confidence: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskRewardRatio: number | null;
  /** Shared-validation flag: the other engine independently agreed. */
  validated: boolean;
  coAnalysis: CoAnalysisResult | null;
  createdAt: number;
  /** Immutable evidence snapshot so the chart can reproduce the exact scanner signal. */
  snapshot: SignalSnapshot | null;
  /** Deep-link target so a click opens the exact chart that produced the signal. */
  target: { symbol: string; timeframe: TimeframeKey };
}
