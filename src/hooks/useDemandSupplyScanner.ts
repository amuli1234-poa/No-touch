import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeDsInstrument,
  dsSignalStatus,
  selectStrongestDs,
} from '../analysis/demandSupplyEngine';
import { DS_PUBLICATION_MIN_SCORE } from '../analysis/demandSupplyModels';
import { TIMEFRAME_MAP } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { DsEntryModelId, DsInstrumentAnalysis, DsScanSummary, DsSignal } from '../types/demandSupply';
import { DS_MODEL_IDS } from '../types/demandSupply';
import type { Candle, MarketFamily, SyntheticMarket, TimeframeKey } from '../types/market';
import { eligibleMarkets } from '../utils/eligibleMarkets';

/** Demand & Supply structure is always M15 → M5 → M1. */
export const DS_STRUCTURE_TF: TimeframeKey = 'M15';
export const DS_SETUP_TF: TimeframeKey = 'M5';
export const DS_ENTRY_TF: TimeframeKey = 'M1';

export interface DsScannerSettings {
  enabledModels: Record<DsEntryModelId, boolean>;
  minScore: number;
  directionPreference: 'RISE' | 'FALL' | 'BOTH';
  /** Timeframe shown on the chart (analysis still uses M15/M5/M1). */
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
}

/**
 * DEMAND & SUPPLY AI — a dedicated strategy module that runs independently of both the
 * price-action engine and the Trendline AI. It reuses the shared live Deriv connection:
 * M15 identifies zones, M5 refines/develops the setup, M1 confirms the entry.
 *
 * EVERY eligible Volatility Index (standard + 1-second) is analysed, each on its own feed.
 * Boom/Crash and every other synthetic family are excluded structurally by the canonical
 * `eligibleMarkets` module, so they cannot enter the scan set.
 */
export function useDemandSupplyScanner({ derivService, markets }: UseDemandSupplyScannerProps) {
  const [settings, setSettings] = useState<DsScannerSettings>(DEFAULT_SETTINGS);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState(
    'Ready to scan Deriv indices for demand & supply zones (M15 zones, M5 setup, M1 confirmation).'
  );
  const [summary, setSummary] = useState<DsScanSummary | null>(null);
  const [analyses, setAnalyses] = useState<DsInstrumentAnalysis[]>([]);
  const [history, setHistory] = useState<DsSignal[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);

  const scanAbortRef = useRef(false);
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

  /** Runs the Demand & Supply engine for one instrument on M15 → M5 → M1. */
  const analyzeSymbol = useCallback(
    async (market: SyntheticMarket): Promise<DsInstrumentAnalysis | null> => {
      const structureGranularity = TIMEFRAME_MAP[DS_STRUCTURE_TF].granularitySec;
      const setupGranularity = TIMEFRAME_MAP[DS_SETUP_TF].granularitySec;
      const entryGranularity = TIMEFRAME_MAP[DS_ENTRY_TF].granularitySec;
      try {
        const [structureCandles, setupCandles, entryCandles] = await Promise.all([
          derivService.fetchHistoricalCandles(market.symbol, structureGranularity, 180),
          derivService.fetchHistoricalCandles(market.symbol, setupGranularity, 180),
          derivService.fetchHistoricalCandles(market.symbol, entryGranularity, 180),
        ]);
        const nowSec = Math.floor(Date.now() / 1000);
        let dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED' = 'HEALTHY';
        if (structureCandles.length === 0 || setupCandles.length === 0 || entryCandles.length === 0) {
          dataHealth = 'STALE';
        } else {
          const latest = entryCandles[entryCandles.length - 1];
          const maxAllowedAgeSec = Math.max(180, entryGranularity * 5);
          if (nowSec - latest.time > maxAllowedAgeSec) dataHealth = 'STALE';
        }

        return analyzeDsInstrument({
          symbol: market.symbol,
          displayName: market.displayName,
          precision: market.precision,
          marketFamily: market.family as MarketFamily,
          structureCandles,
          setupCandles,
          entryCandles,
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
    if (isScanning) return;
    scanAbortRef.current = false;
    setIsScanning(true);
    setScanProgress(0);
    setProgressMessage('Scanning Deriv indices for demand & supply zones (M15 → M5 → M1)…');

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
  }, [isScanning, targetMarkets, analyzeSymbol, applyFilters]);

  const cancelScan = useCallback(() => {
    scanAbortRef.current = true;
    setIsScanning(false);
    setProgressMessage('Demand & Supply scan cancelled.');
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void scanMarkets();
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, scanMarkets]);

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
