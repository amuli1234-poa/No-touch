import {
  aiAtr,
  buildAiSignal,
  buildTimeframeReads,
  clamp,
  lastConfirmed,
  readAiCondition,
  resolveTargets,
  statusForScore,
} from './aiCommon';
import { buildStructuredTrade } from './structuredReads';

import { detectLiquidityPools } from './smcTools';
import { detectSwings } from './swings';
import { confirmedCandles } from './structureEngine';
import type { AiEngineParams } from '../hooks/useAiScanner';
import type { AiInstrumentAnalysis, AiSignal, AiTimeframeRead, AiZone } from '../types/aiModule';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type { IndexLearningPlan } from '../types/learning';
import type {
  AlignmentCharacter,
  AlignmentLearnerHint,
  AlignmentRole,
  AlignmentTimeframeRead,
  TimeframeAlignmentRead,
} from '../types/timeframeAlignment';

/** Clamp a 0–100 score. */
const clampPct = (v: number) => clamp(v, 0, 100);

/**
 * TIMEFRAME ALIGNMENT AI — the multi-timeframe direction & structure intelligence.
 *
 * It continuously reads the requested ladder for one index:
 *   - M30            → directional bias (MAJOR)
 *   - M15 / M10      → structure confirmation (MAJOR / INTERMEDIATE)
 *   - M7 / M5        → setup identification (INTERMEDIATE / SETUP)
 *   - M3 / M1        → precise entry confirmation (REFINEMENT)
 * Every timeframe is classified with the SAME shared market-condition classifier every AI
 * uses (never a duplicated indicator stack). Timeframes are NOT required to agree: a
 * disagreement lowers the alignment score and is reported as a contradiction, and the
 * engine distinguishes a temporary pullback from a genuine reversal.
 *
 * It reuses the ten-timeframe `topDown` ladder the shared scanner already attaches — it does
 * NOT re-derive a competing ladder, and it never fabricates a timeframe that has no data.
 */

/** Minimum confirmed bars for a timeframe read to be trustworthy. */
const MIN_READ_BARS = 30;

/** The alignment ladder in top-down order (the seven requested timeframes). */
const ALIGNMENT_LADDER: readonly TimeframeKey[] = ['M30', 'M15', 'M10', 'M7', 'M5', 'M3', 'M1'];

/** The publication gate for a fully aligned, executable ladder. */
export const TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE = 72;

const ROLE_WEIGHTS: Record<AlignmentRole, number> = {
  MAJOR: 0.35,
  INTERMEDIATE: 0.25,
  SETUP: 0.25,
  REFINEMENT: 0.15,
};

function roleOf(timeframe: TimeframeKey): AlignmentRole {
  switch (timeframe) {
    case 'M30':
    case 'M15':
      return 'MAJOR';
    case 'M10':
    case 'M7':
      return 'INTERMEDIATE';
    case 'M5':
      return 'SETUP';
    default:
      return 'REFINEMENT';
  }
}

function readTimeframe(timeframe: TimeframeKey, candles: readonly Candle[]): AlignmentTimeframeRead | null {
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
    agrees: false,
    pullback: false,
  };
}

/** Collapses a role's reads into one directional bias (strength-weighted vote). */
function biasForRole(
  reads: readonly AlignmentTimeframeRead[],
  role: AlignmentRole
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
  return { bias, score: Math.round((Math.abs(bull - bear) / total) * 100) };
}

function classifyCharacter(params: {
  direction: 'RISE' | 'FALL' | null;
  majorBias: 'RISE' | 'FALL' | null;
  intermediateBias: 'RISE' | 'FALL' | null;
  refinementBias: 'RISE' | 'FALL' | null;
}): AlignmentCharacter {
  const { direction, majorBias, intermediateBias, refinementBias } = params;
  if (direction === null) return 'NEUTRAL';
  const majorOpposes = majorBias !== null && majorBias !== direction;
  const interOpposes = intermediateBias !== null && intermediateBias !== direction;
  if (majorOpposes && interOpposes) return 'CONFLICTING';
  if (majorOpposes && !interOpposes) return 'GENUINE_REVERSAL';
  // Major + intermediate agree with the setup direction.
  if (refinementBias !== null && refinementBias !== direction) return 'PULLBACK_IN_TREND';
  return 'ALIGNED_CONTINUATION';
}

