import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeDsInstrument,
  dsSignalStatus,
  selectStrongestDs,
} from '../analysis/demandSupplyEngine';
import { DS_PUBLICATION_MIN_SCORE } from '../analysis/demandSupplyModels';
import { TIMEFRAME_MAP, AI_TIMEFRAME_KEYS } from '../config/deriv';
import { buildTopDownAnalysis } from '../analysis/topDownAnalysis';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { DsEntryModelId, DsInstrumentAnalysis, DsScanSummary, DsSignal } from '../types/demandSupply';
import { DS_MODEL_IDS } from '../types/demandSupply';
import type { Candle, ConnectionStatus, MarketFamily, SyntheticMarket, TimeframeKey } from '../types/market';
import { eligibleMarkets } from '../utils/eligibleMarkets';

/** Demand & Supply structure is always M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1. */
export const DS_STRUCTURE_TF: TimeframeKey = 'M15';
export const DS_TREND_TF: TimeframeKey = 'M7';
export const DS_SETUP_TF: TimeframeKey = 'M5';
export const DS_CONFIRM_TF: TimeframeKey = 'M3';
export const DS_ENTRY_TF: TimeframeKey = 'M1';

export interface DsScannerSettings {
  enabledModels: Record<DsEntryModelId, boolean>;
  minScore: number;
  directionPreference: 'RISE' | 'FALL' | 'BOTH';
  /** Timeframe shown on the chart (analysis still uses M30/M15/M10/M7/M6/M5/M4/M3/M2/M1). */
  chartTimeframe: TimeframeKey;
  /** Include the 1-second Volatility variants in the breadth scan. */
  include1Sec: boolean;
}

const DEFAULT_SETTINGS: DsScannerSettings = {
  enabledModels: DS_MODEL_IDS.reduce(
    (acc, id) => ({ ...acc, [id]: true }),
    {} as Record<DsEntryModelId, boolean>
  ),
  minScore: DS_PUBLICATION_MIN_SCORE,
  directionPreference: 'BOTH',
  chartTimeframe: DS_STRUCTURE_TF,
  include1Sec: true,
};

