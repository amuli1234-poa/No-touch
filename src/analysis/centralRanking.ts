import type { EntryModelDecision, EntryModelKind } from '../types/entryModelAI';
import type { RankedSetup } from '../types/ranking';
import type {
  CentralCandidate,
  CentralRankingResult,
  CentralRankingWeights,
  CentralRankedOpportunity,
  CentralRejection,
  CentralRejectionReason,
  CentralScoreBreakdown,
  IndexValidatedPerformance,
} from '../types/centralRanking';
import { DEFAULT_CENTRAL_WEIGHTS } from '../types/centralRanking';
import type { IndexModelProfile } from '../types/entryModelProfiles';
import type { IndexLearningPlan } from '../types/learning';
import type { ConnectionStatus, TimeframeKey } from '../types/market';

/**
 * CENTRAL MULTI-MARKET INTELLIGENCE ENGINE.
 *
 * Collects and normalises every candidate submitted by every independent AI, then, in order:
 *   1. verifies live Deriv connectivity and data freshness,
 *   2. rejects invalid / expired / incomplete / low-quality setups,
 *   3. removes duplicates (same market opportunity),
 *   4. rejects unresolved direction conflicts (one market never occupies the ranking twice),
 *   5. applies the index-specific Entry Model AI validation (a candidate must be CONFIRMED
 *      with a selected model to qualify),
 *   6. ranks the remainder with configurable weights, using VALIDATED per-index historical
 *      performance where it exists rather than an uncalibrated confidence number.
 *
 * Pure and deterministic — no side effects, no invented data.
 */

/** Freshness window (ms) by timeframe — a candidate older than this is stale. */
export function freshnessWindowMs(timeframe: TimeframeKey): number {
  const seconds: Record<string, number> = {
    M1: 300,
    M3: 540,
    M5: 900,
    M7: 1260,
    M15: 2700,
    H1: 7200,
    H4: 14400,
  };
  return (seconds[timeframe] ?? 900) * 1000;
}

/** Minimum central score for a candidate to be published in the final ranking. */
export const CENTRAL_MIN_SCORE = 55;
/** Default number of final opportunities exposed to the floating scanner. */
export const CENTRAL_TOP_N = 3;

export interface RunCentralRankingParams {
  candidates: readonly CentralCandidate[];
  connectionStatus: ConnectionStatus;
  /** Per-symbol validated performance (from the Entry Model AI's per-index profiles). */
  performanceBySymbol?: ReadonlyMap<string, IndexValidatedPerformance>;
  weights?: CentralRankingWeights;
  /** Epoch ms "now" — used for freshness/expiry. Defaults to Date.now(). */
  now?: number;
  /** Minimum central score to publish (default CENTRAL_MIN_SCORE). */
  minScore?: number;
  /** How many final opportunities to keep (default CENTRAL_TOP_N). */
  topN?: number;
}

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Maps a validated expectancy (R) into a 0–100 performance component. */
function performanceComponent(perf: IndexValidatedPerformance | undefined): number {
  if (!perf || !perf.reliable || perf.expectancy === null) return 0;
  // expectancy 0R → 50, +1R → 100, −1R → 0.
  return clamp(50 + perf.expectancy * 50);
}

/** The Entry Model AI confirmation strength (0–100). */
function confirmationComponent(decision: EntryModelDecision | null): number {
  if (!decision) return 0;
  const base = decision.state === 'CONFIRMED' ? 70 : decision.state === 'WAITING' ? 40 : 15;
  const modelBonus = decision.model !== null ? 20 : 0;
  const combinedBonus = Math.min(10, decision.combinedWith.length * 5);
  return clamp(base + modelBonus + combinedBonus);
}

function rewardRiskComponent(rr: number | null): number {
  if (rr === null) return 0;
  // 1R → 50, 2R → 75, 3R → 100 (capped).
  return clamp((rr / 3) * 100);
}

function htfComponent(decision: EntryModelDecision | null): number {
  if (!decision || decision.htfDirection === null) return 50; // neutral when indeterminate
  return decision.htfDirection === decision.direction ? 100 : 25;
}

/**
 * The Learning AI's timeframe-plan suitability for this candidate's index (0–100). Neutral
 * (50) when no reliable plan exists, so an unlearned index is never penalised. A candidate on
 * a timeframe the Learning AI has proven weak for this index is docked; one on the learned
 * analysis / confirmation timeframe (or an aligned higher timeframe) is lifted. It never
 * overrides the mandatory M5 execution requirement — that is enforced separately.
 */