/** The learned strategy/timeframe the Timeframe Learner recommends (advisory evidence). */
function learnerHint(plan: IndexLearningPlan | null | undefined): AlignmentLearnerHint {
  if (!plan) {
    return {
      analysisTimeframe: null,
      confirmationTimeframe: null,
      preferredStrategy: null,
      reliable: false,
      note: 'No learning plan for this index yet — the ladder stands on its own.',
    };
  }
  const combo = plan.bestCombination;
  const reliable = Boolean(combo?.reliable);
  return {
    analysisTimeframe: plan.analysisTimeframe,
    confirmationTimeframe: plan.confirmationTimeframe,
    preferredStrategy: combo?.reliable ? `${plan.analysisTimeframe ?? 'M15'} analysis · ${plan.confirmationTimeframe ?? 'M3'} confirmation` : null,
    reliable,
    note: reliable
      ? `Learner: analyse on ${plan.analysisTimeframe ?? '—'}, confirm on ${plan.confirmationTimeframe ?? '—'}, execute on ${plan.executionTimeframe}.`
      : 'Learner has no reliable plan for this index yet.',
  };
}

export interface BuildAlignmentInput {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  candlesByTimeframe: Partial<Record<TimeframeKey, readonly Candle[]>>;
  learnerPlan?: IndexLearningPlan | null;
}

/**
 * Resolves the alignment ladder from an engine's params. Production always supplies the full
 * `candlesByTimeframe` ladder; when it is absent (a caller that only supplies the shared role
 * series) the ladder is composed from the role timeframes so the engine degrades gracefully
 * instead of reporting an empty ladder.
 */
function resolveLadder(params: AiEngineParams): Partial<Record<TimeframeKey, readonly Candle[]>> {
  const provided = params.candlesByTimeframe;
  const role: Partial<Record<TimeframeKey, readonly Candle[]>> = {
    M30: params.structureCandles,
    M15: params.structureCandles,
    M10: params.trendCandles,
    M7: params.trendCandles,
    M5: params.setupCandles,
    M3: params.confirmCandles,
    M1: params.entryCandles,
  };
  const out: Partial<Record<TimeframeKey, readonly Candle[]>> = {};
  for (const tf of ALIGNMENT_LADDER) {
    const series = provided?.[tf] ?? role[tf];
    if (series && series.length > 0) out[tf] = series;
  }
  return out;
}

/**
 * Pure structured alignment read for one index (no chart plumbing). This is what the unit
 * tests drive directly and what the central scanner consumes as advisory evidence.
 */
