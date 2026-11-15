import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiSignalStatus } from '../analysis/aiCommon';
import type { PeerEvidence } from '../analysis/peerValidation';
import { TIMEFRAME_MAP } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type {
  AiInstrumentAnalysis,
  AiScanSummary,
  AiSignal,
} from '../types/aiModule';
import type { Candle, MarketFamily, SyntheticMarket, TimeframeKey } from '../types/market';
import { eligibleMarkets } from '../utils/eligibleMarkets';

/** Every AI module analyses M15 structure → M5 setup → M1 entry. */
export const AI_STRUCTURE_TF: TimeframeKey = 'M15';
export const AI_SETUP_TF: TimeframeKey = 'M5';
export const AI_ENTRY_TF: TimeframeKey = 'M1';

export interface AiScannerSettings {
  chartTimeframe: TimeframeKey;
  include1Sec: boolean;
  minScore: number;
  directionPreference: 'RISE' | 'FALL' | 'BOTH';
}

export interface AiEngineParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  structureCandles: readonly Candle[];
  setupCandles: readonly Candle[];
  entryCandles: readonly Candle[];
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  /** Published signals from sibling modules for THIS index only (decision-engine modules). */
  peers?: readonly PeerEvidence[];
}

export type AiEngine = (params: AiEngineParams) => AiInstrumentAnalysis;

interface UseAiScannerProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
  /** The module's own independent engine — this hook never decides, it only orchestrates. */
  engine: AiEngine;
  /** Module publication gate (defaults to the score of a strong setup). */
  publicationGate: number;
  defaultMinScore: number;
  progressLabel: string;
  /** Optional peer-evidence provider for decision-engine modules (Confluence, Live Scanner). */
  getPeers?: (symbol: string) => PeerEvidence[];
}

function selectStrongest(analyses: readonly AiInstrumentAnalysis[]): AiScanSummary {
  const confirmed = analyses.filter((a) => a.signal !== null);
  const opportunities = confirmed
    .map((a) => a.signal as AiSignal)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.riskRewardRatio - a.riskRewardRatio;
    });
  const winner = opportunities[0] ?? null;
  const winnerAnalysis = winner
    ? confirmed.find((a) => a.signal?.id === winner.id) ?? null
    : null;
  const anyZones = analyses.some((a) => a.activeZones.length + a.watchZones.length > 0);
  return {
    winner,
    winnerAnalysis,
    opportunities,
    scannedCount: analyses.length,
    confirmedCount: confirmed.length,
    scannedAt: Date.now(),
    statusBanner: winner
      ? `${winner.displayName} ${winner.direction} · ${winner.modelLabel} (${winner.score}/100)`
      : anyZones
        ? `${analyses.length} indices analysed — structure tracked, no confirmed setup at the gate.`
        : `${analyses.length} indices analysed — no qualifying structure yet.`,
  };
}

/**
 * Shared orchestrator for the independent AI strategy modules. It fetches the M15/M5/M1
 * candles per instrument (EVERY Volatility Index, standard + 1-second, Boom/Crash excluded),
 * runs the module's OWN engine, applies the module's own filters and keeps the scan summary
 * + history. It contains no strategy logic — each module owns its decisions.
 */
