import type { TimeframeKey } from './market';
import type { TrendlineLine } from './trendline';

/**
 * AI Chart Structure & Future Opportunity Detection types.
 *
 * This layer sits ON TOP of the existing price-action engine: it describes where
 * price currently has meaningful structure (valid BOS/CHOCH, swing-based
 * trendlines, rejection zones, support/resistance bands) and which FRESH zones are
 * worth watching for a future reaction. It never fabricates levels — every zone is
 * derived from confirmed swing structure and a real breakout/reaction.
 *
 * A watch zone is a POTENTIAL opportunity, not an entry. Entries are still published
 * only by the existing entry-model + 85-point quality gate.
 */

/** Continuation break of structure vs reversal change of character. */
export type StructureBreakKind = 'BOS' | 'CHOCH';

export type StructureBias = 'bullish' | 'bearish';

/** A confirmed (body-close) structural break of a protected swing level. */
export interface ValidStructureBreak {
  id: string;
  kind: StructureBreakKind;
  direction: StructureBias;
  /** Confirmation candle time (the bar whose body closed beyond the level). */
  time: number;
  index: number;
  /** The protected swing level that was broken. */
  brokenLevel: number;
  /** The level's origin candle time. */
  levelTime: number;
  levelKind: 'swing-high' | 'swing-low';
  /** Body close beyond the level. */
  closePrice: number;
  /** Distance the close extended beyond the level, in ATR. */
  displacementAtr: number;
  bodyRatio: number;
  momentumConfirmed: boolean;
  reason: string;
}

/** A wick-only breach / liquidity sweep — explicitly NOT a structure break. */
export interface WickSweep {
  id: string;
  direction: StructureBias;
  time: number;
  index: number;
  sweepPrice: number;
  sweptLevel: number;
  reversalClose: number;
  reason: string;
}

export type ZoneFreshness =
  | 'FRESH' // never interacted with
  | 'PROBED' // wick touched only, no body inside
  | 'PARTIALLY_TESTED' // body closed inside the band but not through it
  | 'MITIGATED' // body closed through the far boundary (consumed)
  | 'INVALIDATED'; // decisive close beyond the invalidation level

/** Three-stage future setup progression (mandatory). */
export type SetupStage =
  | 'ZONE_DETECTED'
  | 'PRICE_APPROACHING'
  | 'ENTRY_CONFIRMED'
  | 'FAILED'
  | 'INVALIDATED';

/** A shaded rejection band (repeated reactions + wick rejection + displacement). */
export interface RejectionZone {
  id: string;
  /** Direction of the reaction the zone is expected to produce. */
  direction: 'RISE' | 'FALL';
  upperPrice: number;
  lowerPrice: number;
  originTime: number;
  touches: number;
  wickRejections: number;
  bodyCloses: number;
  displacementAtr: number;
  structuralSignificance: 'major' | 'minor';
  freshness: ZoneFreshness;
  invalidationLevel: number;
  reason: string;
}

/** A current support/resistance price band (never an arbitrary single line). */
export interface SupportResistanceBand {
  id: string;
  type: 'support' | 'resistance';
  upperPrice: number;
  lowerPrice: number;
  touches: number;
  firstTouchTime: number;
  lastTouchTime: number;
  status: 'active' | 'broken';
  importance: 'major' | 'minor';
  reason: string;
}

/**
 * A fair value gap (three-candle imbalance). Price left a gap between candle i-1 and
 * candle i+1 around the displacement candle i. A fresh gap is an unfilled imbalance
 * that price may return to; once price trades back through it the gap is filled and
 * must be removed from the live chart.
 */
export interface FairValueGap {
  id: string;
  direction: 'bullish' | 'bearish';
  /** Expected reaction direction when price returns into the gap. */
  reaction: 'RISE' | 'FALL';
  upperPrice: number;
  lowerPrice: number;
  /** The displacement candle that created the imbalance. */
  time: number;
  index: number;
  /** Gap height in ATR. */
  sizeAtr: number;
  freshness: ZoneFreshness;
  /** Current distance from price to the gap, in ATR. */
  distanceAtr: number;
  /** 0 (far) → 1 (at the gap). */
  approachProgress: number;
  reason: string;
}