export function buildTimeframeAlignment(input: BuildAlignmentInput): TimeframeAlignmentRead {
  const { symbol, displayName, marketFamily, candlesByTimeframe } = input;

  const ladder: AlignmentTimeframeRead[] = [];
  for (const tf of ALIGNMENT_LADDER) {
    const candles = candlesByTimeframe[tf];
    if (!candles || candles.length === 0) continue;
    const read = readTimeframe(tf, candles);
    if (read) ladder.push(read);
  }

  const major = biasForRole(ladder, 'MAJOR');
  const intermediate = biasForRole(ladder, 'INTERMEDIATE');
  const setup = biasForRole(ladder, 'SETUP');
  const refinement = biasForRole(ladder, 'REFINEMENT');

  const majorBias = major.bias;
  const intermediateBias = intermediate.bias;
  const refinementBias = refinement.bias;
  // The setup timeframe (M5) is the mandatory execution direction.
  const direction = setup.bias;

  for (const r of ladder) {
    r.agrees = direction !== null && (r.bias === (direction === 'RISE' ? 'bullish' : 'bearish'));
    r.pullback = direction !== null && r.role === 'REFINEMENT' && r.bias !== 'neutral' && !r.agrees;
  }

  const character = classifyCharacter({ direction, majorBias, intermediateBias, refinementBias });

  // Alignment score: weight each role's agreement with the resolved direction.
  let alignmentScore = 0;
  let weightSum = 0;
  const roleBias: Record<AlignmentRole, 'RISE' | 'FALL' | null> = {
    MAJOR: majorBias,
    INTERMEDIATE: intermediateBias,
    SETUP: direction,
    REFINEMENT: refinementBias,
  };
  const roleScore: Record<AlignmentRole, number> = {
    MAJOR: major.score,
    INTERMEDIATE: intermediate.score,
    SETUP: setup.score,
    REFINEMENT: refinement.score,
  };
  for (const role of ['MAJOR', 'INTERMEDIATE', 'SETUP', 'REFINEMENT'] as const) {
    const bias = roleBias[role];
    if (bias === null) continue;
    const agrees = direction !== null && bias === direction;
    const raw = roleScore[role];
    alignmentScore += (agrees ? Math.max(raw, 50) : Math.min(raw, 50)) * ROLE_WEIGHTS[role];
    weightSum += ROLE_WEIGHTS[role];
  }
  alignmentScore = weightSum > 0 ? Math.round(alignmentScore / weightSum) : 0;

  const contradictions: string[] = [];
  if (direction !== null && majorBias !== null && majorBias !== direction) {
    contradictions.push(`M30/M15 bias ${majorBias} opposes the M5 setup ${direction}.`);
  }
  if (direction !== null && intermediateBias !== null && intermediateBias !== direction) {
    contradictions.push(`Intermediate structure ${intermediateBias} opposes the M5 setup ${direction}.`);
  }
  if (direction !== null && refinementBias !== null && refinementBias !== direction) {
    contradictions.push(`M3/M1 refinement ${refinementBias} has not turned ${direction} yet.`);
  }

  const insufficient = ladder.length < 4 || direction === null;

  // The strongest execution timeframe: the most aligned, highest-strength setup timeframe.
  let strongestExecutionTimeframe: TimeframeKey | null = direction !== null ? 'M5' : null;
  let bestStrength = -1;
  for (const r of ladder) {
    if (r.role !== 'SETUP' && r.role !== 'INTERMEDIATE') continue;
    if (!r.agrees) continue;
    if (r.strength > bestStrength) {
      bestStrength = r.strength;
      strongestExecutionTimeframe = r.timeframe;
    }
  }

  const learner = learnerHint(input.learnerPlan);

  const executionTimeframe = strongestExecutionTimeframe ?? 'M5';
  const requiredEntryConfirmation =
    direction === null
      ? 'Wait for the M5 setup timeframe to resolve a direction.'
      : refinementBias === direction
        ? `M5 setup is aligned; enter on an M1 close in the ${direction} direction off the setup level.`
        : `Wait for M3/M1 to turn ${direction} before entering — the ladder is not yet confirmed.`;

  const confirmationCondition =
    direction === null
      ? 'A confirmed M5 close with a clear directional bias.'
      : `A ${executionTimeframe} close beyond the setup level in the ${direction} direction with M3/M1 agreement.`;
  const invalidationCondition =
    direction === null
      ? 'Not applicable — no directional read yet.'
      : direction === 'RISE'
        ? 'A close back below the setup level / lower-timeframe higher-low.'
        : 'A close back above the setup level / lower-timeframe lower-high.';

  const directionalBias: TimeframeAlignmentRead['directionalBias'] =
    direction === null
      ? 'neutral'
      : character === 'CONFLICTING'
        ? 'conflicting'
        : direction === 'RISE'
          ? 'bullish'
          : 'bearish';

  // A structurally valid trade plan only when the ladder authorises continuation or a pullback.
  const setupCandles = candlesByTimeframe['M5'] ?? candlesByTimeframe['M15'] ?? [];
  const atr = aiAtr(setupCandles);
  const price = lastConfirmed(setupCandles)?.close ?? lastConfirmed(candlesByTimeframe['M15'] ?? [])?.close ?? 0;
  let trade = null as TimeframeAlignmentRead['trade'];
  if (direction !== null && character !== 'CONFLICTING' && atr > 0) {
    const swings = detectSwings(confirmedCandles(setupCandles), 3, 3);
    const lows = swings.filter((s) => s.type === 'low').map((s) => s.price);
    const highs = swings.filter((s) => s.type === 'high').map((s) => s.price);
    const pools = detectLiquidityPools(confirmedCandles(setupCandles), atr, 2, price);
    const stop =
      direction === 'RISE'
        ? Math.min(...(lows.length ? lows.slice(-3) : [price - atr * 1.5])) - atr * 0.4
        : Math.max(...(highs.length ? highs.slice(-3) : [price + atr * 1.5])) + atr * 0.4;
    const candidates =
      direction === 'RISE'
        ? [...pools.filter((p) => p.side === 'BSL').map((p) => p.price), ...highs]
        : [...pools.filter((p) => p.side === 'SSL').map((p) => p.price), ...lows];
    trade = buildStructuredTrade({ direction, entry: price, stop, candidates, unit: atr });
  }

  const confidence = clampPct(
    alignmentScore * 0.7 +
      (direction !== null ? 15 : 0) +
      (refinementBias === direction ? 15 : 0) +
      (character === 'ALIGNED_CONTINUATION' ? 10 : character === 'PULLBACK_IN_TREND' ? 5 : 0)
  );

  return {
    symbol,
    displayName,
    marketFamily,
    timeframe: executionTimeframe,
    direction,
    directionalBias,
    alignmentScore,
    momentumStrength: null,
    consolidationProbability: null,
    preferredStrategy:
      character === 'PULLBACK_IN_TREND'
        ? 'Trend continuation on the pullback'
        : character === 'GENUINE_REVERSAL'
          ? 'Counter-trend reversal after confirmation'
          : character === 'ALIGNED_CONTINUATION'
            ? 'Trend continuation'
            : 'Stand aside — wait for alignment',
    confidence,
    confirmationCondition,
    invalidationCondition,
    ladder,
    majorBias,
    intermediateBias,
    refinementBias,
    strongestExecutionTimeframe,
    requiredEntryConfirmation,
    character,
    contradictions,
    insufficient,
    falseSignalTimeframes: input.learnerPlan?.falseSignalTimeframes ?? [],
    learner,
    trade,
  };
}

