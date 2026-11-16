import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildCompletedAnalyserTrade,
  evaluateAnalyserCompletion,
  mergeCompletedTrades,
} from '../analysis/analyserCycle';
import type { FullAnalysisReport } from '../types/analysis';
import type { EntryModelDecision } from '../types/entryModelAI';
import type { Candle } from '../types/market';
import type {
  AnalyserCycleState,
  CompletedAnalyserTrade,
} from '../types/analyserCycle';

const STORAGE_KEY = 'lucky_analyser_cycle_trades_v1';
/** Storage safety cap — history is append-only and never cleared by normal operation. */
const MAX_TRADES = 1000;

/** The analyser's own strategy id (mirrors the price-action ranking source). */
const STRATEGY_ID = 'PRICE_ACTION';
const STRATEGY_LABEL = 'Chart Analyser';

function loadTrades(): CompletedAnalyserTrade[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CompletedAnalyserTrade[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTrades(trades: readonly CompletedAnalyserTrade[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trades.slice(-MAX_TRADES)));
  } catch {
    // Ignore storage write errors — the in-memory ledger stays authoritative for the session.
  }
}

/**
 * Clears every setup/annotation layer from a report so a completed setup leaves no
 * markings behind. Candles (historical market data) are untouched; only drawings are
 * removed, and the fresh re-analysis repopulates current, valid drawings.
 */
function clearSetupFromReport(report: FullAnalysisReport): FullAnalysisReport {
  return {
    ...report,
    runState: 'NO VALID SETUP',
    signalStatus: 'WAIT',
    recommendedDirection: 'WAIT',
    setupQuality: 'INVALID SETUP',
    overlays: {
      ...report.overlays,
      supportResistance: [],
      supplyDemand: [],
      structureBreaks: [],
      liquiditySweeps: [],
      trendlines: [],
      patterns: [],
      swingPoints: [],
      majorTrendlines: [],
      majorZones: [],
      range: null,
      entryZone: null,
      breakoutRetest: null,
      signal: null,
      structure: report.overlays.structure
        ? { ...report.overlays.structure, watchZones: [], testedZones: [], breaks: [], rejectionZones: [], srBands: [], fvg: [] }
        : null,
    },
    whyThisSetup: [],
    entryTriggerText: 'Completed setup cleared — re-analysing current price action for a fresh entry.',
    invalidationText: 'No active setup to invalidate.',
    noSetupMessage: 'NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION.',
  };
}

export interface UseAnalyserCycleProps {
  /** The live analyser report (raw — before the cycle clears a completed setup). */
  report: FullAnalysisReport | null;
  /** Live candles for the viewed instrument (the forming bar is excluded internally). */
  candles: readonly Candle[];
  /** Live price, used to verify a completion between confirmed bars. */
  livePrice: number | null;
  /** True while the analyser is actively running (the cycle only acts when live). */
  active: boolean;
  /** Requests a fresh analysis run (re-analyse current price action). */
  requestReanalysis: () => void;
  /** The universal Entry Model AI's decisions, to attribute the completed trade. */
  entryDecisionByKey?: ReadonlyMap<string, EntryModelDecision>;
  /** Called exactly once per completed trade (history + learning integration). */
  onTradeCompleted?: (trade: CompletedAnalyserTrade) => void;
}

export interface AnalyserCycleValue {
  /**
   * The report the rest of the app should display: identical to the input report until a
   * setup completes, then the completed setup's markings are cleared until a fresh,
   * validated setup arrives.
   */
  effectiveReport: FullAnalysisReport | null;
  /** The current phase of the automatic cycle. */
  state: AnalyserCycleState;
  /** Every completed trade, newest last (append-only, persisted). */
  completedTrades: CompletedAnalyserTrade[];
  /** The most recently completed trade. */
  lastTrade: CompletedAnalyserTrade | null;
  /** Ids of completed setups — a completed setup is never displayed again. */
  completedIds: ReadonlySet<string>;
  /** Explicit user action only: clear the completed-trade history. */
  clearHistory: () => void;
}

/**
 * AUTOMATIC CHART RESET & FRESH-ENTRY CYCLE.
 *
 * Watches the displayed analyser setup. When price reaches its take-profit or stop-loss
 * (verified against confirmed candles and the live price), the trade is recorded
 * permanently, its chart markings are cleared, a fresh analysis is requested, and only a
 * genuinely new, validated setup is displayed again. If nothing valid exists the chart
 * stays clean and the analyser reports WAITING. A completed setup id is never reused.
 */
