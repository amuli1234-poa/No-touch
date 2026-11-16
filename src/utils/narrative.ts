import type { FullAnalysisReport } from '../types/analysis';
import type { CoAnalysisResult } from '../types/signals';

export type DirectionTone = 'bullish' | 'bearish' | 'neutral';

export interface DirectionSummary {
  label: string;
  tone: DirectionTone;
  /** Plain-English justification drawn only from the report. */
  reason: string;
  /** Timeframe ladder, e.g. "H4 → H1 → M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1". */
  ladder: string;
  macroTf: string;
  setupTf: string;
  entryTf: string;
}

/**
 * Turns the multi-timeframe report into a single, honest directional statement.
 * The direction is only ever the engine's own conclusion — never invented.
 */
export function summariseDirection(report: FullAnalysisReport | null): DirectionSummary | null {
  if (!report) return null;

  const ladder = `${report.multiTimeframe.macroTf} → ${report.multiTimeframe.structuralTf} → ${report.multiTimeframe.setupTf} → ${report.multiTimeframe.entryTf}`;
  const tone: DirectionTone =
    report.overallDirection === 'BULLISH'
      ? 'bullish'
      : report.overallDirection === 'BEARISH'
        ? 'bearish'
        : 'neutral';
  const label =
    tone === 'bullish'
      ? 'Bullish — favour RISE'
      : tone === 'bearish'
        ? 'Bearish — favour FALL'
        : 'Neutral — no directional edge';

  const reasonParts: string[] = [report.currentStructureSummary];
  if (report.htfAlignmentSummary) reasonParts.push(report.htfAlignmentSummary);
  if (report.htfConflictNote) reasonParts.push(report.htfConflictNote);

  return {
    label,
    tone,
    reason: reasonParts.filter(Boolean).join(' · '),
    ladder,
    macroTf: report.multiTimeframe.macroTf,
    setupTf: report.multiTimeframe.setupTf,
    entryTf: report.multiTimeframe.entryTf,
  };
}

export interface NarrativeSection {
  heading: string;
  body: string;
  tone: 'info' | 'positive' | 'caution';
}

/**
 * Builds a structured, readable narrative from the report and co-analysis. Every
 * sentence is derived from engine output — no speculative or invented content.
 */
export function buildAnalysisNarrative(
  report: FullAnalysisReport | null,
  coAnalysis: CoAnalysisResult | null
): NarrativeSection[] {
  if (!report) return [];
  const sections: NarrativeSection[] = [];
  const dir = summariseDirection(report);
  const signal = report.overlays.signal;

  if (dir) {
    sections.push({
      heading: 'Market direction',
      body: `${dir.label}. ${dir.reason} Analysis ladder: ${dir.ladder}.`,
      tone: dir.tone === 'bullish' ? 'positive' : dir.tone === 'bearish' ? 'caution' : 'info',
    });
  }

  sections.push({
    heading: 'Top-down read',
    body:
      `On ${report.timeframe}, the market condition is ${report.marketCondition.replace(/_/g, ' ').toLowerCase()}: ` +
      `${report.conditionExplanation} Momentum reads ${report.momentum.summary}`,
    tone: 'info',
  });

  if (signal) {
    sections.push({
      heading: `${signal.direction} setup — ${signal.modelLabel}`,
      body:
        `${signal.confirmationExplanation} Quality ${signal.quality.total}/100 ` +
        `(${signal.quality.tier.replace(/_/g, ' ').toLowerCase()}), risk/reward ${signal.riskRewardRatio}:1. ` +
        `Entry ${signal.entryPrice}, invalidation ${signal.invalidationPrice}` +
        `${signal.takeProfit1 !== null ? `, first target ${signal.takeProfit1}` : ''}.`,
      tone: signal.direction === 'RISE' ? 'positive' : 'caution',
    });
  } else {
    sections.push({
      heading: 'No confirmed setup',
      body: report.noSetupMessage,
      tone: 'info',
    });
  }

  if (coAnalysis) {
    const engineLine =
      coAnalysis.verdict === 'ALIGNED'
        ? 'Both engines agree — shared validation passed.'
        : coAnalysis.verdict === 'PARTIAL'
          ? 'Both engines agree on direction but selected different entry models.'
          : coAnalysis.verdict === 'CONFLICT'
            ? 'The two engines disagree on direction — stand aside until they align.'
            : coAnalysis.verdict === 'SCANNER_ONLY'
              ? 'Only the scanner has confirmed; the depth engine has not validated yet.'
              : coAnalysis.verdict === 'ANALYSER_ONLY'
                ? 'Only the depth engine has confirmed; the scanner did not surface this setup.'
                : 'Neither engine has a confirmed setup.';
    sections.push({
      heading: 'Dual-engine reconciliation',
      body: `${engineLine} ${coAnalysis.notes.join(' ')}`.trim(),
      tone:
        coAnalysis.verdict === 'ALIGNED'
          ? 'positive'
          : coAnalysis.verdict === 'CONFLICT'
            ? 'caution'
            : 'info',
    });
  }

  return sections;
}
