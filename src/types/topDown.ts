import type { TimeframeKey } from './market';

/**
 * TOP-DOWN MULTI-TIMEFRAME ANALYSIS.
 *
 * Every AI analyses the SAME ten-timeframe ladder per index and derives a structured
 * top-down read: the higher timeframes establish the directional bias, the intermediate
 * timeframes develop the setup, M5 is the mandatory execution / confirmation timeframe and
 * the lower timeframes refine the entry. Timeframes are NOT required to agree — a
 * disagreement is surfaced as a contradiction, never forced into a false consensus.
 */

/** The role a timeframe plays in the top-down ladder. */
export type TopDownRole = 'MAJOR' | 'INTERMEDIATE' | 'EXECUTION' | 'REFINEMENT';

/** One timeframe's directional read. */
export interface TopDownRead {
  timeframe: TimeframeKey;
  role: TopDownRole;
  bias: 'bullish' | 'bearish' | 'neutral';
  /** 0–1 trend strength of this timeframe's read. */
  strength: number;
  condition: string;
  detail: string;
  /** Number of confirmed candles the read is based on (0 = not enough data). */
  confirmedBars: number;
}

/** The full top-down read for one index. */
export interface TopDownAnalysis {
  symbol: string;
  reads: TopDownRead[];
  /** Higher-timeframe directional bias (M30/M15). */
  majorBias: 'RISE' | 'FALL' | null;
  /** Intermediate structure bias (M10/M7/M6). */
  intermediateBias: 'RISE' | 'FALL' | null;
  /** M5 execution bias — the mandatory entry-confirmation timeframe. */
  executionBias: 'RISE' | 'FALL' | null;
  /** Lower-timeframe refinement bias (M4/M3/M2/M1). */
  refinementBias: 'RISE' | 'FALL' | null;
  /** 0–100 agreement score across the ladder (never a majority vote of raw signals). */
  alignmentScore: number;
  /** True when the major + intermediate bias agree with the execution bias. */
  aligned: boolean;
  /** True when M5 itself confirms a direction (mandatory for a final entry). */
  executionConfirmed: boolean;
  /** Human contradictions between timeframes (empty when the ladder is coherent). */
  contradictions: string[];
  /** True when there is not enough data to form a trustworthy read. */
  insufficient: boolean;
}

/** The strongest opportunity direction the top-down ladder supports (null when none). */
export function topDownDirection(analysis: TopDownAnalysis): 'RISE' | 'FALL' | null {
  if (!analysis.executionConfirmed || analysis.executionBias === null) return null;
  if (analysis.majorBias !== null && analysis.majorBias !== analysis.executionBias) return null;
  return analysis.executionBias;
}
