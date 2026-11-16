import { TIMEFRAME_ROLE_BY_KEY } from '../config/deriv';
import type { Candle, TimeframeKey } from '../types/market';
import type { TopDownAnalysis, TopDownRead, TopDownRole } from '../types/topDown';
import { aiAtr, readAiCondition } from './aiCommon';
import { confirmedCandles } from './structureEngine';

/**
 * TOP-DOWN MULTI-TIMEFRAME ANALYSIS ENGINE.
 *
 * Reads every timeframe of the ladder with the SAME market-condition classifier every AI
 * module already uses (never a duplicate indicator stack), groups the reads by their role
 * (major / intermediate / execution / refinement) and derives a directional bias per role.
 *
 * It deliberately does NOT require every timeframe to agree: a disagreement lowers the
 * alignment score and is reported as a contradiction. A final entry always requires M5
 * (the execution timeframe) itself to confirm — the lower timeframes only refine it.
 */

/** Minimum confirmed bars for a timeframe read to be trustworthy. */
const MIN_READ_BARS = 30;

/** The ten-timeframe ladder in top-down order. */
const LADDER: readonly TimeframeKey[] = [
  'M30',
  'M15',
  'M10',
  'M7',
  'M6',
  'M5',
  'M4',
  'M3',
  'M2',
  'M1',
];

function roleOf(timeframe: TimeframeKey): TopDownRole {
  return TIMEFRAME_ROLE_BY_KEY[timeframe] ?? 'REFINEMENT';
}

function readTimeframe(
  timeframe: TimeframeKey,
  candles: readonly Candle[]
): TopDownRead | null {
  const confirmed = confirmedCandles(candles);
  if (confirmed.length < MIN_READ_BARS) return null;
  const read = readAiCondition(confirmed, aiAtr(confirmed));
  return {
    timeframe,
    role: roleOf(timeframe),
    bias: read.bias,
    strength: read.strength,
    condition: read.condition,
    detail: read.detail,
    confirmedBars: confirmed.length,
  };
}

/** Collapses a role's reads into one directional bias (strongest agreed lean). */
function biasForRole(
  reads: readonly TopDownRead[],
  role: TopDownRole
): { bias: 'RISE' | 'FALL' | null; score: number } {
  const roleReads = reads.filter((r) => r.role === role && r.bias !== 'neutral');
  if (roleReads.length === 0) return { bias: null, score: 0 };
  let bull = 0;
  let bear = 0;
  for (const r of roleReads) {
    const weight = 0.5 + r.strength;
    if (r.bias === 'bullish') bull += weight;
    else bear += weight;
  }
  const total = bull + bear;
  if (total === 0) return { bias: null, score: 0 };
  const bias = bull > bear ? 'RISE' : bear > bull ? 'FALL' : null;
  const agreement = Math.abs(bull - bear) / total;
  return { bias, score: Math.round(agreement * 100) };
}

/**
 * Builds the top-down analysis for one index from its per-timeframe candles. Timeframes with
 * insufficient data are simply omitted (never faked); the analysis reports `insufficient`
 * when too few timeframes could be read to be trustworthy.
 */
export function buildTopDownAnalysis(
  symbol: string,
  candlesByTimeframe: Partial<Record<TimeframeKey, readonly Candle[]>>
): TopDownAnalysis {
  const reads: TopDownRead[] = [];
  for (const tf of LADDER) {
    const candles = candlesByTimeframe[tf];
    if (!candles || candles.length === 0) continue;
    const read = readTimeframe(tf, candles);
    if (read) reads.push(read);
  }

  const major = biasForRole(reads, 'MAJOR');
  const intermediate = biasForRole(reads, 'INTERMEDIATE');
  const execution = biasForRole(reads, 'EXECUTION');
  const refinement = biasForRole(reads, 'REFINEMENT');

  const majorBias = major.bias;
  const intermediateBias = intermediate.bias;
  const executionBias = execution.bias;
  const refinementBias = refinement.bias;

  const executionRead = reads.find((r) => r.role === 'EXECUTION');
  const executionConfirmed = executionRead !== undefined && executionBias !== null;

  const aligned =
    executionConfirmed &&
    (majorBias === null || majorBias === executionBias) &&
    (intermediateBias === null || intermediateBias === executionBias);

  // Alignment score weights the major (bias) and execution (mandatory) timeframes highest.
  const weights: Record<TopDownRole, number> = {
    MAJOR: 0.35,
    INTERMEDIATE: 0.2,
    EXECUTION: 0.3,
    REFINEMENT: 0.15,
  };
  let alignmentScore = 0;
  let weightSum = 0;
  for (const role of ['MAJOR', 'INTERMEDIATE', 'EXECUTION', 'REFINEMENT'] as const) {
    const bias =
      role === 'MAJOR'
        ? majorBias
        : role === 'INTERMEDIATE'
          ? intermediateBias
          : role === 'EXECUTION'
            ? executionBias
            : refinementBias;
    if (bias === null) continue;
    const score = role === 'MAJOR' ? major.score : role === 'INTERMEDIATE' ? intermediate.score : role === 'EXECUTION' ? execution.score : refinement.score;
    const agreesWithExecution = executionBias === null || bias === executionBias;
    const roleScore = agreesWithExecution ? Math.max(score, 50) : Math.min(score, 50);
    alignmentScore += roleScore * weights[role];
    weightSum += weights[role];
  }
  alignmentScore = weightSum > 0 ? Math.round(alignmentScore / weightSum) : 0;

  const contradictions: string[] = [];
  if (executionBias !== null && majorBias !== null && majorBias !== executionBias) {
    contradictions.push(
      `Major bias ${majorBias} conflicts with the M5 execution bias ${executionBias}.`
    );
  }
  if (executionBias !== null && intermediateBias !== null && intermediateBias !== executionBias) {
    contradictions.push(
      `Intermediate bias ${intermediateBias} conflicts with the M5 execution bias ${executionBias}.`
    );
  }
  if (refinementBias !== null && executionBias !== null && refinementBias !== executionBias) {
    contradictions.push(
      `Lower-timeframe refinement ${refinementBias} conflicts with M5 ${executionBias}.`
    );
  }

  const insufficient = reads.length < 5 || !executionConfirmed;

  return {
    symbol,
    reads,
    majorBias,
    intermediateBias,
    executionBias,
    refinementBias,
    alignmentScore,
    aligned,
    executionConfirmed,
    contradictions,
    insufficient,
  };
}

/** True when the top-down ladder authorises the given direction for a final entry. */
export function topDownAuthorises(
  analysis: TopDownAnalysis,
  direction: 'RISE' | 'FALL'
): boolean {
  if (!analysis.executionConfirmed || analysis.executionBias !== direction) return false;
  // A major-timeframe contradiction blocks a final entry — the AI must not fight the
  // higher-timeframe bias.
  if (analysis.majorBias !== null && analysis.majorBias !== direction) return false;
  return true;
}
