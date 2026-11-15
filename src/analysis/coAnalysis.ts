import type { FullAnalysisReport, TradeSignalCard } from '../types/analysis';
import type { EngineSignal } from '../types/engine';
import type { TimeframeKey } from '../types/market';
import type { CoAnalysisResult, CoAnalysisVerdict, ReconciledLevels } from '../types/signals';

/** A single engine's contribution to the co-analysis, normalised to a common shape. */
export interface EngineSignalView {
  direction: 'RISE' | 'FALL' | 'WAIT' | null;
  model: EngineSignal['model'] | null;
  modelLabel: string | null;
  /** 0–100. */
  confidence: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskRewardRatio: number | null;
  structuralLevelPrice: number | null;
}

export interface CoAnalysisInput {
  symbol: string;
  timeframe: TimeframeKey;
  scanner: EngineSignal | null;
  analyser: FullAnalysisReport | null;
}

function clamp01to100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Direction the depth engine recommends, derived from its signal card. */
export function analyserDirection(report: FullAnalysisReport | null): 'RISE' | 'FALL' | 'WAIT' | null {
  if (!report) return null;
  const sig: TradeSignalCard | null = report.overlays.signal;
  if (sig && sig.signalStatus === 'CONFIRMED') return sig.direction;
  if (report.recommendedDirection === 'RISE' || report.recommendedDirection === 'FALL') {
    return report.recommendedDirection;
  }
  return 'WAIT';
}

export function scannerEngineView(signal: EngineSignal | null): EngineSignalView | null {
  if (!signal) return null;
  return {
    direction: signal.direction,
    model: signal.model,
    modelLabel: signal.modelLabel,
    confidence: clamp01to100(signal.quality.total),
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.target1,
    takeProfit2: signal.target2,
    riskRewardRatio: signal.riskRewardRatio,
    structuralLevelPrice: signal.entryZone ? signal.entryZone[0] : signal.entryPrice,
  };
}

export function analyserEngineView(report: FullAnalysisReport | null): EngineSignalView | null {
  if (!report) return null;
  const sig: TradeSignalCard | null = report.overlays.signal;
  const confidence = clamp01to100(sig?.quality.total ?? 0);
  return {
    direction: analyserDirection(report),
    model: sig?.model ?? null,
    modelLabel: sig?.modelLabel ?? null,
    confidence,
    entryPrice: sig?.entryPrice ?? null,
    stopLoss: sig?.stopLoss ?? null,
    takeProfit1: sig?.takeProfit1 ?? null,
    takeProfit2: sig?.takeProfit2 ?? null,
    riskRewardRatio: sig?.riskRewardRatio ?? null,
    structuralLevelPrice: sig?.structuralLevelPrice ?? null,
  };
}

function relativeLevelAgreement(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  if (a === 0 && b === 0) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom <= 0.01; // within 1%
}

function buildLevels(scanner: EngineSignalView, analyser: EngineSignalView): ReconciledLevels {
  return {
    // Prefer the depth engine's levels (chart-precise); fall back to breadth engine.
    entryPrice: analyser.entryPrice ?? scanner.entryPrice,
    stopLoss: analyser.stopLoss ?? scanner.stopLoss,
    takeProfit1: analyser.takeProfit1 ?? scanner.takeProfit1,
    takeProfit2: analyser.takeProfit2 ?? scanner.takeProfit2,
    riskRewardRatio: analyser.riskRewardRatio ?? scanner.riskRewardRatio,
  };
}

/**
 * Reconcile the breadth (scanner) and depth (analyser) engines for one instrument.
 * This is the shared-validation gate: a signal is only "validated" when both
 * engines independently confirm the same direction.
 */