function learningComponent(
  plan: IndexLearningPlan | null | undefined,
  timeframe: TimeframeKey
): number {
  if (!plan) return 50;
  const combo = plan.bestCombination;
  if (!combo || !combo.reliable) return 50;
  if (plan.falseSignalTimeframes.includes(timeframe)) return 10;
  if (timeframe === plan.analysisTimeframe || timeframe === plan.confirmationTimeframe) return 100;
  if (plan.requiredAlignment.includes(timeframe)) return 80;
  if (timeframe === plan.executionTimeframe) return 85;
  return 50;
}

/** Verifies a candidate is complete enough to rank. Returns a rejection reason or null. */
function completenessProblem(c: CentralCandidate): string | null {
  if (c.entryPrice === null) return 'No entry price.';
  if (c.stopLoss === null) return 'No stop-loss level.';
  if (c.takeProfit1 === null) return 'No target level.';
  return null;
}

/**
 * Runs one central ranking pass. `candidates` may contain duplicates and conflicts from any
 * number of AIs — this function resolves them deterministically.
 */
export function runCentralRanking({
  candidates,
  connectionStatus,
  performanceBySymbol,
  weights = DEFAULT_CENTRAL_WEIGHTS,
  now = Date.now(),
  minScore = CENTRAL_MIN_SCORE,
  topN = CENTRAL_TOP_N,
}: RunCentralRankingParams): CentralRankingResult {
  const rejected: CentralRejection[] = [];
  const reject = (
    c: CentralCandidate,
    reason: CentralRejectionReason,
    detail: string
  ) => {
    rejected.push({
      key: c.key,
      symbol: c.symbol,
      displayName: c.displayName,
      sourceLabel: c.sourceLabel,
      direction: c.direction,
      reason,
      detail,
    });
  };

  // 1. Connectivity — never publish a live signal from a dead feed.
  if (connectionStatus !== 'connected') {
    for (const c of candidates) {
      reject(c, 'DISCONNECTED', `Deriv feed ${connectionStatus} — no live signals are published.`);
    }
    return { ranked: [], rejected, considered: candidates.length, rankedAt: now, connectionStatus, watchlist: [] };
  }

  const survivors: CentralCandidate[] = [];
  for (const c of candidates) {
    // 2a. Freshness — the newest confirmed candle must be within the timeframe window.
    const ageMs = now - c.dataTimestamp * 1000;
    if (c.dataTimestamp <= 0 || ageMs > freshnessWindowMs(c.timeframe)) {
      reject(c, 'STALE_DATA', `Latest candle is ${Math.round(ageMs / 1000)}s old — beyond the ${c.timeframe} freshness window.`);
      continue;
    }
    // 2b. Expiry — a setup past its actionable window is never ranked.
    if (c.expiresAt <= now) {
      reject(c, 'EXPIRED', 'The setup has aged past its actionable window.');
      continue;
    }
    // 2c. Completeness — entry, stop and at least one target are mandatory.
    const problem = completenessProblem(c);
    if (problem) {
      reject(c, 'INCOMPLETE', problem);
      continue;
    }
    survivors.push(c);
  }

  // 3. Duplicates — the same market opportunity from the same AI/direction/timeframe/model
  //    is one trade; keep the strongest.
  const byOpportunity = new Map<string, CentralCandidate>();
  for (const c of survivors) {
    const bucket = `${c.sourceLabel}:${c.symbol}:${c.timeframe}:${c.direction}:${c.setup.modelLabel}`;
    const existing = byOpportunity.get(bucket);
    if (!existing) {
      byOpportunity.set(bucket, c);
    } else {
      if (c.engineScore > existing.engineScore) byOpportunity.set(bucket, c);
      reject(c, 'DUPLICATE', `Duplicate of a stronger ${existing.sourceLabel} setup on ${existing.displayName}.`);
    }
  }

  // 4. Conflicts — one market never occupies the ranking twice. The strongest reading wins;
  //    unresolved conflicts (identical score, opposite direction) are both rejected.
  const bySymbol = new Map<string, CentralCandidate[]>();
  for (const c of byOpportunity.values()) {
    const list = bySymbol.get(c.symbol) ?? [];
    list.push(c);
    bySymbol.set(c.symbol, list);
  }
  const conflictSurvivors: CentralCandidate[] = [];
  for (const [, list] of bySymbol) {
    if (list.length === 1) {
      conflictSurvivors.push(list[0]);
      continue;
    }
    const directions = new Set(list.map((c) => c.direction));
    if (directions.size === 1) {
      // Same direction from multiple AIs — keep the strongest, reject the rest as duplicates.
      const sorted = [...list].sort((a, b) => b.engineScore - a.engineScore);
      conflictSurvivors.push(sorted[0]);
      for (const c of sorted.slice(1)) {
        reject(c, 'DUPLICATE', `Same-direction setup on ${c.displayName}; a stronger reading was kept.`);
      }
      continue;
    }
    // Conflicting directions — resolve by score, but an exact tie is an unresolved conflict.
    const sorted = [...list].sort((a, b) => b.engineScore - a.engineScore);
    const top = sorted[0];
    const runnerUp = sorted.find((c) => c.direction !== top.direction);
    if (runnerUp && runnerUp.engineScore === top.engineScore) {
      for (const c of list) {
        reject(c, 'CONFLICT', `Unresolved direction conflict on ${c.displayName} — both readings scored ${c.engineScore}.`);
      }
      continue;
    }
    conflictSurvivors.push(top);
    for (const c of sorted.slice(1)) {
      reject(c, 'CONFLICT', `Conflicts with the stronger ${top.direction} setup on ${top.displayName}.`);
    }
  }

  // 5. Entry Model AI validation — only CONFIRMED candidates with a selected model qualify.
  const validated: CentralCandidate[] = [];
  for (const c of conflictSurvivors) {
    const decision = c.entryDecision;
    if (!decision) {
      reject(c, 'ENTRY_NOT_CONFIRMED', 'No entry-model evaluation — awaiting validation.');
      continue;
    }
    if (decision.state === 'INVALIDATED' || decision.state === 'EXPIRED' || decision.state === 'MISSED') {
      reject(c, 'ENTRY_NOT_CONFIRMED', `Entry model state is ${decision.state}.`);
      continue;
    }
    if (decision.state !== 'CONFIRMED' || decision.model === null) {
      reject(c, 'ENTRY_NOT_CONFIRMED', 'The entry model is not confirmed — the setup is still developing.');
      continue;
    }
    validated.push(c);
  }

  // 6. Score + rank with configurable weights (validated performance where available).
  const scored: CentralRankedOpportunity[] = [];
  for (const c of validated) {
    const perf = performanceBySymbol?.get(c.symbol);
    const usedValidatedPerformance = Boolean(perf?.reliable && perf.expectancy !== null);
    const quality = clamp(c.engineScore);
    const performance = performanceComponent(perf);
    const rewardRisk = rewardRiskComponent(c.riskRewardRatio);
    const htfAlignment = htfComponent(c.entryDecision);
    const confirmation = confirmationComponent(c.entryDecision);
    const learning = learningComponent(c.learningPlan, c.timeframe);
    // The new AIs' reads are ADDITIONAL evidence: they only enter the weighted average for an
    // index that was actually read, and the average is renormalised so a candidate with no read
    // scores exactly as it did before these modules existed.
    const hasAlignment = c.alignmentScore != null;
    const hasMomentum = c.momentumStrength != null;
    const alignment = clamp(c.alignmentScore ?? 0);
    const momentum = clamp(c.momentumStrength ?? 0);

    let weighted =
      quality * weights.quality +
      performance * weights.performance +
      rewardRisk * weights.rewardRisk +
      htfAlignment * weights.htfAlignment +
      confirmation * weights.confirmation +
      learning * weights.learning;
    let weightSum =
      weights.quality +
      weights.performance +
      weights.rewardRisk +
      weights.htfAlignment +
      weights.confirmation +
      weights.learning;
    if (hasAlignment) {
      weighted += alignment * weights.alignment;
      weightSum += weights.alignment;
    }
    if (hasMomentum) {
      weighted += momentum * weights.momentum;
      weightSum += weights.momentum;
    }
    const total = clamp(weightSum > 0 ? weighted / weightSum : 0);
    const breakdown: CentralScoreBreakdown = {
      quality,
      performance,
      rewardRisk,
      htfAlignment,
      confirmation,
      learning,
      alignment: hasAlignment ? alignment : 0,
      momentum: hasMomentum ? momentum : 0,
      total: Math.round(total),
      usedValidatedPerformance,
    };

    if (breakdown.total < minScore) {
      reject(c, 'LOW_QUALITY', `Central score ${breakdown.total} is below the ${minScore} publication gate.`);
      continue;
    }

    const selectionReasons: string[] = [];
    selectionReasons.push(`${c.sourceLabel} setup quality ${Math.round(quality)}/100.`);
    if (usedValidatedPerformance && perf) {
      selectionReasons.push(
        `This index's validated ${perf.model ?? 'model'} expectancy is ${(perf.expectancy ?? 0).toFixed(2)}R over ${perf.sampleSize} outcomes.`
      );
    }
    if (c.riskRewardRatio !== null) selectionReasons.push(`Reward-to-risk ${c.riskRewardRatio.toFixed(1)}.`);
    if (c.entryDecision) selectionReasons.push(`Entry model: ${c.entryDecision.modelLabel}.`);
    if (c.alignmentScore != null) selectionReasons.push(`Timeframe Alignment ${c.alignmentScore}/100.`);
    if (c.momentumStrength != null) selectionReasons.push(`Momentum strength ${c.momentumStrength}/100.`);
    const plan = c.learningPlan;
    if (plan?.bestCombination?.reliable && plan.analysisTimeframe) {
      selectionReasons.push(
        `Learning AI: ${plan.analysisTimeframe} is this index's best analysis timeframe (M5 execution, ${plan.confirmationTimeframe ?? 'any'} confirmation).`
      );
    }

    scored.push({ rank: 0, candidate: c, score: breakdown, selectionReasons, state: 'REJECTED' });
  }

  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const rrA = a.candidate.riskRewardRatio ?? 0;
    const rrB = b.candidate.riskRewardRatio ?? 0;
    if (rrB !== rrA) return rrB - rrA;
    if (b.candidate.confirmedBarTime !== a.candidate.confirmedBarTime)
      return b.candidate.confirmedBarTime - a.candidate.confirmedBarTime;
    return a.candidate.key.localeCompare(b.candidate.key);
  });

  const limit = Math.max(0, topN);
  const ranked = scored.slice(0, limit).map((o, i) => ({ ...o, rank: i + 1, state: 'APPROVED' as const }));
  // Everything past the top-N is NOT rejected — it is tracked as a WATCH candidate that may
  // be promoted on a later pass. It never reaches the executable ranking.
  const watchlist = scored
    .slice(limit)
    .map((o, i) => ({ ...o, rank: limit + i + 1, state: 'WATCH' as const }));
  return { ranked, rejected, considered: candidates.length, rankedAt: now, connectionStatus, watchlist };
}

