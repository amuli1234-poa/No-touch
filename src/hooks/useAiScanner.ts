import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiSignalStatus } from '../analysis/aiCommon';
import { buildTopDownAnalysis } from '../analysis/topDownAnalysis';
import type { PeerEvidence } from '../analysis/peerValidation';
import { TIMEFRAME_MAP, AI_TIMEFRAME_KEYS } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type {
  AiInstrumentAnalysis,
  AiScanSummary,
  AiSignal,
} from '../types/aiModule';
import type { Candle, ConnectionStatus, MarketFamily, SyntheticMarket, TimeframeKey } from '../types/market';
import type { IndexLearningPlan } from '../types/learning';
import { eligibleMarkets } from '../utils/eligibleMarkets';

/**
 * The named roles of the ten-timeframe ladder. Every AI module keeps its own strategy rules
 * but reads ALL TEN timeframes: M30/M15 (major trend & bias) → M10/M7/M6 (intermediate
 * structure) → M5 (mandatory setup + entry confirmation) → M4/M3/M2/M1 (refinement).
 */
export const AI_STRUCTURE_TF: TimeframeKey = 'M15';
export const AI_TREND_TF: TimeframeKey = 'M7';
export const AI_SETUP_TF: TimeframeKey = 'M5';
export const AI_CONFIRM_TF: TimeframeKey = 'M3';
export const AI_ENTRY_TF: TimeframeKey = 'M1';

/** The ten analysis timeframes every AI module reads, in top-down order. */
export const AI_ANALYSIS_TIMEFRAMES: readonly TimeframeKey[] = AI_TIMEFRAME_KEYS;

