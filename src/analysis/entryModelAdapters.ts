import type { AiSignal } from '../types/aiModule';
import type { DsSignal } from '../types/demandSupply';
import type { EngineSignal } from '../types/engine';
import type { EntryModelSetupInput } from '../types/entryModelAI';
import type { TrendlineSignal } from '../types/trendline';

/**
 * Adapters that normalise each specialised strategy's confirmed signal into the shared
 * input the universal Entry Model AI evaluates. The originating detection logic is
 * preserved — every field is copied from the strategy's own signal; nothing is re-derived.
 */

export function engineSignalToEntryInput(signal: EngineSignal): EntryModelSetupInput {
  const zone = signal.entryZone;
  return {
    key: `PRICE_ACTION:${signal.symbol}:${signal.analysisTimeframe}:${signal.direction}:${signal.model}`,
    sourceLabel: 'Market Scanner / Analyser',
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.analysisTimeframe,
    direction: signal.direction,
    originatingModelLabel: signal.modelLabel,
    score: signal.quality.total,
    entryPrice: signal.entryPrice,
    entryZoneLow: zone ? Math.min(zone[0], zone[1]) : null,
    entryZoneHigh: zone ? Math.max(zone[0], zone[1]) : null,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.target1,
    takeProfit2: signal.target2,
    takeProfit3: null,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: signal.reasons,
    evidence: [...signal.bosChochEvidence, ...signal.momentumEvidence, signal.confirmationExplanation],
    confirmedBarTime: signal.confirmedBarTime,
  };
}

export function trendlineSignalToEntryInput(signal: TrendlineSignal): EntryModelSetupInput {
  return {
    key: `TRENDLINE:${signal.symbol}:${signal.structureTimeframe}:${signal.direction}:${signal.model}`,
    sourceLabel: 'Trendline AI',
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.entryTimeframe,
    direction: signal.direction,
    originatingModelLabel: signal.modelLabel,
    score: signal.score,
    entryPrice: signal.entryPrice,
    entryZoneLow: signal.zone ? Math.min(signal.zone.upperPrice, signal.zone.lowerPrice) : null,
    entryZoneHigh: signal.zone ? Math.max(signal.zone.upperPrice, signal.zone.lowerPrice) : null,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit,
    takeProfit2: null,
    takeProfit3: null,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: signal.reasons,
    evidence: [...signal.confirmations, signal.entryConfirmation.reason, signal.m15Context, signal.m5Confirmation, signal.m1Confirmation],
    confirmedBarTime: signal.confirmedBarTime,
  };
}

export function dsSignalToEntryInput(signal: DsSignal): EntryModelSetupInput {
  return {
    key: `DEMAND_SUPPLY:${signal.symbol}:${signal.setupTimeframe}:${signal.direction}:${signal.model}`,
    sourceLabel: 'Demand & Supply AI',
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.entryTimeframe,
    direction: signal.direction,
    originatingModelLabel: signal.modelLabel,
    score: signal.score,
    entryPrice: signal.entryPrice,
    entryZoneLow: signal.entryZoneLow,
    entryZoneHigh: signal.entryZoneHigh,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    takeProfit3: signal.takeProfit3,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: signal.reasons,
    evidence: [...signal.confirmations, signal.confirmation.reason, signal.m15Context, signal.m5Setup, signal.m1Confirmation],
    confirmedBarTime: signal.confirmedBarTime,
  };
}

export function aiSignalToEntryInput(moduleLabel: string, signal: AiSignal): EntryModelSetupInput {
  const setupTimeframe = signal.timeframes[0]?.timeframe ?? 'M5';
  return {
    key: `AI_MODULE:${signal.symbol}:${setupTimeframe}:${signal.direction}:${signal.modelId}`,
    sourceLabel: moduleLabel,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: setupTimeframe,
    direction: signal.direction,
    originatingModelLabel: signal.modelLabel,
    score: signal.score,
    entryPrice: signal.entryPrice,
    entryZoneLow: signal.entryZoneLow,
    entryZoneHigh: signal.entryZoneHigh,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    takeProfit3: signal.takeProfit3,
    riskRewardRatio: signal.riskRewardRatio,
    reasons: signal.reasons,
    evidence: signal.confirmations,
    confirmedBarTime: signal.confirmedBarTime,
  };
}