/**
 * The advisory intelligence enrichment attached to a central candidate — the Timeframe
 * Alignment AI's alignment score and the Consolidation & Momentum AI's momentum/consolidation
 * reads for the index. All fields are optional; absent reads contribute nothing to the score.
 */
export interface CentralCandidateIntelligence {
  alignmentScore?: number | null;
  momentumStrength?: number | null;
  consolidationScore?: number | null;
}

/**
 * Normalises a ranked setup from any independent AI into a central candidate. The setup's
 * own score, levels and reasons are preserved verbatim — nothing is re-derived. Freshness
 * and expiry are derived from the setup's own confirming bar and timeframe.
 */
export function toCentralCandidate(
  setup: RankedSetup,
  entryDecision: EntryModelDecision | null,
  now = Date.now(),
  learningPlan: IndexLearningPlan | null = null,
  intelligence: CentralCandidateIntelligence = {}
): CentralCandidate {
  const dataTimestamp = entryDecision?.dataTimestamp ?? setup.confirmedBarTime;
  const expiresAt = entryDecision?.expiresAt ?? (setup.confirmedBarTime + freshnessWindowMs(setup.timeframe) / 1000) * 1000;
  return {
    key: setup.key,
    sourceLabel: setup.sourceLabel,
    symbol: setup.symbol,
    displayName: setup.displayName,
    marketFamily: setup.marketFamily,
    timeframe: setup.timeframe,
    direction: setup.direction,
    engineScore: setup.score,
    entryPrice: setup.entryPrice,
    stopLoss: setup.stopLoss,
    takeProfit1: setup.takeProfit1,
    takeProfit2: setup.takeProfit2,
    riskRewardRatio: setup.riskRewardRatio,
    reasons: setup.reasons,
    confirmedBarTime: setup.confirmedBarTime,
    dataTimestamp,
    expiresAt,
    entryDecision,
    learningPlan,
    alignmentScore: intelligence.alignmentScore ?? null,
    momentumStrength: intelligence.momentumStrength ?? null,
    consolidationScore: intelligence.consolidationScore ?? null,
    setup,
  };
}

/**
 * Extracts the validated performance the central ranking reads for one index, from its
 * learned profile. Only a reliable, non-overfit model contributes — never a fabricated one.
 */
export function validatedPerformanceFromProfile(
  profile: IndexModelProfile | undefined
): IndexValidatedPerformance | undefined {
  if (!profile || profile.selected === null) return undefined;
  const stats = profile.models.find((m) => m.model === profile.selected);
  if (!stats) return undefined;
  return {
    model: stats.model === 'UNKNOWN' ? null : (stats.model as EntryModelKind),
    expectancy: stats.expectancy,
    winRatePercent: stats.winRatePercent,
    sampleSize: stats.sampleSize,
    reliable: stats.reliable && !stats.overfitRisk,
  };
}

