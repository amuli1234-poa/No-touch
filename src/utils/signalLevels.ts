import type { FullAnalysisReport, SignalSnapshot } from '../types/analysis';
import type { SignalFeedItem } from '../types/signals';
import type { ManagedSignal } from '../types/training';
import type { SignalLevels } from '../components/chart/SignalAnnotationPrimitive';

export interface DeriveSignalLevelsInput {
  report: FullAnalysisReport | null;
  snapshot: SignalSnapshot | null;
  managed: ManagedSignal | null;
  feedItem: SignalFeedItem | null;
  tpAnimating?: boolean;
}

/**
 * Resolves the single set of annotations to draw on the chart, preferring the
 * freshest live evidence and never inventing a level:
 *
 *   live analyser signal  →  managed (locked entry/SL + dynamic TP)  →
 *   reproduced scanner snapshot  →  feed item  →  nothing.
 *
 * Entry and stop-loss come from the locked managed record when one exists so the
 * chart can never show a moved entry or stop.
 */
export function deriveSignalLevels({
  report,
  snapshot,
  managed,
  feedItem,
  tpAnimating,
}: DeriveSignalLevelsInput): SignalLevels | null {
  if (managed) {
    return {
      direction: managed.direction,
      entry: managed.entry,
      stopLoss: managed.stopLoss,
      takeProfit: managed.takeProfit,
      confirmationTime: managed.confirmedBarTime,
      entryTime: managed.confirmedBarTime,
      modelLabel: managed.modelLabel,
      quality: managed.qualityScore,
      tpAnimating,
    };
  }

  const signal = report?.overlays.signal ?? null;
  if (signal) {
    return {
      direction: signal.direction,
      entry: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit1,
      confirmationTime: signal.entryCandleTime,
      entryTime: signal.entryCandleTime,
      modelLabel: signal.modelLabel,
      quality: signal.quality.total,
      tpAnimating,
    };
  }

  if (snapshot) {
    return {
      direction: snapshot.direction,
      entry: snapshot.entryPrice,
      stopLoss: snapshot.stopLoss,
      takeProfit: snapshot.target1 ?? snapshot.stopLoss,
      confirmationTime: snapshot.confirmedBarTime,
      entryTime: snapshot.confirmedBarTime,
      modelLabel: snapshot.modelLabel,
      quality: snapshot.qualityTotal,
      tpAnimating,
    };
  }

  if (feedItem && feedItem.entryPrice !== null && feedItem.stopLoss !== null) {
    return {
      direction: feedItem.direction,
      entry: feedItem.entryPrice,
      stopLoss: feedItem.stopLoss,
      takeProfit: feedItem.takeProfit1 ?? feedItem.entryPrice,
      confirmationTime: feedItem.snapshot?.confirmedBarTime ?? feedItem.createdAt,
      entryTime: feedItem.snapshot?.confirmedBarTime ?? feedItem.createdAt,
      modelLabel: feedItem.modelLabel,
      quality: feedItem.confidence,
      tpAnimating,
    };
  }

  return null;
}
