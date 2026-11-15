import { useCallback, useEffect, useRef, useState } from 'react';
import { runTopDownPriceActionAnalysis } from '../analysis/engine';
import { TIMEFRAME_MAP } from '../config/deriv';
import type {
  AnalysisControlMode,
  AnalysisRunState,
  FullAnalysisReport,
  MultiTimeframeCandles,
  SignalSnapshot,
  TradeSignalCard,
} from '../types/analysis';
import type {
  Candle,
  ChartLoadState,
  ConnectionStatus,
  MarketFamily,
  TimeframeKey,
} from '../types/market';
import type { LiveCandleTick } from './useDerivChartData';

const ALL_TIMEFRAMES: readonly TimeframeKey[] = ['H4', 'H1', 'M15', 'M5', 'M1'];
const HTF_CACHE_TTL_MS = 60_000;

interface CachedTfSnapshot {
  fetchedAt: number;
  candles: Candle[];
}

interface UsePriceActionAnalysisParams {
  symbol: string;
  marketName: string;
  marketFamily: MarketFamily;
  activeTimeframe: TimeframeKey;
  precision: number;
  candles: Candle[];
  liveTick: LiveCandleTick | null;
  loadState: ChartLoadState;
  connectionStatus: ConnectionStatus;
  /** True when the live feed is disconnected or has not produced a tick recently. */
  feedStale: boolean;
  /** When set, the first analysis run reproduces this exact scanner evidence. */
  pendingSnapshot?: SignalSnapshot | null;
  fetchCandlesSnapshot: (
    symbol: string,
    tf: TimeframeKey,
    count?: number
  ) => Promise<Candle[]>;
}

