import type { FullAnalysisReport, SignalSnapshot } from '../types/analysis';
import type { EngineSignal, EntryModelId, MarketCondition, QualityBreakdown } from '../types/engine';
import type { MarketFamily, TimeframeKey } from '../types/market';
import type { CoAnalysisResult, SignalFeedItem, SignalSource } from '../types/signals';
import type { TrendlineSignal } from '../types/trendline';

/** Stable id so a re-derived item for the same instrument keeps the same React key. */
function signalId(prefix: string, symbol: string, timeframe: TimeframeKey, direction: string): string {
  return `${prefix}-${symbol}-${timeframe}-${direction}`;
}

/** Freezes an engine signal into an immutable evidence snapshot. */
export function snapshotFromEngineSignal(
  signal: EngineSignal,
  source: SignalSnapshot['source'] = 'SCANNER'
): SignalSnapshot {
  return {
    id: signal.id,
    source,
    symbol: signal.symbol,
    displayName: signal.displayName,
    direction: signal.direction,
    model: signal.model,
    modelLabel: signal.modelLabel,
    condition: signal.condition,
    timeframe: signal.analysisTimeframe,
    qualityTotal: signal.quality.total,
    quality: signal.quality,
    entryPrice: signal.entryPrice,
    invalidationPrice: signal.invalidationPrice,
    invalidationCondition: signal.invalidationCondition,
    target1: signal.target1,
    target2: signal.target2,
    stopLoss: signal.stopLoss,
    riskRewardRatio: signal.riskRewardRatio,
    confirmationExplanation: signal.confirmationExplanation,
    reasons: signal.reasons,
    bosChochEvidence: signal.bosChochEvidence,
    capturedAt: signal.createdAt,
    confirmedBarTime: signal.confirmedBarTime,
  };
}

/** Freezes an analyser signal card into an immutable evidence snapshot. */
export function snapshotFromReport(report: FullAnalysisReport): SignalSnapshot | null {
  const sig = report.overlays.signal;
  if (!sig) return null;
  return {
    id: sig.id,
    source: 'ANALYSER',
    symbol: report.symbol,
    displayName: report.marketName,
    direction: sig.direction,
    model: sig.model,
    modelLabel: sig.modelLabel,
    condition: sig.condition,
    timeframe: report.timeframe,
    qualityTotal: sig.quality.total,
    quality: sig.quality,
    entryPrice: sig.entryPrice,
    invalidationPrice: sig.invalidationPrice,
    invalidationCondition: sig.invalidationCondition,
    target1: sig.takeProfit1,
    target2: sig.takeProfit2,
    stopLoss: sig.stopLoss,
    riskRewardRatio: sig.riskRewardRatio,
    confirmationExplanation: sig.confirmationExplanation,
    reasons: sig.reasons,
    bosChochEvidence: sig.bosChochEvidence,
    capturedAt: report.analyzedAt,
    confirmedBarTime: sig.entryCandleTime,
  };
}

export function scannerSignalItem(
  signal: EngineSignal | null,
  coAnalysis: CoAnalysisResult | null
): SignalFeedItem | null {
  if (!signal) return null;
  const validated = coAnalysis?.validated === true && coAnalysis.symbol === signal.symbol;
  return {
    id: signalId('scan', signal.symbol, signal.analysisTimeframe, signal.direction),
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.analysisTimeframe,
    direction: signal.direction,
    model: signal.model,
    modelLabel: signal.modelLabel,
    condition: signal.condition,
    state: signal.state,
    quality: signal.quality,
    source: validated ? 'CO-ANALYSIS' : 'SCANNER',
    confidence: signal.quality.total,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.target1,
    takeProfit2: signal.target2,
    riskRewardRatio: signal.riskRewardRatio,
    validated,
    coAnalysis: validated ? coAnalysis : null,
    createdAt: signal.createdAt,
    snapshot: snapshotFromEngineSignal(signal, validated ? 'CO-ANALYSIS' : 'SCANNER'),
    target: { symbol: signal.symbol, timeframe: signal.analysisTimeframe },
  };
}