/** Maps the alignment read's timeframe detail into the shared timeframe-read shape. */
function toTimeframeReads(read: TimeframeAlignmentRead): AiTimeframeRead[] {
  const ladder = read.ladder.map((r) => ({
    timeframe: r.timeframe,
    label: `${r.timeframe} ${r.role.toLowerCase()}`,
    detail: `${r.detail}${r.agrees ? ' · aligned' : r.pullback ? ' · pullback' : ''}`,
    tone: (r.bias === 'bullish' ? 'bull' : r.bias === 'bearish' ? 'bear' : 'neutral') as AiTimeframeRead['tone'],
  }));
  const m15 = read.ladder.find((r) => r.timeframe === 'M15');
  const m5 = read.ladder.find((r) => r.timeframe === 'M5');
  const m1 = read.ladder.find((r) => r.timeframe === 'M1');
  return buildTimeframeReads({
    m15: m15?.detail ?? 'M15 not read.',
    m5: m5?.detail ?? 'M5 not read.',
    m1: m1?.detail ?? 'M1 not read.',
    m15Tone: m15?.bias === 'bullish' ? 'bull' : m15?.bias === 'bearish' ? 'bear' : 'neutral',
    m5Tone: m5?.bias === 'bullish' ? 'bull' : m5?.bias === 'bearish' ? 'bear' : 'neutral',
    m1Tone: m1?.bias === 'bullish' ? 'bull' : m1?.bias === 'bearish' ? 'bear' : 'neutral',
    ladder: ladder.filter((r) => !['M15', 'M5', 'M1'].includes(r.timeframe)),
  });
}

/**
 * The Timeframe Alignment AI engine — adapts the structured alignment read to the shared
 * `AiInstrumentAnalysis` contract so it is driven by the SAME scanner orchestrator as every
 * other module.
 */