export function useAnalyserCycle({
  report,
  candles,
  livePrice,
  active,
  requestReanalysis,
  entryDecisionByKey,
  onTradeCompleted,
}: UseAnalyserCycleProps): AnalyserCycleValue {
  const [completedTrades, setCompletedTrades] = useState<CompletedAnalyserTrade[]>(() => loadTrades());
  const [completedIds, setCompletedIds] = useState<Set<string>>(
    () => new Set(loadTrades().map((t) => t.id))
  );
  const [awaitingFresh, setAwaitingFresh] = useState(false);

  // Live refs so the completion effect never needs to re-subscribe to callback identities.
  const requestReanalysisRef = useRef(requestReanalysis);
  requestReanalysisRef.current = requestReanalysis;
  const onTradeCompletedRef = useRef(onTradeCompleted);
  onTradeCompletedRef.current = onTradeCompleted;
  const entryDecisionRef = useRef(entryDecisionByKey);
  entryDecisionRef.current = entryDecisionByKey;

  // Report generation at the moment a setup completed — a NEWER report lifts the wait.
  const completedReportAtRef = useRef<number>(-1);

  useEffect(() => {
    saveTrades(completedTrades);
  }, [completedTrades]);

  // A newer analysis run (or a new symbol/timeframe) ends the post-completion wait.
  const analyzedAt = report?.analyzedAt ?? -1;
  useEffect(() => {
    if (!awaitingFresh) return;
    if (analyzedAt > completedReportAtRef.current) setAwaitingFresh(false);
  }, [analyzedAt, awaitingFresh]);

  // Detect completion of the displayed setup and run the cycle.
  useEffect(() => {
    if (!active || !report) return;
    const signal = report.overlays.signal;
    if (!signal || signal.entryCandleTime <= 0) return;
    if (completedIds.has(signal.id)) return;

    const confirmed = candles.length > 1 ? candles.slice(0, -1) : candles;
    const verdict = evaluateAnalyserCompletion(
      {
        id: signal.id,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        direction: signal.direction,
        entry: signal.entryPrice,
        takeProfit: signal.takeProfit1,
        stopLoss: signal.stopLoss,
        confirmedBarTime: signal.entryCandleTime,
      },
      confirmed,
      livePrice
    );
    if (!verdict.completed) return;

    const decision = entryDecisionRef.current?.get(
      `${STRATEGY_ID}:${signal.symbol}:${signal.timeframe}:${signal.direction}:${signal.model}`
    );
    const trade = buildCompletedAnalyserTrade({
      id: signal.id,
      symbol: signal.symbol,
      displayName: signal.marketName,
      marketFamily: signal.marketFamily,
      precision: report.precision,
      timeframe: signal.timeframe,
      direction: signal.direction,
      strategyLabel: STRATEGY_LABEL,
      strategyId: STRATEGY_ID,
      modelId: signal.model,
      modelLabel: signal.modelLabel,
      entryModel: decision?.model ?? 'UNKNOWN',
      entryModelLabel: decision?.modelLabel ?? signal.modelLabel,
      entry: signal.entryPrice,
      takeProfit: signal.takeProfit1,
      stopLoss: signal.stopLoss,
      invalidationPrice: signal.invalidationPrice,
      entryZone: [Math.min(signal.entryPrice, signal.structuralLevelPrice), Math.max(signal.entryPrice, signal.structuralLevelPrice)],
      riskRewardRatio: signal.riskRewardRatio,
      verdict,
      confirmedAt: signal.entryCandleTime * 1000,
      chartAnalysis: {
        qualityScore: signal.quality.total,
        quality: signal.quality,
        condition: signal.condition,
        confirmationExplanation: signal.confirmationExplanation,
        reasons: signal.reasons,
        bosChochEvidence: signal.bosChochEvidence,
        momentumEvidence: signal.momentumEvidence,
        entryTrigger: signal.entryTrigger,
        availableSpaceAtr: signal.availableSpaceAtr,
        availableSpaceLabel: signal.availableSpaceLabel,
        confluenceScore: signal.confluenceScore,
        maxConfluenceScore: signal.maxConfluenceScore,
        htfAlignmentSummary: report.htfAlignmentSummary,
        currentStructureSummary: report.currentStructureSummary,
        confirmedBarTime: signal.entryCandleTime,
      },
      now: Date.now(),
    });

    completedReportAtRef.current = report.analyzedAt;
    setCompletedTrades((prev) => mergeCompletedTrades(prev, [trade]));
    setCompletedIds((prev) => {
      if (prev.has(signal.id)) return prev;
      const next = new Set(prev);
      next.add(signal.id);
      return next;
    });
    setAwaitingFresh(true);
    onTradeCompletedRef.current?.(trade);
    requestReanalysisRef.current?.();
  }, [active, report, candles, livePrice, completedIds]);

  // The rest of the app reads this report: a completed setup's markings are cleared.
  const effectiveReport = useMemo(() => {
    if (!report) return null;
    const signal = report.overlays.signal;
    if (signal && completedIds.has(signal.id)) return clearSetupFromReport(report);
    return report;
  }, [report, completedIds]);

  const lastTrade = completedTrades.length > 0 ? completedTrades[completedTrades.length - 1] : null;

  const state = useMemo<AnalyserCycleState>(() => {
    const signal = effectiveReport?.overlays.signal ?? null;
    if (awaitingFresh) {
      return {
        phase: 'REANALYSING',
        activeSetupId: null,
        lastTrade,
        completedCount: completedTrades.length,
        message: lastTrade
          ? `${lastTrade.outcome === 'TARGET_HIT' ? 'Take-profit' : 'Stop-loss'} reached — trade saved, chart cleared, re-analysing for a fresh entry.`
          : 'Re-analysing current price action for a fresh entry.',
      };
    }
    if (signal) {
      return {
        phase: 'FRESH_ENTRY',
        activeSetupId: signal.id,
        lastTrade,
        completedCount: completedTrades.length,
        message: `Fresh ${signal.direction} setup displayed — monitoring for take-profit or stop-loss.`,
      };
    }
    return {
      phase: 'WAITING',
      activeSetupId: null,
      lastTrade,
      completedCount: completedTrades.length,
      message: 'No valid opportunity — the chart is clean and waiting for a confirmed setup.',
    };
  }, [effectiveReport, awaitingFresh, lastTrade, completedTrades.length]);

  const clearHistory = useCallback(() => {
    setCompletedTrades([]);
    setCompletedIds(new Set());
    completedReportAtRef.current = -1;
    setAwaitingFresh(false);
    saveTrades([]);
  }, []);

  return { effectiveReport, state, completedTrades, lastTrade, completedIds, clearHistory };
}
