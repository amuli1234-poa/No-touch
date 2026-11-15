import type {
  EntryModelCandidate,
  QualityBreakdown,
  QualityTier,
} from '../types/engine';

/** Minimum total score required to publish a signal. */
export const PUBLICATION_MIN_SCORE = 85;

export function tierForScore(total: number): QualityTier {
  if (total >= 90) return 'EXCEPTIONAL';
  if (total >= 85) return 'HIGH_QUALITY';
  if (total >= 75) return 'DEVELOPING';
  return 'REJECTED';
}

/**
 * Aggregates a candidate's component scores into the 100-point technical quality
 * breakdown. The total is a technical-quality measure, NOT a win probability.
 *
 * Weights: structure 20, level/zone 20, entry confirmation 25, momentum 15,
 * multi-timeframe context 10, available movement space 10.
 */
export function scoreCandidate(candidate: EntryModelCandidate): QualityBreakdown {
  const structure = clamp(candidate.scores.structure, 0, 20);
  const levelZone = clamp(candidate.scores.levelZone, 0, 20);
  const entryConfirmation = clamp(candidate.scores.entryConfirmation, 0, 25);
  const momentum = clamp(candidate.scores.momentum, 0, 15);
  const multiTimeframe = clamp(candidate.scores.multiTimeframe, 0, 10);
  const availableSpace = clamp(candidate.scores.availableSpace, 0, 10);

  const total = structure + levelZone + entryConfirmation + momentum + multiTimeframe + availableSpace;
  const tier = tierForScore(total);

  // Mandatory confirmations: a candidate must carry structural evidence AND a real
  // confirmation explanation to be publishable, regardless of the numeric score.
  const hasStructuralEvidence = candidate.bosChochEvidence.length > 0;
  const hasConfirmation = candidate.confirmationExplanation.trim().length > 0;
  const hasInvalidation = Number.isFinite(candidate.invalidationPrice) && candidate.invalidationPrice > 0;
  const mandatorySatisfied = hasStructuralEvidence && hasConfirmation && hasInvalidation;

  return {
    structure,
    levelZone,
    entryConfirmation,
    momentum,
    multiTimeframe,
    availableSpace,
    total,
    tier,
    publishable: total >= PUBLICATION_MIN_SCORE && mandatorySatisfied,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}