/** A fresh, structurally valid FUTURE reaction zone (potential opportunity). */
export interface FutureReactionZone {
  id: string;
  /** Expected reaction direction when price reaches the zone. */
  direction: 'RISE' | 'FALL';
  /** Reclassified role of the source level. */
  kind: 'support' | 'resistance';
  upperPrice: number;
  lowerPrice: number;
  /** Formation timestamp of the source structure. */
  originTime: number;
  /** Timeframe the zone was originally derived on (never re-labelled). */
  originTimeframe: TimeframeKey;
  /** Human-readable source structure (e.g. "broken resistance → potential support"). */
  sourceStructure: string;
  freshness: ZoneFreshness;
  stage: SetupStage;
  invalidationLevel: number;
  invalidationCondition: string;
  reactions: number;
  /** Current distance from price to the near boundary, in ATR. */
  distanceAtr: number;
  /** 0 (far) → 1 (at the zone). */
  approachProgress: number;
  reason: string;
  evidence: string[];
}

export interface StructureEngineResult {
  breaks: ValidStructureBreak[];
  rejectedSweeps: WickSweep[];
  protectedHigh: number | null;
  protectedLow: number | null;
  bias: StructureBias | 'neutral';
  /** Valid swing-anchored trendlines (invalidated lines are omitted). */
  trendlines: TrendlineLine[];
  rejectionZones: RejectionZone[];
  srBands: SupportResistanceBand[];
  /** Fresh, unfilled fair value gaps (imbalances) near price. */
  fvg: FairValueGap[];
  /** All watch zones with their current three-stage status. */
  watchZones: FutureReactionZone[];
  /** Watch zones still worth watching (fresh, not failed/invalidated). */
  activeWatch: FutureReactionZone[];
  /** Zones already probed/mitigated or failed — kept for the optional tested-zone layer. */
  testedWatch: FutureReactionZone[];
  summary: string;
}

export interface MultiTimeframeStructureResult {
  activeTimeframe: TimeframeKey;
  /** Higher-timeframe directional control used for bias. */
  htfBias: StructureBias | 'neutral';
  htfTimeframe: TimeframeKey | null;
  result: StructureEngineResult;
  /** Zones merged across timeframes, deduped, each preserving its origin timeframe. */
  mergedWatchZones: FutureReactionZone[];
}

/**
 * The slice of structure data the chart draws. Fresh zones only — mitigated and
 * invalidated zones are removed before this is produced so the live chart never
 * accumulates old drawings. Historical zone records are kept internally for AI
 * training (see {@link StructureHistoryRecord}).
 */
export interface StructureOverlayData {
  bias: StructureBias | 'neutral';
  htfBias: StructureBias | 'neutral';
  htfTimeframe: TimeframeKey | null;
  /** Confirmed BOS/CHOCH only (wick sweeps are excluded from the structure layer). */
  breaks: ValidStructureBreak[];
  rejectionZones: RejectionZone[];
  srBands: SupportResistanceBand[];
  /** Fresh, unfilled fair value gaps (imbalances) near price. */
  fvg: FairValueGap[];
  /** Fresh/approachable watch zones with their current three-stage status. */
  watchZones: FutureReactionZone[];
  /** Tested/mitigated zones — only drawn when "show tested zones" is enabled. */
  testedZones: FutureReactionZone[];
  summary: string;
}

/** An internal, never-drawn record kept for AI training / backtesting. */
export interface StructureHistoryRecord {
  zoneId: string;
  symbol: string;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  upperPrice: number;
  lowerPrice: number;
  originTime: number;
  sourceStructure: string;
  finalFreshness: ZoneFreshness;
  finalStage: SetupStage;
  recordedAt: number;
}

