import { clamp } from './aiCommon';
import type { Fvg, OrderBlock, SweepEvent } from './smcTools';
import type { AiDirection, AiMarketCondition, AiSignal } from '../types/aiModule';
import type { Candle } from '../types/market';

/**
 * Shared, INDEPENDENT peer-signal validation used by the Confluence & Trade Validation AI
 * and the Live Market Scanner. It re-verifies each peer signal against the live candles —
 * structure agreement, target space, freshness, R:R — and de-duplicates correlated evidence
 * by entry model so two modules describing the same BOS never count twice.
 */

export type SetupGrade = 'A+' | 'A' | 'B' | 'C' | 'REJECTED';

export interface PeerEvidence {
  module: string;
  signal: AiSignal;
}

export interface VerifiedPeer {
  module: string;
  modelId: string;
  modelLabel: string;
  direction: AiDirection;
  score: number;
  note: string;
}

export interface PeerValidationInput {
  peers: readonly PeerEvidence[];
  price: number;
  atr: number;
  precision: number;
  condition: AiMarketCondition;
  bias: 'bullish' | 'bearish' | 'neutral';
  fvgs: readonly Fvg[];
  obs: readonly OrderBlock[];
  latestSweep: SweepEvent | null;
  latestBreak: { direction: 'bullish' | 'bearish'; kind: string } | null;
  opposingPools: readonly { side: 'BSL' | 'SSL'; price: number }[];
}

export interface PeerValidationResult {
  verified: VerifiedPeer[];
  conflicts: string[];
  chosen: AiDirection | null;
  confluenceScore: number;
  grade: SetupGrade;
  best: AiSignal | null;
}

export function gradeFor(score: number): SetupGrade {
  if (score >= 92) return 'A+';
  if (score >= 86) return 'A';
  if (score >= 78) return 'B';
  if (score >= 70) return 'C';
  return 'REJECTED';
}

/** True when the signal's direction still has an aligned FVG / live OB / matching sweep. */
function directPriceEvidence(input: PeerValidationInput, dir: AiDirection): boolean {
  return (
    input.fvgs.some((f) => (f.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir) ||
    input.obs.some((o) => (o.kind === 'BULLISH' ? 'RISE' : 'FALL') === dir && !o.invalidated) ||
    (input.latestSweep !== null && (input.latestSweep.side === 'SSL' ? 'RISE' : 'FALL') === dir)
  );
}

export function verifyPeerEvidence(input: PeerValidationInput): PeerValidationResult {
  const verified: VerifiedPeer[] = [];
  const conflicts: string[] = [];
  const seenModels = new Set<string>();
  const now = Date.now();

  for (const peer of input.peers) {
    const sig = peer.signal;
    const dir = sig.direction;

    const invalidated = dir === 'RISE' ? input.price < sig.stopLoss : input.price > sig.stopLoss;
    if (invalidated) {
      conflicts.push(`${peer.module}: ${sig.modelLabel} invalidated — price is beyond its stop.`);
      continue;
    }
    const reachedTp1 = dir === 'RISE' ? input.price >= sig.takeProfit1 : input.price <= sig.takeProfit1;
    if (reachedTp1) {
      conflicts.push(`${peer.module}: ${sig.modelLabel} already reached TP1 — entry is late.`);
      continue;
    }
    if (now - sig.createdAt > 1000 * 60 * 60 * 6) {
      conflicts.push(`${peer.module}: ${sig.modelLabel} is stale (>6h old).`);
      continue;
    }

    const structureAgrees = input.latestBreak
      ? (input.latestBreak.direction === 'bullish' ? 'RISE' : 'FALL') === dir
      : input.bias === (dir === 'RISE' ? 'bullish' : 'bearish');

    const forward = input.opposingPools.filter((p) =>
      dir === 'RISE' ? p.side === 'BSL' && p.price > input.price : p.side === 'SSL' && p.price < input.price
    );
    const space = forward.length
      ? dir === 'RISE'
        ? Math.min(...forward.map((p) => p.price)) - input.price
        : input.price - Math.max(...forward.map((p) => p.price))
      : input.atr * 3;
    const adequateSpace = space > input.atr * 1.2;

    // De-duplicate correlated evidence: same direction + same entry model counts once.
    const key = `${dir}:${sig.modelId}`;
    if (seenModels.has(key)) continue;
    seenModels.add(key);

    let score = 60;
    score += structureAgrees ? 12 : -10;
    score += adequateSpace ? 10 : -12;
    if (sig.riskRewardRatio >= 2) score += 10;
    else if (sig.riskRewardRatio < 1.2) score -= 12;
    if (sig.score >= 90) score += 8;
    else if (sig.score < 85) score -= 8;
    if (directPriceEvidence(input, dir)) score += 10;

    verified.push({
      module: peer.module,
      modelId: sig.modelId,
      modelLabel: sig.modelLabel,
      direction: dir,
      score: clamp(score, 0, 100),
      note: `${sig.modelLabel} (${peer.module}) — ${structureAgrees ? 'structure agrees' : 'structure disagrees'}, ${
        adequateSpace ? 'adequate target space' : 'insufficient target space'
      }, R:R ${sig.riskRewardRatio.toFixed(2)}.`,
    });
  }

  const rise = verified.filter((v) => v.direction === 'RISE');
  const fall = verified.filter((v) => v.direction === 'FALL');
  const avg = (arr: VerifiedPeer[]) => (arr.length ? arr.reduce((a, b) => a + b.score, 0) / arr.length : 0);

  let chosen: AiDirection | null = null;
  if (rise.length && fall.length) {
    if (Math.abs(avg(rise) - avg(fall)) >= 12) chosen = avg(rise) > avg(fall) ? 'RISE' : 'FALL';
  } else if (rise.length) chosen = 'RISE';
  else if (fall.length) chosen = 'FALL';

  const chosenEvidence = chosen ? verified.filter((v) => v.direction === chosen) : [];
  const confluenceScore = chosenEvidence.length
    ? clamp(
        chosenEvidence.reduce((a, b) => a + b.score, 0) / chosenEvidence.length +
          Math.min(8, chosenEvidence.length * 2),
        0,
        100
      )
    : 0;

  const bestPeer = chosen
    ? input.peers
        .map((p) => p.signal)
        .filter((s) => s.direction === chosen)
        .sort((a, b) => b.score - a.score)[0] ?? null
    : null;

  return {
    verified,
    conflicts,
    chosen,
    confluenceScore,
    grade: gradeFor(confluenceScore),
    best: bestPeer,
  };
}
