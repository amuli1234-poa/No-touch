import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeTrendlineInstrument,
  selectStrongestTrendline,
  trendlineSignalStatus,
} from '../analysis/trendlineEngine';
import { TRENDLINE_PUBLICATION_MIN_SCORE } from '../analysis/trendlineModels';
import { TIMEFRAME_MAP, AI_TIMEFRAME_KEYS } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { Candle, ConnectionStatus, MarketFamily, SyntheticMarket, TimeframeKey } from '../types/market';
import type {
  TrendlineEntryModelId,
  TrendlineInstrumentAnalysis,
  TrendlineScanSummary,
  TrendlineSignal,
} from '../types/trendline';
import { TRENDLINE_MODEL_IDS } from '../types/trendline';
import { eligibleMarkets } from '../utils/eligibleMarkets';

/** Trendline structure is built on M15, trend & market structure on M7, the setup/rejection develops on M5, the entry setup confirms on M3 and entries confirm on M1. */
export const TRENDLINE_STRUCTURE_TF: TimeframeKey = 'M15';
/** M7 trend & market-structure confirmation (derived from M1). */
export const TRENDLINE_TREND_TF: TimeframeKey = 'M7';
export const TRENDLINE_SETUP_TF: TimeframeKey = 'M5';
/** M3 entry-setup confirmation (native on Deriv). */
export const TRENDLINE_CONFIRM_TF: TimeframeKey = 'M3';
export const TRENDLINE_ENTRY_TF: TimeframeKey = 'M1';

export interface TrendlineScannerSettings {
  enabledModels: Record<TrendlineEntryModelId, boolean>;
  /** Minimum score gate (defaults to the shared 85 publication minimum). */
  minScore: number;
  directionPreference: 'RISE' | 'FALL' | 'BOTH';
  /** Timeframe shown on the chart (analysis still uses M30/M15/M10/M7/M6/M5/M4/M3/M2/M1). */
  chartTimeframe: TimeframeKey;
  /** Include the 1-second Volatility variants in the breadth scan. */
  include1Sec: boolean;
}

const DEFAULT_SETTINGS: TrendlineScannerSettings = {
  enabledModels: {
    TRENDLINE_REJECTION: true,
    TRENDLINE_BREAKOUT: true,
    TRENDLINE_BREAKOUT_RETEST: true,
    TRENDLINE_LIQUIDITY_SWEEP_RECLAIM: true,
  },
  minScore: TRENDLINE_PUBLICATION_MIN_SCORE,
  directionPreference: 'BOTH',
  chartTimeframe: TRENDLINE_STRUCTURE_TF,
  include1Sec: true,
};

interface UseTrendlineScannerProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
  /** Live connection status — gates the automatic background sweep. */
  connectionStatus?: ConnectionStatus;
  /** When false the module never auto-scans (default: true). */
  autoStart?: boolean;
  /** Delay before the first automatic pass (staggering). */
  autoStartDelayMs?: number;
  /** Continuous background re-scan interval (default 180s). */
  autoRefreshMs?: number;
}

/**
 * TRENDLINE SCANNER — a dedicated strategy module that runs independently of the
 * price-action engine. It reuses the shared live Deriv connection and candle feeds:
 * M15 drives structure/trendlines, M7 reads trend & market structure, M5 develops the
 * rejection setup, M3 confirms the entry setup, and M1 confirms the precise entry. It
 * analyses EVERY eligible index (standard + 1-second Volatility, Jump,
 * Step), never just Volatility 75, and completely excludes Boom & Crash indices.
 */
