import type { FullAnalysisReport } from '../types/analysis';
import type { ChartLoadState, ConnectionStatus } from '../types/market';

export type AnalysisStage =
  | 'CONNECTING'
  | 'LOADING MARKET DATA'
  | 'ANALYSING STRUCTURE'
  | 'CHECKING MOMENTUM'
  | 'VALIDATING SETUP'
  | 'CONFIRMED'
  | 'WAIT';

export interface AnalysisStageInfo {
  stage: AnalysisStage;
  tone: 'info' | 'progress' | 'success' | 'wait';
  /** 0..1 progress estimate for the pipeline indicator. */
  progress: number;
}

export interface AnalysisStageInput {
  connectionStatus: ConnectionStatus;
  loadState: ChartLoadState;
  isAnalyzing: boolean;
  report: FullAnalysisReport | null;
  hasCandles: boolean;
  hasRanAnalysis: boolean;
}

const STAGE_ORDER: AnalysisStage[] = [
  'CONNECTING',
  'LOADING MARKET DATA',
  'ANALYSING STRUCTURE',
  'CHECKING MOMENTUM',
  'VALIDATING SETUP',
];

/**
 * Maps live connection/data/analysis state onto the visible analyser pipeline.
 * Purely descriptive of real state - it never invents progress that has not
 * happened, and CONFIRMED only appears when the engine produced a signal.
 */
export function deriveAnalysisStage(input: AnalysisStageInput): AnalysisStageInfo {
  const { connectionStatus, loadState, isAnalyzing, report, hasCandles, hasRanAnalysis } =
    input;

  if (
    connectionStatus === 'connecting' ||
    connectionStatus === 'reconnecting' ||
    connectionStatus === 'rate_limited' ||
    connectionStatus === 'stale'
  ) {
    return { stage: 'CONNECTING', tone: 'progress', progress: 0.1 };
  }
  if (connectionStatus === 'error' || connectionStatus === 'disconnected') {
    return { stage: 'CONNECTING', tone: 'progress', progress: 0.1 };
  }
  if (loadState === 'loading' || !hasCandles) {
    return { stage: 'LOADING MARKET DATA', tone: 'progress', progress: 0.3 };
  }

  if (isAnalyzing) {
    return { stage: 'ANALYSING STRUCTURE', tone: 'progress', progress: 0.55 };
  }

  if (report) {
    if (report.signalStatus === 'CONFIRMED' && report.overlays.signal) {
      return { stage: 'CONFIRMED', tone: 'success', progress: 1 };
    }
    if (report.runState === 'SETUP INVALIDATED') {
      return { stage: 'WAIT', tone: 'wait', progress: 1 };
    }
    if (report.runState === 'WAITING FOR CONFIRMATION') {
      return { stage: 'VALIDATING SETUP', tone: 'progress', progress: 0.8 };
    }
    return { stage: 'WAIT', tone: 'wait', progress: 1 };
  }

  if (hasRanAnalysis) {
    return { stage: 'VALIDATING SETUP', tone: 'progress', progress: 0.7 };
  }

  return { stage: 'WAIT', tone: 'wait', progress: 0.45 };
}

export const ANALYSIS_STAGE_TONE: Record<
  AnalysisStageInfo['tone'],
  { text: string; bg: string; border: string; dot: string }
> = {
  info: {
    text: 'text-muted',
    bg: 'bg-panel',
    border: 'border-line',
    dot: 'bg-faint',
  },
  progress: {
    text: 'text-accent',
    bg: 'bg-accent/10',
    border: 'border-accent/30',
    dot: 'bg-accent animate-pulse',
  },
  success: {
    text: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    dot: 'bg-emerald-400',
  },
  wait: {
    text: 'text-warn',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    dot: 'bg-amber-400',
  },
};

export function stageIndex(stage: AnalysisStage): number {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx === -1 ? STAGE_ORDER.length : idx;
}