/** Native candles fetched per timeframe for every AI module (the derived ones expand from source). */
const AI_TF_CANDLE_COUNT = 180;

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
  /**
   * M7 candles (trend & market-structure confirmation). Optional so every existing engine
   * and test keeps working; engines that read it treat a missing series as "no read".
   */
  trendCandles?: readonly Candle[];
  /** M3 candles (entry-setup confirmation). Optional for the same reason. */
  confirmCandles?: readonly Candle[];
  /**
   * ALL TEN analysis timeframes for THIS index (M30/M15/M10/M7/M6/M5/M4/M3/M2/M1). Optional
   * so every existing engine and test keeps working; an engine that reads the full ladder
   * treats a missing series as "not enough data" and never invents one.
   */
  candlesByTimeframe?: Partial<Record<TimeframeKey, readonly Candle[]>>;
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  /** Published signals from sibling modules for THIS index only (decision-engine modules). */
  peers?: readonly PeerEvidence[];
  /**
   * The Learning AI's learned timeframe plan for this index (null when unlearned). Advisory
   * evidence the Timeframe Alignment AI reads to select the most suitable strategy and
   * timeframe from verified historical performance. Optional so every existing engine and
   * test keeps working.
   */
  learnerPlan?: IndexLearningPlan | null;
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
  /**
   * Optional learner-plan provider for modules that consume the Timeframe Learner's
   * verified per-index strategy/timeframe recommendation (Timeframe Alignment AI).
   */
  getLearnerPlan?: (symbol: string) => IndexLearningPlan | null;
  /** Live connection status — the automatic background sweep only runs while connected. */
  connectionStatus?: ConnectionStatus;
  /** When false the module never auto-scans (default: true). */
  autoStart?: boolean;
  /** Delay before this module's first automatic pass, to stagger sibling modules. */
  autoStartDelayMs?: number;
  /** Continuous background re-scan interval (default 150s). */
  autoRefreshMs?: number;
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
 * Shared orchestrator for the independent AI strategy modules. It fetches the M30/M15/M10/M7/M6/M5/M4/M3/M2/M1
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
  getLearnerPlan,
  connectionStatus = 'connected',
  autoStart = true,
  autoStartDelayMs = 0,
  autoRefreshMs = 150_000,
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
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [lastScanError, setLastScanError] = useState<string | null>(null);

  const scanAbortRef = useRef(false);
  const autoStartedRef = useRef(false);
  const isScanningRef = useRef(isScanning);
  isScanningRef.current = isScanning;
  const marketsRef = useRef(markets);
  marketsRef.current = markets;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const getPeersRef = useRef(getPeers);
  getPeersRef.current = getPeers;
  const getLearnerPlanRef = useRef(getLearnerPlan);
  getLearnerPlanRef.current = getLearnerPlan;

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
      const entryGranularity = TIMEFRAME_MAP[AI_ENTRY_TF].granularitySec;
      try {
        // EVERY AI module independently analyses this index across ALL TEN timeframes.
        const series = await Promise.all(
          AI_TIMEFRAME_KEYS.map((tf) =>
            derivService
              .fetchHistoricalCandles(market.symbol, TIMEFRAME_MAP[tf].granularitySec, AI_TF_CANDLE_COUNT)
              .catch(() => [] as Candle[])
          )
        );
        const candlesByTimeframe: Partial<Record<TimeframeKey, readonly Candle[]>> = {};
        AI_TIMEFRAME_KEYS.forEach((tf, i) => {
          candlesByTimeframe[tf] = series[i];
        });
        const structureCandles = candlesByTimeframe[AI_STRUCTURE_TF] ?? [];
        const trendCandles = candlesByTimeframe[AI_TREND_TF] ?? [];
        const setupCandles = candlesByTimeframe[AI_SETUP_TF] ?? [];
        const confirmCandles = candlesByTimeframe[AI_CONFIRM_TF] ?? [];
        const entryCandles = candlesByTimeframe[AI_ENTRY_TF] ?? [];
        const nowSec = Math.floor(Date.now() / 1000);
        let dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED' = 'HEALTHY';
        if (structureCandles.length === 0 || setupCandles.length === 0 || entryCandles.length === 0) {
          dataHealth = 'STALE';
        } else {
          const latest = entryCandles[entryCandles.length - 1];
          const maxAllowedAgeSec = Math.max(180, entryGranularity * 5);
          if (nowSec - latest.time > maxAllowedAgeSec) dataHealth = 'STALE';
        }
        const analysis = engine({
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
          peers: getPeersRef.current?.(market.symbol) ?? [],
          learnerPlan: getLearnerPlanRef.current?.(market.symbol) ?? null,
        });
        // Attach the top-down ten-timeframe ladder read computed from the SAME candles the
        // module analysed. The module's own decisions are untouched — this only adds the
        // shared ladder so every AI view surfaces the identical top-down picture.
        return { ...analysis, topDown: buildTopDownAnalysis(market.symbol, candlesByTimeframe) };
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
    if (isScanningRef.current) return;
    scanAbortRef.current = false;
    setIsScanning(true);
    setScanProgress(0);
    setProgressMessage(`Scanning Deriv indices — ${progressLabel}…`);

    const results: AiInstrumentAnalysis[] = [];
    let failures = 0;
    try {
      const total = targetMarkets.length;
      for (let i = 0; i < total; i++) {
        if (scanAbortRef.current) break;
        const market = targetMarkets[i];
        setProgressMessage(`${progressLabel}: ${market.displayName} (${i + 1}/${total})…`);
        setScanProgress(Math.round(((i + 1) / total) * 100));
        const analysis = await analyzeSymbol(market);
        if (analysis) results.push(applyFilters(analysis));
        else failures += 1;
      }

      const nextSummary = selectStrongest(results);
      setAnalyses(results);
      setSummary(nextSummary);
      setLastScannedAt(Date.now());
      setLastScanError(
        results.length === 0
          ? `No instrument could be analysed (${failures}/${total} data fetches failed).`
          : null
      );
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
  }, [targetMarkets, analyzeSymbol, applyFilters, progressLabel]);

  const cancelScan = useCallback(() => {
    scanAbortRef.current = true;
    setIsScanning(false);
    setProgressMessage('Scan cancelled.');
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  // AUTOMATIC BACKGROUND SWEEP — one staggered pass once markets + connection are ready,
  // then continuous re-scans. Completing or invalidating a setup never stops this loop.
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
    lastScanError,
    /** True once this module has completed at least one pass (even a zero-result one). */
    hasRun: lastScannedAt !== null,
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