interface UseDemandSupplyScannerProps {
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
 * DEMAND & SUPPLY AI — a dedicated strategy module that runs independently of both the
 * price-action engine and the Trendline AI. It reuses the shared live Deriv connection:
 * M15 identifies zones, M7 reads the trend, M5 refines/develops the setup, M3 confirms the
 * entry setup, and M1 confirms the entry.
 *
 * EVERY eligible index (standard + 1-second Volatility, Jump, Step) is analysed, each on
 * its own feed. Boom/Crash and every other synthetic family are excluded structurally by
 * the canonical `eligibleMarkets` module, so they cannot enter the scan set.
 */
export function useDemandSupplyScanner({
  derivService,
  markets,
  connectionStatus = 'connected',
  autoStart = true,
  autoStartDelayMs = 0,
  autoRefreshMs = 180_000,
}: UseDemandSupplyScannerProps) {
  const [settings, setSettings] = useState<DsScannerSettings>(DEFAULT_SETTINGS);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState(
    'Ready to scan Deriv indices for demand & supply zones (M15 zones, M7 trend, M5 setup, M3 confirmation, M1 entry).'
  );
  const [summary, setSummary] = useState<DsScanSummary | null>(null);
  const [analyses, setAnalyses] = useState<DsInstrumentAnalysis[]>([]);
  const [history, setHistory] = useState<DsSignal[]>([]);
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

  const toggleModel = useCallback((model: DsEntryModelId) => {
    setSettings((prev) => ({
      ...prev,
      enabledModels: { ...prev.enabledModels, [model]: !prev.enabledModels[model] },
    }));
  }, []);

  const setAllModels = useCallback((enabled: boolean) => {
    setSettings((prev) => ({
      ...prev,
      enabledModels: DS_MODEL_IDS.reduce(
        (acc, id) => ({ ...acc, [id]: enabled }),
        {} as Record<DsEntryModelId, boolean>
      ),
    }));
  }, []);

  const setMinScore = useCallback((minScore: number) => {
    setSettings((prev) => ({ ...prev, minScore }));
  }, []);

  const setDirectionPreference = useCallback(
    (directionPreference: DsScannerSettings['directionPreference']) => {
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

  /** Runs the Demand & Supply engine for one instrument on M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1. */
  const analyzeSymbol = useCallback(
    async (market: SyntheticMarket): Promise<DsInstrumentAnalysis | null> => {
      const entryGranularity = TIMEFRAME_MAP[DS_ENTRY_TF].granularitySec;
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
        const structureCandles = candlesByTimeframe[DS_STRUCTURE_TF] ?? [];
        const trendCandles = candlesByTimeframe[DS_TREND_TF] ?? [];
        const setupCandles = candlesByTimeframe[DS_SETUP_TF] ?? [];
        const confirmCandles = candlesByTimeframe[DS_CONFIRM_TF] ?? [];
        const entryCandles = candlesByTimeframe[DS_ENTRY_TF] ?? [];
        const nowSec = Math.floor(Date.now() / 1000);
        let dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED' = 'HEALTHY';
        if (structureCandles.length === 0 || setupCandles.length === 0 || entryCandles.length === 0) {
          dataHealth = 'STALE';
        } else {
          const latest = entryCandles[entryCandles.length - 1];
          const maxAllowedAgeSec = Math.max(180, entryGranularity * 5);
          if (nowSec - latest.time > maxAllowedAgeSec) dataHealth = 'STALE';
        }

        const analysis = analyzeDsInstrument({
          symbol: market.symbol,
          displayName: market.displayName,
          precision: market.precision,
          marketFamily: market.family as MarketFamily,
          structureCandles,
          trendCandles,
          setupCandles,
          confirmCandles,
          entryCandles,
          candlesByTimeframe,
          dataHealth,
        });
        return { ...analysis, topDown: buildTopDownAnalysis(market.symbol, candlesByTimeframe) };
      } catch {
        return null;
      }
    },
    [derivService]
  );

  /** Applies the module's model/score/direction filters to a raw analysis. */
  const applyFilters = useCallback(
    (analysis: DsInstrumentAnalysis): DsInstrumentAnalysis => {
      const s = settingsRef.current;
      const candidate = analysis.bestCandidate;
      if (!candidate) return analysis;
      const modelEnabled = s.enabledModels[candidate.model];
      const scoreOk = candidate.score >= s.minScore;
      const dirOk =
        s.directionPreference === 'BOTH' || candidate.direction === s.directionPreference;
      if (modelEnabled && scoreOk && dirOk) return analysis;
      return {
        ...analysis,
        signal: null,
        rejectionReason: !modelEnabled
          ? `Model "${candidate.modelLabel}" is disabled in the demand & supply settings.`
          : !scoreOk
            ? `Best candidate scored ${candidate.score}/100 — below the ${s.minScore} gate.`
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
    setProgressMessage('Scanning Deriv indices for demand & supply zones (M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1)…');

    const results: DsInstrumentAnalysis[] = [];
    try {
      const total = targetMarkets.length;
      for (let i = 0; i < total; i++) {
        if (scanAbortRef.current) break;
        const market = targetMarkets[i];
        setProgressMessage(
          `Demand & Supply scan: ${market.displayName} [${market.family}] (${i + 1}/${total})…`
        );
        setScanProgress(Math.round(((i + 1) / total) * 100));
        const analysis = await analyzeSymbol(market);
        if (analysis) results.push(applyFilters(analysis));
      }

      const nextSummary = selectStrongestDs(results);
      setAnalyses(results);
      setSummary(nextSummary);
      setLastScannedAt(Date.now());
      setProgressMessage(nextSummary.statusBanner);

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
    setProgressMessage('Demand & Supply scan cancelled.');
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

  /** Live demand & supply read for the chart's currently selected instrument. */
  const analyzeLive = useCallback(
    async (symbol: string): Promise<DsInstrumentAnalysis | null> => {
      const market = markets.find((m) => m.symbol === symbol);
      if (!market) return null;
      const analysis = await analyzeSymbol(market);
      return analysis ? applyFilters(analysis) : null;
    },
    [markets, analyzeSymbol, applyFilters]
  );

  const refreshHistoryStatuses = useCallback(
    async (candlesBySymbol: Map<string, Candle[]>) => {
      setHistory((prev) =>
        prev.map((sig) => {
          const candles = candlesBySymbol.get(sig.symbol);
          if (!candles || candles.length === 0) return sig;
          const status = dsSignalStatus(sig, candles);
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
    structureTimeframe: DS_STRUCTURE_TF,
    setupTimeframe: DS_SETUP_TF,
    entryTimeframe: DS_ENTRY_TF,
  };
}

export type DemandSupplyScannerValue = ReturnType<typeof useDemandSupplyScanner>;
