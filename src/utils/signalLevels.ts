import type { FullAnalysisReport, SignalSnapshot } from '../types/analysis';
import type { SignalFeedItem } from '../types/signals';
import type { ManagedSignal } from '../types/training';
import type { EntryModelDecision } from '../types/entryModelAI';
import type { SignalLevels } from '../components/chart/SignalAnnotationPrimitive';

export interface DeriveSignalLevelsInput {
  report: FullAnalysisReport | null;
  snapshot: SignalSnapshot | null;
  managed: ManagedSignal | null;
  feedItem: SignalFeedItem | null;
  /**
   * The universal Entry Model AI's decision for the setup currently open in Chart Analysis.
   * When present (and the setup is not invalidated/missed) it supplies the clean entry-model
   * markings — watching zone, entry area, stop-loss and take-profit levels.
   */
  entryModel?: EntryModelDecision | null;
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
  entryModel,
  tpAnimating,
}: DeriveSignalLevelsInput): SignalLevels | null {
  // A selected entry model for the open setup takes precedence while it is still actionable
  // (never for an INVALIDATED / MISSED setup, so a dead setup is never drawn as an entry).
  if (
    entryModel &&
    entryModel.state !== 'INVALIDATED' &&
    entryModel.state !== 'MISSED' &&
    entryModel.entryPrice !== null &&
    entryModel.stopLoss !== null
  ) {
    return {
      direction: entryModel.direction,
      entry: entryModel.entryPrice,
      stopLoss: entryModel.stopLoss,
      takeProfit: entryModel.targets.tp1 ?? entryModel.entryPrice,
      confirmationTime: entryModel.confirmedBarTime,
      entryTime: entryModel.confirmedBarTime,
      modelLabel: entryModel.modelLabel,
      quality: entryModel.qualityScore,
      tpAnimating,
    };
  }

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