export function usePriceActionAnalysis({
  symbol,
  marketName,
  marketFamily,
  activeTimeframe,
  precision,
  candles,
  liveTick,
  loadState,
  connectionStatus,
  feedStale,
  pendingSnapshot = null,
  fetchCandlesSnapshot,
}: UsePriceActionAnalysisParams) {
  const [controlMode, setControlMode] = useState<AnalysisControlMode>('idle');
  const [runState, setRunState] = useState<AnalysisRunState>('READY TO ANALYZE');
  const [report, setReport] = useState<FullAnalysisReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const cacheRef = useRef<Partial<Record<TimeframeKey, CachedTfSnapshot>>>({});
  const cacheSymbolRef = useRef<string>(symbol);
  const runSeqRef = useRef<number>(0);
  const activeSignalRef = useRef<TradeSignalCard | null>(null);
  const lastConfirmedTimeRef = useRef<number>(0);
  // Holds the scanner evidence to reproduce until the matching chart run consumes it.
  const snapshotRef = useRef<SignalSnapshot | null>(pendingSnapshot);

  useEffect(() => {
    snapshotRef.current = pendingSnapshot;
  }, [pendingSnapshot]);

  const latestParamsRef = useRef({
    symbol,
    marketName,
    marketFamily,
    activeTimeframe,
    precision,
    candles,
    loadState,
    connectionStatus,
    feedStale,
    controlMode,
  });
  latestParamsRef.current = {
    symbol,
    marketName,
    marketFamily,
    activeTimeframe,
    precision,
    candles,
    loadState,
    connectionStatus,
    feedStale,
    controlMode,
  };

  const executeAnalysis = useCallback(
    async (forceRefreshHtf: boolean) => {
      const {
        symbol: curSymbol,
        marketName: curMarketName,
        marketFamily: curFamily,
        activeTimeframe: curTf,
        precision: curPrecision,
        candles: curCandles,
      } = latestParamsRef.current;

      // Never produce a signal from stale or disconnected data.
      if (latestParamsRef.current.feedStale || latestParamsRef.current.connectionStatus !== 'connected') {
        setRunState('WAITING FOR CONFIRMATION');
        setAnalysisError(
          'Live Deriv feed is not delivering fresh ticks. Analysis is withheld until real data resumes.'
        );
        setReport(null);
        return;
      }

      if (curCandles.length < 26) {
        setRunState('WAITING FOR CONFIRMATION');
        setAnalysisError(
          `Awaiting at least 26 live ${curTf} candles from Deriv before running analysis.`
        );
        return;
      }

      const seq = ++runSeqRef.current;
      setIsAnalyzing(true);
      setAnalysisError(null);

      if (cacheSymbolRef.current !== curSymbol) {
        cacheRef.current = {};
        cacheSymbolRef.current = curSymbol;
      }

      try {
        const mtfCandles: MultiTimeframeCandles = {
          [curTf]: curCandles,
        };

        const now = Date.now();
        for (const tf of ALL_TIMEFRAMES) {
          if (tf === curTf) continue;
          const cached = cacheRef.current[tf];
          const tfTtl = Math.max(
            HTF_CACHE_TTL_MS,
            TIMEFRAME_MAP[tf].granularitySec * 1000 * 0.5
          );
          if (
            !forceRefreshHtf &&
            cached &&
            now - cached.fetchedAt < tfTtl &&
            cached.candles.length >= 25
          ) {
            mtfCandles[tf] = cached.candles;
            continue;
          }

          try {
            const fetched = await fetchCandlesSnapshot(curSymbol, tf, 180);
            if (runSeqRef.current !== seq) return;
            if (fetched.length > 0) {
              cacheRef.current[tf] = { fetchedAt: Date.now(), candles: fetched };
              mtfCandles[tf] = fetched;
            }
          } catch {
            if (cached?.candles) {
              mtfCandles[tf] = cached.candles;
            }
          }
        }

        if (runSeqRef.current !== seq) return;
        if (latestParamsRef.current.controlMode === 'idle') return;

        const effectiveSnapshot =
          snapshotRef.current &&
          snapshotRef.current.symbol === curSymbol &&
          snapshotRef.current.timeframe === curTf
            ? snapshotRef.current
            : null;

        const nextReport = runTopDownPriceActionAnalysis({
          symbol: curSymbol,
          marketName: curMarketName,
          marketFamily: curFamily,
          activeTimeframe: curTf,
          precision: curPrecision,
          multiTimeframeCandles: mtfCandles,
          previousSignal: activeSignalRef.current,
          snapshot: effectiveSnapshot,
        });

        activeSignalRef.current =
          nextReport.signalStatus === 'CONFIRMED' ? nextReport.overlays.signal : null;
        lastConfirmedTimeRef.current = nextReport.confirmedBarTime;

        setReport(nextReport);
        setRunState(nextReport.runState);
      } catch (err) {
        if (runSeqRef.current !== seq) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Unable to complete top-down price action analysis.';
        setAnalysisError(msg);
      } finally {
        if (runSeqRef.current === seq) {
          setIsAnalyzing(false);
        }
      }
    },
    [fetchCandlesSnapshot]
  );

  const startAnalysis = useCallback(() => {
    setControlMode('running');
    latestParamsRef.current.controlMode = 'running';
    setRunState('ANALYZING MARKET');
    setAnalysisError(null);
    activeSignalRef.current = null;
    void executeAnalysis(true);
  }, [executeAnalysis]);

  const pauseAnalysis = useCallback(() => {
    runSeqRef.current++;
    setIsAnalyzing(false);
    setControlMode('paused');
    latestParamsRef.current.controlMode = 'paused';
  }, []);

  const resumeAnalysis = useCallback(() => {
    setControlMode('running');
    latestParamsRef.current.controlMode = 'running';
    setRunState('ANALYZING MARKET');
    void executeAnalysis(false);
  }, [executeAnalysis]);

  const stopAnalysis = useCallback(() => {
    runSeqRef.current++;
    activeSignalRef.current = null;
    lastConfirmedTimeRef.current = 0;
    setIsAnalyzing(false);
    setAnalysisError(null);
    setControlMode('idle');
    latestParamsRef.current.controlMode = 'idle';
    setRunState('READY TO ANALYZE');
    setReport(null);
  }, []);

  // Reset analysis report cleanly when symbol or timeframe switches
  useEffect(() => {
    runSeqRef.current++;
    activeSignalRef.current = null;
    lastConfirmedTimeRef.current = 0;
    setReport(null);
    setAnalysisError(null);
    if (cacheSymbolRef.current !== symbol) {
      cacheRef.current = {};
      cacheSymbolRef.current = symbol;
    }
    const mode = latestParamsRef.current.controlMode;
    if (mode === 'running') {
      setRunState('ANALYZING MARKET');
    } else if (mode === 'idle') {
      setRunState('READY TO ANALYZE');
    }
  }, [symbol, activeTimeframe]);

  // Re-evaluate when the live candle set grows while running (analysis is duration-free).
  useEffect(() => {
    if (controlMode !== 'running') return;
    if (loadState !== 'ready' || candles.length < 26) return;
    void executeAnalysis(false);
  }, [controlMode, loadState, candles.length, executeAnalysis]);

  // Trigger initial/resumed analysis when chart candles become ready or a new confirmed bar closes
  useEffect(() => {
    if (controlMode !== 'running') return;
    if (loadState !== 'ready' || candles.length < 26) return;

    const latestConfirmedTime = candles[candles.length - 2].time;
    const needsFirstRun =
      !report ||
      report.symbol !== symbol ||
      report.timeframe !== activeTimeframe;
    const hasNewConfirmedClose = latestConfirmedTime > lastConfirmedTimeRef.current;

    if ((needsFirstRun || hasNewConfirmedClose) && !isAnalyzing) {
      void executeAnalysis(needsFirstRun);
    }
  }, [
    activeTimeframe,
    candles,
    controlMode,
    executeAnalysis,
    isAnalyzing,
    loadState,
    report,
    symbol,
  ]);

  // Continuously monitor live forming ticks to immediately invalidate broken setups
  useEffect(() => {
    if (controlMode !== 'running' || !liveTick || !activeSignalRef.current) return;
    const sig = activeSignalRef.current;
    if (sig.symbol !== symbol || sig.timeframe !== activeTimeframe) return;

    const livePrice = liveTick.candle.close;
    const invalidated =
      (sig.direction === 'RISE' &&
        (livePrice < sig.invalidationPrice || livePrice < sig.structuralLevelPrice)) ||
      (sig.direction === 'FALL' &&
        (livePrice > sig.invalidationPrice || livePrice > sig.structuralLevelPrice));

    if (invalidated && !isAnalyzing) {
      void executeAnalysis(false);
    }
  }, [activeTimeframe, controlMode, executeAnalysis, isAnalyzing, liveTick, symbol]);

  return {
    controlMode,
    runState,
    report,
    isAnalyzing,
    analysisError,
    startAnalysis,
    pauseAnalysis,
    resumeAnalysis,
    stopAnalysis,
  };
}