export function reconcileEngines({
  symbol,
  timeframe,
  scanner,
  analyser,
}: CoAnalysisInput): CoAnalysisResult {
  const sView = scannerEngineView(scanner);
  const aView = analyserEngineView(analyser);

  const sDir = sView?.direction ?? null;
  const aDir = aView?.direction ?? null;
  const sConfirmed = sDir === 'RISE' || sDir === 'FALL';
  const aConfirmed = aDir === 'RISE' || aDir === 'FALL';

  const notes: string[] = [];
  let verdict: CoAnalysisVerdict;

  if (sConfirmed && aConfirmed) {
    if (sDir === aDir) {
      const modelAgreement =
        !!sView?.model && !!aView?.model && sView.model === aView.model;
      const levelAgreement = relativeLevelAgreement(
        sView?.entryPrice ?? null,
        aView?.entryPrice ?? null
      );
      verdict = modelAgreement ? 'ALIGNED' : 'PARTIAL';
      if (modelAgreement) {
        notes.push(`Both engines agree on ${sDir} via ${aView?.modelLabel ?? sView?.modelLabel}.`);
      } else {
        notes.push(
          `Both engines agree on ${sDir}, but selected different entry models ` +
            `(${sView?.modelLabel ?? 'n/a'} vs ${aView?.modelLabel ?? 'n/a'}).`
        );
      }
      if (!levelAgreement && (sView?.entryPrice ?? null) !== null && (aView?.entryPrice ?? null) !== null) {
        notes.push('Entry references differ by more than 1% between engines.');
      }
    } else {
      verdict = 'CONFLICT';
      notes.push(
        `Engines disagree: scanner says ${sDir}, analyser says ${aDir}. Wait for agreement.`
      );
    }
  } else if (sConfirmed) {
    verdict = 'SCANNER_ONLY';
    notes.push('Breadth engine confirmed; depth engine has not confirmed yet.');
  } else if (aConfirmed) {
    verdict = 'ANALYSER_ONLY';
    notes.push('Depth engine confirmed; breadth engine did not surface this setup.');
  } else {
    verdict = 'NO_SIGNAL';
    notes.push('No confirmed setup from either engine.');
  }

  const agreedDirection =
    sConfirmed && aConfirmed && sDir === aDir ? (sDir as 'RISE' | 'FALL') : null;
  const agreedModel =
    agreedDirection !== null && sView?.model && aView?.model && sView.model === aView.model
      ? sView.model
      : agreedDirection !== null
        ? (aView?.model ?? sView?.model ?? null)
        : null;

  const combinedConfidence =
    agreedDirection !== null
      ? Math.round(((sView?.confidence ?? 0) + (aView?.confidence ?? 0)) / 2)
      : sConfirmed && aConfirmed
        ? Math.max(sView?.confidence ?? 0, aView?.confidence ?? 0)
        : (sConfirmed ? (sView?.confidence ?? null) : (aView?.confidence ?? null));

  return {
    verdict,
    symbol,
    timeframe,
    scannerDirection: sDir,
    analyserDirection: aDir,
    agreedDirection,
    scannerModel: sView?.model ?? null,
    analyserModel: aView?.model ?? null,
    agreedModel,
    scannerModelLabel: sView?.modelLabel ?? null,
    analyserModelLabel: aView?.modelLabel ?? null,
    scannerConfidence: sView?.confidence ?? null,
    analyserConfidence: aView?.confidence ?? null,
    combinedConfidence,
    modelAgreement:
      !!sView?.model && !!aView?.model && sView.model === aView.model && agreedDirection !== null,
    levelAgreement:
      agreedDirection !== null &&
      relativeLevelAgreement(sView?.entryPrice ?? null, aView?.entryPrice ?? null),
    levels: sView || aView ? buildLevels(sView ?? emptyView(), aView ?? emptyView()) : null,
    validated: agreedDirection !== null,
    notes,
  };
}

function emptyView(): EngineSignalView {
  return {
    direction: null,
    model: null,
    modelLabel: null,
    confidence: null,
    entryPrice: null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    riskRewardRatio: null,
    structuralLevelPrice: null,
  };
}