export function analyserSignalItem(
  report: FullAnalysisReport | null,
  coAnalysis: CoAnalysisResult | null
): SignalFeedItem | null {
  const sig = report?.overlays.signal;
  if (!report || !sig) return null;
  const validated =
    coAnalysis?.validated === true &&
    coAnalysis.symbol === report.symbol &&
    coAnalysis.agreedDirection === sig.direction;
  return {
    id: signalId('ana', report.symbol, report.timeframe, sig.direction),
    symbol: report.symbol,
    displayName: report.marketName,
    marketFamily: report.marketFamily,
    timeframe: report.timeframe,
    direction: sig.direction,
    model: sig.model,
    modelLabel: sig.modelLabel,
    condition: sig.condition,
    state: sig.state,
    quality: sig.quality,
    source: validated ? 'CO-ANALYSIS' : 'ANALYSER',
    confidence: sig.quality.total,
    entryPrice: sig.entryPrice,
    stopLoss: sig.stopLoss,
    takeProfit1: sig.takeProfit1,
    takeProfit2: sig.takeProfit2,
    riskRewardRatio: sig.riskRewardRatio,
    validated,
    coAnalysis: validated ? coAnalysis : null,
    createdAt: report.analyzedAt,
    snapshot: snapshotFromReport(report),
    target: { symbol: report.symbol, timeframe: report.timeframe },
  };
}

/**
 * Maps a Trendline Scanner signal into the unified feed. The trendline module has no
 * price-action equivalent, so it maps onto the closest existing entry model purely for
 * downstream display/ledger compatibility; the trendline model itself is preserved in
 * `modelLabel` and the immutable snapshot.
 */
export function trendlineSignalItem(signal: TrendlineSignal | null): SignalFeedItem | null {
  if (!signal) return null;
  const isRise = signal.direction === 'RISE';
  const mappedModel: EntryModelId = isRise
    ? 'MODEL_6_TRENDLINE_BREAK_RETEST'
    : 'MODEL_3_SUPPORT_RESISTANCE_REJECTION';
  const condition: MarketCondition =
    signal.condition === 'UPTREND'
      ? 'STRONG_UPTREND'
      : signal.condition === 'DOWNTREND'
        ? 'STRONG_DOWNTREND'
        : signal.condition === 'SIDEWAYS' || signal.condition === 'RANGE_EXTREME'
          ? 'SIDEWAYS_RANGE'
          : 'CHOPPY';
  const quality: QualityBreakdown = {
    structure: signal.trendline.touches * 5,
    levelZone: Math.round(signal.score * 0.2),
    entryConfirmation: signal.rejection.confirmed ? 25 : 0,
    momentum: 12,
    multiTimeframe: 8,
    availableSpace: 8,
    total: signal.score,
    tier: signal.score >= 92 ? 'EXCEPTIONAL' : 'HIGH_QUALITY',
    publishable: true,
  };
  return {
    id: signal.id,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.structureTimeframe,
    direction: signal.direction,
    model: mappedModel,
    modelLabel: signal.modelLabel,
    condition,
    state: signal.status === 'COMPLETED' ? 'COMPLETED' : signal.status === 'INVALIDATED' ? 'INVALIDATED' : 'CONFIRMED',
    quality,
    source: 'TRENDLINE',
    confidence: signal.score,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit,
    takeProfit2: null,
    riskRewardRatio: signal.riskRewardRatio,
    validated: false,
    coAnalysis: null,
    createdAt: signal.createdAt,
    snapshot: {
      id: signal.id,
      source: 'SCANNER',
      symbol: signal.symbol,
      displayName: signal.displayName,
      direction: signal.direction,
      model: mappedModel,
      modelLabel: signal.modelLabel,
      condition,
      timeframe: signal.structureTimeframe,
      qualityTotal: signal.score,
      quality,
      entryPrice: signal.entryPrice,
      invalidationPrice: signal.invalidationPrice,
      invalidationCondition: signal.invalidationCondition,
      target1: signal.takeProfit,
      target2: null,
      stopLoss: signal.stopLoss,
      riskRewardRatio: signal.riskRewardRatio,
      confirmationExplanation: signal.m5Confirmation,
      reasons: signal.reasons,
      bosChochEvidence: signal.confirmations,
      capturedAt: signal.createdAt,
      confirmedBarTime: signal.confirmedBarTime,
    },
    target: { symbol: signal.symbol, timeframe: signal.structureTimeframe },
  };
}

const SOURCE_RANK: Record<SignalSource, number> = {
  'CO-ANALYSIS': 4,
  TRENDLINE: 3,
  ANALYSER: 2,
  SCANNER: 1,
};

/**
 * Merges both engines' items into one deduped, newest-first feed. Items for the same
 * instrument/timeframe/direction collapse to the strongest source (co-analysis wins),
 * so the user sees one consistent card per real setup.
 */
export function buildSignalFeed(
  items: readonly (SignalFeedItem | null)[]
): SignalFeedItem[] {
  const byKey = new Map<string, SignalFeedItem>();
  for (const item of items) {
    if (!item) continue;
    const key = `${item.symbol}-${item.timeframe}-${item.direction}`;
    const existing = byKey.get(key);
    if (!existing || SOURCE_RANK[item.source] > SOURCE_RANK[existing.source]) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt);
}
