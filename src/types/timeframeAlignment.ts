import type { TimeframeKey } from './market';
import type { StructuredMarketRead, StructuredTradeLevels } from './structuredRead';

/** The four top-down roles the alignment ladder groups its timeframes into. */
export type AlignmentRole = 'MAJOR' | 'INTERMEDIATE' | 'SETUP' | 'REFINEMENT';

/** One timeframe's read within the alignment ladder. */
export interface AlignmentTimeframeRead {
  timeframe: TimeframeKey;
  role: AlignmentRole;
  /** Directional bias of THIS timeframe on its own. */
  bias: 'bullish' | 'bearish' | 'neutral';
  /** 0–1 trend strength from the shared condition classifier. */
  strength: number;
  condition: string;
  detail: string;
  /** True when this timeframe agrees with the resolved directional bias. */
  agrees: boolean;
  /** True when this is a lower-timeframe pullback against the resolved bias. */
  pullback: boolean;
}

/** How the ladder distinguishes a pullback from a reversal. */
export type AlignmentCharacter =
  | 'ALIGNED_CONTINUATION'
  | 'PULLBACK_IN_TREND'
  | 'GENUINE_REVERSAL'
  | 'CONFLICTING'
  | 'NEUTRAL';

/** The learned strategy/timeframe the Timeframe Learner recommends for this index. */
export interface AlignmentLearnerHint {
  /** The analysis timeframe the learner proved best (null when unlearned). */
  analysisTimeframe: TimeframeKey | null;
  /** The confirmation timeframe the learner proved best (null when unlearned). */
  confirmationTimeframe: TimeframeKey | null;
  /** The preferred strategy label the learner proved strongest (null when unlearned). */
  preferredStrategy: string | null;
  /** True only when a validated, non-overfit plan exists. */
  reliable: boolean;
  note: string;
}

/**
 * The Timeframe Alignment AI's structured result for one index. Extends the shared
 * structured contract with the ladder reads, the strongest execution timeframe and the
 * pullback/reversal character.
 */
export interface TimeframeAlignmentRead extends StructuredMarketRead {
  /** Every timeframe read, top-down order. */
  ladder: AlignmentTimeframeRead[];
  /** The major-timeframe (M30/M15) resolved bias. */
  majorBias: 'RISE' | 'FALL' | null;
  /** The intermediate-timeframe (M10/M7/M5) resolved bias. */
  intermediateBias: 'RISE' | 'FALL' | null;
  /** The refinement-timeframe (M3/M1) resolved bias. */
  refinementBias: 'RISE' | 'FALL' | null;
  /** The timeframe that offers the strongest, most aligned execution. */
  strongestExecutionTimeframe: TimeframeKey | null;
  /** The precise confirmation the entry requires. */
  requiredEntryConfirmation: string;
  /** Pullback vs reversal vs continuation vs conflict. */
  character: AlignmentCharacter;
  /** Human contradictions between timeframes (empty when coherent). */
  contradictions: string[];
  /** True when too few timeframes could be read to be trustworthy. */
  insufficient: boolean;
  /** Timeframes the learner flagged as reliable false-signal sources for this index. */
  falseSignalTimeframes: TimeframeKey[];
  /** The learner's strategy/timeframe recommendation (advisory evidence). */
  learner: AlignmentLearnerHint;
  /** A structurally valid trade plan when the ladder authorises one. */
  trade: StructuredTradeLevels | null;
}