export function useAiScanner({
  derivService,
  markets,
  engine,
  defaultMinScore,
  progressLabel,
  getPeers,
}: UseAiScannerProps) {
  const [settings, setSettings] = useState<AiScannerSettings>({
    chartTimeframe: AI_STRUCTURE_TF,
    include1Sec: true,
    minScore: defaultMinScore,
    directionPreference: 'BOTH',
  });
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState(
    `Ready to scan Deriv indices — ${progressLabel}.`
  );
  const [summary, setSummary] = useState<AiScanSummary | null>(null);
  const [analyses, setAnalyses] = useState<AiInstrumentAnalysis[]>([]);
  const [history, setHistory] = useState<AiSignal[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);

  const scanAbortRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const getPeersRef = useRef(getPeers);
  getPeersRef.current = getPeers;

  const setChartTimeframe = useCallback((chartTimeframe: TimeframeKey) => {
    setSettings((prev) => ({ ...prev, chartTimeframe }));
  }, []);
  const setInclude1Sec = useCallback((include1Sec: boolean) => {
    setSettings((prev) => ({ ...prev, include1Sec }));
  }, []);
  const setMinScore = useCallback((minScore: number) => {
    setSettings((prev) => ({ ...prev, minScore }));
  }, []);
  const setDirectionPreference = useCallback(
    (directionPreference: AiScannerSettings['directionPreference']) => {
      setSettings((prev) => ({ ...prev, directionPreference }));
    },
    []
  );

  // EVERY eligible market — every standard and 1-second Volatility Index Deriv publishes.
  // Boom/Crash and all other synthetic families are excluded structurally by `eligibleMarkets`.
  const targetMarkets = useMemo(
    () => eligibleMarkets(markets, { include1Sec: settings.include1Sec }),
    [markets, settings.include1Sec]
  );

  const analyzeSymbol = useCallback(
    async (market: SyntheticMarket): Promise<AiInstrumentAnalysis | null> => {
      const structureGranularity = TIMEFRAME_MAP[AI_STRUCTURE_TF].granularitySec;
      const setupGranularity = TIMEFRAME_MAP[AI_SETUP_TF].granularitySec;
      const entryGranularity = TIMEFRAME_MAP[AI_ENTRY_TF].granularitySec;
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
        return engine({
          symbol: market.symbol,
          displayName: market.displayName,
          precision: market.precision,
          marketFamily: market.family as MarketFamily,
          structureCandles,
          setupCandles,
          entryCandles,
          dataHealth,
          peers: getPeersRef.current?.(market.symbol) ?? [],
        });
      } catch {
        return null;
      }
    },
    [derivService, engine]
  );

  const applyFilters = useCallback((analysis: AiInstrumentAnalysis): AiInstrumentAnalysis => {
    const s = settingsRef.current;
    const signal = analysis.signal;
    if (!signal) return analysis;
    const scoreOk = signal.score >= s.minScore;
    const dirOk = s.directionPreference === 'BOTH' || signal.direction === s.directionPreference;
    if (scoreOk && dirOk) return analysis;
    return {
      ...analysis,
      signal: null,
      rejectionReason: !scoreOk
        ? `Best setup scored ${signal.score}/100 — below the ${s.minScore} gate.`
        : `Direction filter excludes ${signal.direction} setups.`,
    };
  }, []);

  const scanMarkets = useCallback(async () => {
    if (isScanning) return;
    scanAbortRef.current = false;
    setIsScanning(true);
    setScanProgress(0);
    setProgressMessage(`Scanning Deriv indices — ${progressLabel}…`);

    const results: AiInstrumentAnalysis[] = [];
    try {
      const total = targetMarkets.length;
      for (let i = 0; i < total; i++) {
        if (scanAbortRef.current) break;
        const market = targetMarkets[i];
        setProgressMessage(`${progressLabel}: ${market.displayName} (${i + 1}/${total})…`);
        setScanProgress(Math.round(((i + 1) / total) * 100));
        const analysis = await analyzeSymbol(market);
        if (analysis) results.push(applyFilters(analysis));
      }

      const nextSummary = selectStrongest(results);
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
  }, [isScanning, targetMarkets, analyzeSymbol, applyFilters, progressLabel]);

  const cancelScan = useCallback(() => {
    scanAbortRef.current = true;
    setIsScanning(false);
    setProgressMessage('Scan cancelled.');
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void scanMarkets();
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, scanMarkets]);

  /** Live read for the chart's currently selected instrument. */
  const analyzeLive = useCallback(
    async (symbol: string): Promise<AiInstrumentAnalysis | null> => {
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
          const status = aiSignalStatus(sig, candles);
          return status === sig.lifecycle ? sig : { ...sig, lifecycle: status, lastUpdated: Date.now() };
        })
      );
    },
    []
  );

  return {
    settings,
    setChartTimeframe,
    setInclude1Sec,
    setMinScore,
    setDirectionPreference,
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
    structureTimeframe: AI_STRUCTURE_TF,
    setupTimeframe: AI_SETUP_TF,
    entryTimeframe: AI_ENTRY_TF,
  };
}

export type AiScannerValue = ReturnType<typeof useAiScanner>;