export function useTrendlineScanner({
  derivService,
  markets,
  connectionStatus = 'connected',
  autoStart = true,
  autoStartDelayMs = 0,
  autoRefreshMs = 180_000,
}: UseTrendlineScannerProps) {
  const [settings, setSettings] = useState<TrendlineScannerSettings>(DEFAULT_SETTINGS);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState(
    'Ready to scan Deriv indices for high-quality trendline setups (M15 structure, M7 trend, M5 setup, M3 confirmation, M1 entry).'
  );
  const [summary, setSummary] = useState<TrendlineScanSummary | null>(null);
  const [analyses, setAnalyses] = useState<TrendlineInstrumentAnalysis[]>([]);
  const [history, setHistory] = useState<TrendlineSignal[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);

  const scanAbortRef = useRef(false);
  const autoStartedRef = useRef(false);
  const isScanningRef = useRef(isScanning);
  isScanningRef.current = isScanning;
  const marketsRef = useRef(markets);
  marketsRef.current = markets;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const toggleModel = useCallback((model: TrendlineEntryModelId) => {
    setSettings((prev) => ({
      ...prev,
      enabledModels: { ...prev.enabledModels, [model]: !prev.enabledModels[model] },
    }));
  }, []);

  const setAllModels = useCallback((enabled: boolean) => {
    setSettings((prev) => ({
      ...prev,
      enabledModels: TRENDLINE_MODEL_IDS.reduce(
        (acc, id) => ({ ...acc, [id]: enabled }),
        {} as Record<TrendlineEntryModelId, boolean>
      ),
    }));
  }, []);

  const setMinScore = useCallback((minScore: number) => {
    setSettings((prev) => ({ ...prev, minScore }));
  }, []);

  const setDirectionPreference = useCallback(
    (directionPreference: TrendlineScannerSettings['directionPreference']) => {
      setSettings((prev) => ({ ...prev, directionPreference }));
    },
    []
  );

  const setChartTimeframe = useCallback((chartTimeframe: TimeframeKey) => {
    setSettings((prev) => ({ ...prev, chartTimeframe }));
  }, []);

  const setInclude1Sec = useCallback((include1Sec: boolean) => {
    setSettings((prev) => ({ ...prev, include1Sec }));
  }, []);

  const resetSettings = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  // EVERY eligible Volatility Index (standard + 1-second) is scanned. Boom/Crash and every
  // other synthetic family are excluded structurally by the canonical `eligibleMarkets`.
  const targetMarkets = useMemo(
    () => eligibleMarkets(markets, { include1Sec: settings.include1Sec }),
    [markets, settings.include1Sec]
  );

  /**
   * Runs the trendline engine for one instrument on M15 (structure), M7 (trend & structure),
   * M5 (setup), M3 (confirmation) and M1 (precise entry). Shared by the breadth scan and the
   * live single-instrument view.
   */
  const analyzeSymbol = useCallback(
    async (market: SyntheticMarket): Promise<TrendlineInstrumentAnalysis | null> => {
      const entryGranularity = TIMEFRAME_MAP[TRENDLINE_ENTRY_TF].granularitySec;
      try {
        // EVERY AI module independently analyses this index across ALL TEN timeframes.
        const series = await Promise.all(
          AI_TIMEFRAME_KEYS.map((tf) =>
            derivService
              .fetchHistoricalCandles(market.symbol, TIMEFRAME_MAP[tf].granularitySec, 180)
              .catch(() => [] as Candle[])
          )
        );
        const candlesByTimeframe: Partial<Record<TimeframeKey, readonly Candle[]>> = {};
        AI_TIMEFRAME_KEYS.forEach((tf, i) => {
          candlesByTimeframe[tf] = series[i];
        });
        const structureCandles = candlesByTimeframe[TRENDLINE_STRUCTURE_TF] ?? [];
        const trendCandles = candlesByTimeframe[TRENDLINE_TREND_TF] ?? [];
        const entryCandles = candlesByTimeframe[TRENDLINE_SETUP_TF] ?? [];
        const confirmCandles = candlesByTimeframe[TRENDLINE_CONFIRM_TF] ?? [];
        const m1Candles = candlesByTimeframe[TRENDLINE_ENTRY_TF] ?? [];
        const nowSec = Math.floor(Date.now() / 1000);
        let dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED' = 'HEALTHY';
        if (structureCandles.length === 0 || entryCandles.length === 0) {
          dataHealth = 'STALE';
        } else {
          const latest = entryCandles[entryCandles.length - 1];
          const maxAllowedAgeSec = Math.max(180, entryGranularity * 5);
          if (nowSec - latest.time > maxAllowedAgeSec) dataHealth = 'STALE';
        }

        return analyzeTrendlineInstrument({
          symbol: market.symbol,
          displayName: market.displayName,
          precision: market.precision,
          marketFamily: market.family as MarketFamily,
          structureCandles,
          entryCandles,
          m1Candles,
          trendCandles,
          confirmCandles,
          candlesByTimeframe,
          dataHealth,
        });
      } catch {
        return null;
      }
    },
    [derivService]
  );

  /** Applies the module's model/score/direction filters to a raw analysis. */
  const applyFilters = useCallback(
    (analysis: TrendlineInstrumentAnalysis): TrendlineInstrumentAnalysis => {
      const s = settingsRef.current;
      const candidate = analysis.bestCandidate;
      if (!candidate) return analysis;
      const modelEnabled = s.enabledModels[candidate.model];
      const scoreOk = candidate.scores.total >= s.minScore;
      const dirOk =
        s.directionPreference === 'BOTH' || candidate.direction === s.directionPreference;
      if (modelEnabled && scoreOk && dirOk) return analysis;
      return {
        ...analysis,
        signal: null,
        rejectionReason: !modelEnabled
          ? `Model "${candidate.modelLabel}" is disabled in the trendline scanner settings.`
          : !scoreOk
            ? `Best candidate scored ${candidate.scores.total}/100 — below the ${s.minScore} gate.`
            : `Direction filter excludes ${candidate.direction} setups.`,
      };
    },
    []
  );

  const scanMarkets = useCallback(async () => {
    if (isScanningRef.current) return;
    scanAbortRef.current = false;
    setIsScanning(true);
    setScanProgress(0);
    setProgressMessage('Scanning Deriv indices for trendline setups (M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1)…');

    const results: TrendlineInstrumentAnalysis[] = [];
    try {
      const total = targetMarkets.length;
      for (let i = 0; i < total; i++) {
        if (scanAbortRef.current) break;
        const market = targetMarkets[i];
        setProgressMessage(
          `Trendline scan: ${market.displayName} [${market.family}] (${i + 1}/${total})…`
        );
        setScanProgress(Math.round(((i + 1) / total) * 100));
        const analysis = await analyzeSymbol(market);
        if (analysis) results.push(applyFilters(analysis));
      }

      const nextSummary = selectStrongestTrendline(results);
      setAnalyses(results);
      setSummary(nextSummary);
      setLastScannedAt(Date.now());
      setProgressMessage(nextSummary.statusBanner);

      // Record every newly confirmed opportunity into the module's history ledger.
      if (nextSummary.opportunities.length > 0) {
        setHistory((prev) => {
          const seen = new Set(prev.map((s) => s.id));
          const fresh = nextSummary.opportunities.filter((s) => !seen.has(s.id));
          return fresh.length > 0 ? [...fresh, ...prev].slice(0, 200) : prev;
        });
      }
    } finally {
      setIsScanning(false);
      setScanProgress(0);
    }
  }, [targetMarkets, analyzeSymbol, applyFilters]);

  const cancelScan = useCallback(() => {
    scanAbortRef.current = true;
    setIsScanning(false);
    setProgressMessage('Trendline scan cancelled.');
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  // AUTOMATIC BACKGROUND SWEEP — one staggered pass once ready, then continuous re-scans.
  useEffect(() => {
    if (!autoStart) return;
    if (connectionStatus !== 'connected') return;
    if (markets.length === 0) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    const timer = setTimeout(() => {
      if (!isScanningRef.current && marketsRef.current.length > 0) void scanMarkets();
    }, autoStartDelayMs);
    return () => clearTimeout(timer);
  }, [autoStart, connectionStatus, markets.length, autoStartDelayMs, scanMarkets]);

  useEffect(() => {
    if (!autoStart || !autoRefresh) return;
    if (connectionStatus !== 'connected') return;
    const id = setInterval(() => {
      if (!isScanningRef.current && marketsRef.current.length > 0) void scanMarkets();
    }, autoRefreshMs);
    return () => clearInterval(id);
  }, [autoStart, autoRefresh, connectionStatus, autoRefreshMs, scanMarkets]);

  /**
   * Live trendline read for the currently selected chart instrument (re-runs when the
   * symbol changes so the chart can render its active trendlines).
   */
  const analyzeLive = useCallback(
    async (symbol: string): Promise<TrendlineInstrumentAnalysis | null> => {
      const market = markets.find((m) => m.symbol === symbol);
      if (!market) return null;
      const analysis = await analyzeSymbol(market);
      return analysis ? applyFilters(analysis) : null;
    },
    [markets, analyzeSymbol, applyFilters]
  );

  /** Recomputes statuses of tracked signals from fresh candles (invalidation/completion). */
  const refreshHistoryStatuses = useCallback(
    async (candlesBySymbol: Map<string, Candle[]>) => {
      setHistory((prev) =>
        prev.map((sig) => {
          const candles = candlesBySymbol.get(sig.symbol);
          if (!candles || candles.length === 0) return sig;
          const status = trendlineSignalStatus(sig, candles);
          return status === sig.status ? sig : { ...sig, status, lastUpdated: Date.now() };
        })
      );
    },
    []
  );

  return {
    settings,
    toggleModel,
    setAllModels,
    setMinScore,
    setDirectionPreference,
    setChartTimeframe,
    setInclude1Sec,
    resetSettings,
    isScanning,
    scanProgress,
    progressMessage,
    summary,
    analyses,
    history,
    autoRefresh,
    setAutoRefresh,
    lastScannedAt,
    /** True once this module has completed at least one pass (even a zero-result one). */
    hasRun: lastScannedAt !== null,
    scanMarkets,
    cancelScan,
    clearHistory,
    analyzeLive,
    refreshHistoryStatuses,
    targetMarketCount: targetMarkets.length,
    structureTimeframe: TRENDLINE_STRUCTURE_TF,
    setupTimeframe: TRENDLINE_SETUP_TF,
    entryTimeframe: TRENDLINE_ENTRY_TF,
  };
}

export type TrendlineScannerValue = ReturnType<typeof useTrendlineScanner>;
