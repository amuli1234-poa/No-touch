import type { AiSignal } from '../types/aiModule';
import type { DsSignal } from '../types/demandSupply';
import type { EngineSignal } from '../types/engine';
import type { TrendlineSignal } from '../types/trendline';
import type {
  RankedSetup,
  RankedSignalSource,
  RankedSignalsInput,
} from '../types/ranking';

const SOURCE_LABELS: Record<RankedSignalSource, string> = {
  PRICE_ACTION: 'Market Scanner',
  TRENDLINE: 'Trendline AI',
  DEMAND_SUPPLY: 'Demand & Supply AI',
  AI_MODULE: 'AI Module',
};

function keyFor(
  source: RankedSignalSource,
  symbol: string,
  timeframe: string,
  direction: string,
  model: string
): string {
  return `${source}:${symbol}:${timeframe}:${direction}:${model}`;
}

/** Trims an engine's reason list to the strongest few, dropping blanks. */
function topReasons(reasons: readonly string[], max = 3): string[] {
  return reasons.filter((r) => r && r.trim().length > 0).slice(0, max);
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** A price-action signal (Market Scanner / Chart Analyser signal engine). */
function fromEngineSignal(signal: EngineSignal): RankedSetup {
  return {
    key: keyFor('PRICE_ACTION', signal.symbol, signal.analysisTimeframe, signal.direction, signal.model),
    source: 'PRICE_ACTION',
    sourceLabel: SOURCE_LABELS.PRICE_ACTION,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.analysisTimeframe,
    precision: signal.precision,
    direction: signal.direction,
    modelLabel: signal.modelLabel,
    score: clampScore(signal.quality.total),
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.target1,
    takeProfit2: signal.target2,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: topReasons(signal.reasons),
    confirmedBarTime: signal.confirmedBarTime,
    createdAt: signal.createdAt,
    sequence: 0,
  };
}

function fromTrendlineSignal(signal: TrendlineSignal): RankedSetup {
  return {
    key: keyFor('TRENDLINE', signal.symbol, signal.structureTimeframe, signal.direction, signal.model),
    source: 'TRENDLINE',
    sourceLabel: SOURCE_LABELS.TRENDLINE,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.structureTimeframe,
    precision: signal.precision,
    direction: signal.direction,
    modelLabel: signal.modelLabel,
    score: clampScore(signal.score),
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit,
    takeProfit2: null,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: topReasons(signal.reasons),
    confirmedBarTime: signal.confirmedBarTime,
    createdAt: signal.createdAt,
    sequence: 0,
  };
}

function fromDsSignal(signal: DsSignal): RankedSetup {
  return {
    key: keyFor('DEMAND_SUPPLY', signal.symbol, signal.setupTimeframe, signal.direction, signal.model),
    source: 'DEMAND_SUPPLY',
    sourceLabel: SOURCE_LABELS.DEMAND_SUPPLY,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.setupTimeframe,
    precision: signal.precision,
    direction: signal.direction,
    modelLabel: signal.modelLabel,
    score: clampScore(signal.score),
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: topReasons(signal.reasons),
    confirmedBarTime: signal.confirmedBarTime,
    createdAt: signal.createdAt,
    sequence: 0,
  };
}

function fromAiSignal(moduleLabel: string, signal: AiSignal): RankedSetup {
  return {
    key: keyFor('AI_MODULE', signal.symbol, signal.timeframes[0]?.timeframe ?? 'M5', signal.direction, signal.modelId),
    source: 'AI_MODULE',
    sourceLabel: moduleLabel || SOURCE_LABELS.AI_MODULE,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.timeframes[0]?.timeframe ?? 'M5',
    precision: signal.precision,
    direction: signal.direction,
    modelLabel: signal.modelLabel,
    score: clampScore(signal.score),
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: topReasons(signal.reasons.length > 0 ? signal.reasons : signal.confirmations),
    confirmedBarTime: signal.confirmedBarTime,
    createdAt: signal.createdAt,
    sequence: 0,
  };
}

/**
 * Aggregates every engine's confirmed signals into one deterministic, strongest-first
 * ranking. Identical setups from the same engine (same symbol/direction/model) collapse
 * to a single entry so a re-scan never inflates the list.
 */
export function buildRankedSetups(input: RankedSignalsInput): RankedSetup[] {
  const byKey = new Map<string, RankedSetup>();

  const add = (setup: RankedSetup) => {
    const existing = byKey.get(setup.key);
    if (!existing || setup.score > existing.score || setup.createdAt > existing.createdAt) {
      byKey.set(setup.key, setup);
    }
  };

  for (const s of input.engineSignals) add(fromEngineSignal(s));
  for (const s of input.trendlineSignals) add(fromTrendlineSignal(s));
  for (const s of input.dsSignals) add(fromDsSignal(s));
  for (const { moduleLabel, signal } of input.aiSignals) add(fromAiSignal(moduleLabel, signal));

  return [...byKey.values()];
}

/**
 * Orders ranked setups strongest first. Ties break on risk:reward, then on the most
 * recently confirmed setup, then on arrival order — always deterministic.
 */
export function rankSetups<T extends RankedSetup>(setups: readonly T[]): T[] {
  return [...setups]
    .map((s, i) => ({ ...s, sequence: s.sequence || i }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const rrA = a.riskRewardRatio ?? 0;
      const rrB = b.riskRewardRatio ?? 0;
      if (rrB !== rrA) return rrB - rrA;
      if (b.confirmedBarTime !== a.confirmedBarTime) return b.confirmedBarTime - a.confirmedBarTime;
      return a.sequence - b.sequence;
    });
}

/**
 * Removes duplicate and conflicting setups before ranking. Two setups that share the same
 * instrument AND direction describe the same trade — only the strongest survives. Setups
 * that share an instrument but disagree on direction are a conflict — only the stronger
 * reading survives, so one market never occupies the ranking twice.
 */
export function dedupeRankedSetups(setups: readonly RankedSetup[]): RankedSetup[] {
  const best = new Map<string, RankedSetup>();
  for (const setup of setups) {
    const bucket = `${setup.symbol}:${setup.direction}`;
    const existing = best.get(bucket);
    if (!existing || setup.score > existing.score) best.set(bucket, setup);
  }
  const perSymbol = new Map<string, RankedSetup>();
  for (const setup of best.values()) {
    const existing = perSymbol.get(setup.symbol);
    if (!existing || setup.score > existing.score) perSymbol.set(setup.symbol, setup);
  }
  return [...perSymbol.values()];
}

/** Builds, dedupes and ranks in one call. */
export function buildRanking(input: RankedSignalsInput): RankedSetup[] {
  return rankSetups(dedupeRankedSetups(buildRankedSetups(input)));
}

/** The top N ranked setups, optionally gated by a minimum score. */
export function topRankedSetups(
  setups: readonly RankedSetup[],
  limit = 3,
  minScore = 0
): RankedSetup[] {
  return rankSetups(setups)
    .filter((s) => s.score >= minScore)
    .slice(0, Math.max(0, limit));
}