export function analyzeTimeframeAlignmentInstrument(params: AiEngineParams): AiInstrumentAnalysis {
  const ladder = resolveLadder(params);
  const read = buildTimeframeAlignment({
    symbol: params.symbol,
    displayName: params.displayName,
    marketFamily: params.marketFamily,
    precision: params.precision,
    candlesByTimeframe: ladder,
    learnerPlan: params.learnerPlan ?? null,
  });

  const setupCandles = ladder['M5'] ?? params.setupCandles ?? params.structureCandles;
  const atr = aiAtr(setupCandles);
  const price =
    lastConfirmed(setupCandles)?.close ??
    lastConfirmed(params.structureCandles)?.close ??
    0;
  const condition = readAiCondition(confirmedCandles(setupCandles), atr).condition;

  const alignmentScore = read.alignmentScore ?? 0;
  const publishable =
    read.direction !== null &&
    !read.insufficient &&
    read.character !== 'CONFLICTING' &&
    alignmentScore >= TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE &&
    read.trade !== null;

  let signal: AiSignal | null = null;
  if (publishable && read.direction !== null && read.trade !== null) {
    const direction = read.direction;
    const t = read.trade;
    const confirmed = read.refinementBias === direction;
    signal = buildAiSignal({
      id: `${params.symbol}-align-${direction}-${Date.now()}`,
      symbol: params.symbol,
      displayName: params.displayName,
      marketFamily: params.marketFamily,
      precision: params.precision,
      direction,
      modelId: `TF_ALIGN_${read.character}`,
      modelLabel: `Timeframe Alignment · ${read.character.replace(/_/g, ' ').toLowerCase()}`,
      strategyLabel: read.preferredStrategy,
      status: statusForScore(alignmentScore, TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE, confirmed),
      score: Math.round(alignmentScore),
      condition,
      entryPrice: t.entry,
      entryZoneLow: t.entry - atr * 0.2,
      entryZoneHigh: t.entry + atr * 0.2,
      stopLoss: t.stop,
      takeProfit1: t.tp1,
      takeProfit2: t.tp2,
      takeProfit3: t.tp3,
      invalidationCondition: read.invalidationCondition,
      reasons: [
        `Ladder ${alignmentScore}/100 across ${read.ladder.length} timeframes — ${read.character.replace(/_/g, ' ').toLowerCase()}.`,
        `Execution timeframe: ${read.strongestExecutionTimeframe ?? 'M5'}.`,
        read.requiredEntryConfirmation,
        ...read.contradictions.slice(0, 2),
      ],
      confirmations: [read.confirmationCondition, read.learner.note],
      timeframes: toTimeframeReads(read),
      confirmedBarTime: lastConfirmed(setupCandles)?.time ?? 0,
    });
  }

  const zones: AiZone[] = [];
  if (read.trade && read.direction) {
    zones.push({
      id: `${params.symbol}-align-zone`,
      direction: read.direction,
      label: read.direction === 'RISE' ? 'ALIGNED LONG' : 'ALIGNED SHORT',
      upperPrice: read.trade.entry + atr * 0.3,
      lowerPrice: read.trade.entry - atr * 0.3,
      quality: Math.round(alignmentScore),
      fresh: true,
      watch: read.character === 'PULLBACK_IN_TREND',
      reason: read.confirmationCondition,
    });
  }

  const status = signal
    ? signal.status
    : read.insufficient
      ? 'WAITING_FOR_SETUP'
      : read.character === 'CONFLICTING'
        ? 'UNCLEAR'
        : read.character === 'PULLBACK_IN_TREND'
          ? 'WAITING_FOR_CONFIRMATION'
          : 'WATCHING';

  return {
    symbol: params.symbol,
    displayName: params.displayName,
    marketFamily: params.marketFamily,
    precision: params.precision,
    price,
    status,
    statusExplanation:
      read.direction === null
        ? 'No M5 directional bias yet — the ladder has no execution direction.'
        : read.insufficient
          ? 'Not enough timeframes read to trust an alignment.'
          : `${read.character.replace(/_/g, ' ').toLowerCase()} · alignment ${alignmentScore}/100 · execution ${read.strongestExecutionTimeframe ?? 'M5'}.`,
    condition,
    timeframes: toTimeframeReads(read),
    signal,
    activeZones: read.character === 'PULLBACK_IN_TREND' ? [] : zones,
    watchZones: read.character === 'PULLBACK_IN_TREND' ? zones : [],
    bestScore: Math.round(alignmentScore),
    atr,
    dataHealth: params.dataHealth,
    lastUpdated: Date.now(),
    rejectionReason: signal
      ? undefined
      : read.insufficient
        ? 'Insufficient timeframe coverage.'
        : read.character === 'CONFLICTING'
          ? 'Timeframes conflict — no clean alignment.'
          : `Alignment ${read.alignmentScore} is below the ${TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE} gate.`,
    intelligence: read,
  };
}

/** Re-export the ladder timeframe list for the UI/legend. */
export const ALIGNMENT_TIMEFRAMES = ALIGNMENT_LADDER;
