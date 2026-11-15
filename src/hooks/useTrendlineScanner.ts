import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeTrendlineInstrument,
  selectStrongestTrendline,
  trendlineSignalStatus,
} from '../analysis/trendlineEngine';
import { TRENDLINE_PUBLICATION_MIN_SCORE } from '../analysis/trendlineModels';
import { TIMEFRAME_MAP } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { Candle, MarketFamily, SyntheticMarket, TimeframeKey } from '../types/market';
import type {
  TrendlineEntryModelId,
  TrendlineInstrumentAnalysis,
  TrendlineScanSummary,
  TrendlineSignal,
} from '../types/trendline';
import { TRENDLINE_MODEL_IDS } from '../types/trendline';
import { eligibleMarkets } from '../utils/eligibleMarkets';

/** Trendline structure is built on M15, the setup/rejection develops on M5, entries confirm on M1. */
export const TRENDLINE_STRUCTURE_TF: TimeframeKey = 'M15';
export const TRENDLINE_SETUP_TF: TimeframeKey = 'M5';
export const TRENDLINE_ENTRY_TF: TimeframeKey = 'M1';

export interface TrendlineScannerSettings {
  enabledModels: Record<TrendlineEntryModelId, boolean>;
  /** Minimum score gate (defaults to the shared 85 publication minimum). */
  minScore: number;
  directionPreference: 'RISE' | 'FALL' | 'BOTH';
  /** Timeframe shown on the chart (analysis still uses M15/M5/M1). */
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
}

/**
 * TRENDLINE SCANNER — a dedicated strategy module that runs independently of the
 * price-action engine. It reuses the shared live Deriv connection and candle feeds:
 * M15 drives structure/trendlines, M5 develops the rejection setup, and M1 confirms the
 * precise entry. It analyses EVERY available Volatility Index (standard + 1-second),
 * never just Volatility 75, and completely excludes Boom & Crash indices.
 */
export function useTrendlineScanner({ derivService, markets }: UseTrendlineScannerProps) {
  const [settings, setSettings] = useState<TrendlineScannerSettings>(DEFAULT_SETTINGS);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState(
    'Ready to scan Deriv indices for high-quality trendline setups (M15 structure, M5 setup, M1 entry).'
  );
  const [summary, setSummary] = useState<TrendlineScanSummary | null>(null);
  const [analyses, setAnalyses] = useState<TrendlineInstrumentAnalysis[]>([]);
  const [history, setHistory] = useState<TrendlineSignal[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);

  const scanAbortRef = useRef(false);
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
   * Runs the trendline engine for one instrument on M15 (structure), M5 (setup) and
   * M1 (precise entry). Shared by the breadth scan and the live single-instrument view.
   */
  const analyzeSymbol = useCallback(
    async (market: SyntheticMarket): Promise<TrendlineInstrumentAnalysis | null> => {
      const structureGranularity = TIMEFRAME_MAP[TRENDLINE_STRUCTURE_TF].granularitySec;
      const setupGranularity = TIMEFRAME_MAP[TRENDLINE_SETUP_TF].granularitySec;
      const entryGranularity = TIMEFRAME_MAP[TRENDLINE_ENTRY_TF].granularitySec;
      try {
        const [structureCandles, entryCandles, m1Candles] = await Promise.all([
          derivService.fetchHistoricalCandles(market.symbol, structureGranularity, 180),
          derivService.fetchHistoricalCandles(market.symbol, setupGranularity, 180),
          derivService.fetchHistoricalCandles(market.symbol, entryGranularity, 180),
        ]);
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
    if (isScanning) return;
    scanAbortRef.current = false;
    setIsScanning(true);
    setScanProgress(0);
    setProgressMessage('Scanning Deriv indices for trendline setups (M15 structure → M5 setup → M1 entry)…');

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
  }, [isScanning, targetMarkets, analyzeSymbol, applyFilters]);

  const cancelScan = useCallback(() => {
    scanAbortRef.current = true;
    setIsScanning(false);
    setProgressMessage('Trendline scan cancelled.');
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  // Auto-refresh: re-scan on an interval while enabled.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void scanMarkets();
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, scanMarkets]);

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
