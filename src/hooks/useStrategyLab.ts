import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TIMEFRAMES, TIMEFRAME_MAP } from '../config/deriv';
import {
  analyzeMarketAnomaly,
  type AnomalyReport,
  type RegimeKind,
} from '../analysis/marketAnomaly';
import {
  buildRecommendations,
  DEFAULT_COST_MODEL,
  evaluateStrategies,
  walkForwardValidate,
  type OptimizationReport,
  type StrategyEvaluation,
  type WalkForwardResult,
} from '../analysis/strategyOptimizer';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { EntryModelId } from '../types/engine';
import { ENTRY_MODEL_IDS, ENTRY_MODEL_LABELS } from '../types/engine';
import type { Candle, SyntheticMarket, TimeframeKey } from '../types/market';
import { isVolatilityIndex } from '../utils/volatilityMarkets';

const STORAGE_KEY = 'lucky_strategy_lab_v1';
const MONITOR_BAR_COUNT = 300;
/** Upper bound only to keep a pass finite — every eligible Volatility Index fits. */
const MAX_MONITORED = 64;

export type AnomalySensitivity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RegimeChangeEvent {
  symbol: string;
  displayName: string;
  from: RegimeKind;
  to: RegimeKind;
  at: number;
}

export interface StrategyLabProgress {
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'CANCELLED';
  completed: number;
  total: number;
  currentLabel: string;
  message: string;
}

export interface StrategyLabSelection {
  symbols: string[];
  timeframes: TimeframeKey[];
  models: EntryModelId[];
  historyBars: number;
}

export interface StrategyLabValue {
  report: OptimizationReport | null;
  walkForward: WalkForwardResult[];
  progress: StrategyLabProgress;
  progressPercent: number;
  selection: StrategyLabSelection;
  allTimeframes: typeof TIMEFRAMES;
  allModels: { id: EntryModelId; label: string }[];
  historyOptions: number[];
  /** Live anomaly intelligence per monitored index. */
  anomalyReports: AnomalyReport[];
  regimeChanges: RegimeChangeEvent[];
  monitoring: boolean;
  sensitivity: AnomalySensitivity;
  lastMonitoredAt: number | null;
  setHistoryBars: (bars: number) => void;
  toggleSymbol: (symbol: string) => void;
  toggleModel: (model: EntryModelId) => void;
  setTimeframes: (tfs: TimeframeKey[]) => void;
  setSensitivity: (s: AnomalySensitivity) => void;
  startBacktest: () => Promise<void>;
  stopBacktest: () => void;
  runValidation: () => Promise<void>;
  startMonitoring: () => void;
  pauseMonitoring: () => void;
  clearResults: () => void;
  exportResults: () => string;
}

interface UseStrategyLabProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
}

interface PersistedLab {
  report: OptimizationReport | null;
  walkForward: WalkForwardResult[];
  selection: StrategyLabSelection;
}

function loadPersisted(): PersistedLab | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedLab;
  } catch {
    return null;
  }
}

const DEFAULT_SELECTION: StrategyLabSelection = {
  symbols: [],
  timeframes: ['M5'],
  models: [...ENTRY_MODEL_IDS],
  historyBars: 1200,
};

/**
 * AI STRATEGY OPTIMIZATION & MARKET INTELLIGENCE — orchestration hook.
 *
 * Engine 1 replays REAL Deriv history through the existing no-look-ahead backtester and
 * extends it with walk-forward validation + rankings. Engine 2 continuously reads the live
 * candles for anomalies and regime changes. The hook never fabricates data, never modifies an
 * AI module and never guarantees an outcome — it only reports verified measurements.
 */
export function useStrategyLab({ derivService, markets }: UseStrategyLabProps): StrategyLabValue {
  const persisted = useMemo(() => loadPersisted(), []);
  const [report, setReport] = useState<OptimizationReport | null>(persisted?.report ?? null);
  const [walkForward, setWalkForward] = useState<WalkForwardResult[]>(persisted?.walkForward ?? []);
  const [selection, setSelection] = useState<StrategyLabSelection>(
    persisted?.selection ?? DEFAULT_SELECTION
  );
  const [progress, setProgress] = useState<StrategyLabProgress>({
    status: 'IDLE',
    completed: 0,
    total: 0,
    currentLabel: '',
    message: 'Idle. Choose indices, timeframes and models, then start the backtest.',
  });
  const [anomalyReports, setAnomalyReports] = useState<AnomalyReport[]>([]);
  const [regimeChanges, setRegimeChanges] = useState<RegimeChangeEvent[]>([]);
  const [monitoring, setMonitoring] = useState(false);
  const [sensitivity, setSensitivity] = useState<AnomalySensitivity>('MEDIUM');
  const [lastMonitoredAt, setLastMonitoredAt] = useState<number | null>(null);

  const cancelRef = useRef(false);
  const pauseRef = useRef(false);
  const runningRef = useRef(false);
  const monitorRef = useRef(false);
  const regimeHistoryRef = useRef<Map<string, RegimeKind>>(new Map());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ report, walkForward, selection } satisfies PersistedLab)
      );
    } catch {
      // Ignore storage write errors.
    }
  }, [report, walkForward, selection]);

  const setHistoryBars = useCallback((bars: number) => {
    setSelection((prev) => ({ ...prev, historyBars: bars }));
  }, []);
  const setTimeframes = useCallback((tfs: TimeframeKey[]) => {
    setSelection((prev) => ({ ...prev, timeframes: tfs }));
  }, []);
  const toggleSymbol = useCallback((symbol: string) => {
    setSelection((prev) => ({
      ...prev,
      symbols: prev.symbols.includes(symbol)
        ? prev.symbols.filter((s) => s !== symbol)
        : [...prev.symbols, symbol],
    }));
  }, []);
  const toggleModel = useCallback((model: EntryModelId) => {
    setSelection((prev) => ({
      ...prev,
      models: prev.models.includes(model)
        ? prev.models.filter((m) => m !== model)
        : [...prev.models, model],
    }));
  }, []);

  const eligibleMarkets = useCallback((): SyntheticMarket[] => {
    const pool =
      selection.symbols.length > 0
        ? markets.filter((m) => selection.symbols.includes(m.symbol))
        : markets.filter((m) => m.isOpen && isVolatilityIndex(m));
    return pool.slice(0, MAX_MONITORED);
  }, [markets, selection.symbols]);

  const waitWhilePaused = useCallback(async () => {
    while (pauseRef.current && !cancelRef.current) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }, []);

  const startBacktest = useCallback(async () => {
    if (runningRef.current) return;
    const marketsToUse = eligibleMarkets();
    const models = selection.models.length > 0 ? selection.models : [...ENTRY_MODEL_IDS];
    const timeframes =
      selection.timeframes.length > 0 ? selection.timeframes : (['M5'] as TimeframeKey[]);

    if (marketsToUse.length === 0 || timeframes.length === 0) {
      setProgress((p) => ({
        ...p,
        status: 'IDLE',
        message: 'Select at least one open index and one timeframe before backtesting.',
      }));
      return;
    }

    cancelRef.current = false;
    pauseRef.current = false;
    runningRef.current = true;
    const total = marketsToUse.length * timeframes.length;
    let completed = 0;
    const evaluations: StrategyEvaluation[] = [];
    const allWalkForward: WalkForwardResult[] = [];

    setProgress({
      status: 'RUNNING',
      completed: 0,
      total,
      currentLabel: '',
      message: `Backtesting ${models.length} model(s) across ${marketsToUse.length} index(es) × ${timeframes.length} timeframe(s) on real Deriv history…`,
    });

    try {
      for (const market of marketsToUse) {
        for (const tf of timeframes) {
          if (cancelRef.current) break;
          await waitWhilePaused();
          if (cancelRef.current) break;
          const label = `${market.displayName} · ${tf}`;
          setProgress((p) => ({ ...p, currentLabel: label, message: `Fetching ${selection.historyBars} ${tf} candles for ${label}…` }));

          let candles: Candle[] = [];
          try {
            candles = await derivService.fetchHistoricalCandles(
              market.symbol,
              TIMEFRAME_MAP[tf].granularitySec,
              selection.historyBars
            );
          } catch {
            candles = [];
          }

          if (candles.length < 120) {
            completed += 1;
            setProgress((p) => ({
              ...p,
              completed,
              message: `Skipped ${label}: only ${candles.length} candles returned (need ≥ 120). No data fabricated.`,
            }));
            continue;
          }

          setProgress((p) => ({ ...p, message: `Replaying ${label} chronologically (no look-ahead)…` }));
          await new Promise((r) => setTimeout(r, 0));

          const params = {
            symbol: market.symbol,
            displayName: market.displayName,
            marketFamily: market.family,
            precision: market.precision,
            timeframe: tf,
            candles,
            models,
            cost: DEFAULT_COST_MODEL,
          };
          evaluations.push(...evaluateStrategies(params));
          allWalkForward.push(...walkForwardValidate({ ...params, windows: 4 }));

          completed += 1;
          setProgress((p) => ({
            ...p,
            completed,
            message: `Completed ${label} (${candles.length} bars).`,
          }));
        }
        if (cancelRef.current) break;
      }

      if (cancelRef.current) {
        setProgress((p) => ({ ...p, status: 'CANCELLED', message: 'Backtest cancelled.' }));
        return;
      }

      const next: OptimizationReport = {
        symbol: selection.symbols.length === 1 ? selection.symbols[0] : 'MULTI',
        displayName:
          selection.symbols.length === 1 ? selection.symbols[0] : `${marketsToUse.length} indices`,
        timeframe: timeframes[0],
        evaluations,
        walkForward: allWalkForward,
        parameterSweeps: [],
        recommendations: buildRecommendations(evaluations),
        generatedAt: Date.now(),
      };
      setReport(next);
      setWalkForward(allWalkForward);
      setProgress({
        status: 'COMPLETE',
        completed,
        total,
        currentLabel: '',
        message: `Backtest complete — ${evaluations.length} strategy/index evaluation(s) over real candles.`,
      });
    } finally {
      runningRef.current = false;
    }
  }, [derivService, eligibleMarkets, selection, waitWhilePaused]);

  const stopBacktest = useCallback(() => {
    if (!runningRef.current) return;
    cancelRef.current = true;
    pauseRef.current = false;
    setProgress((p) => ({ ...p, status: 'CANCELLED', message: 'Backtest stopped by user.' }));
  }, []);

  const runValidation = useCallback(async () => {
    if (runningRef.current) return;
    const marketsToUse = eligibleMarkets();
    const models = selection.models.length > 0 ? selection.models : [...ENTRY_MODEL_IDS];
    const tf = selection.timeframes[0] ?? 'M5';
    if (marketsToUse.length === 0) return;

    runningRef.current = true;
    cancelRef.current = false;
    setProgress({
      status: 'RUNNING',
      completed: 0,
      total: marketsToUse.length,
      currentLabel: '',
      message: 'Running walk-forward validation (train on the past, test on the future)…',
    });
    const out: WalkForwardResult[] = [];
    try {
      let done = 0;
      for (const market of marketsToUse) {
        if (cancelRef.current) break;
        let candles: Candle[] = [];
        try {
          candles = await derivService.fetchHistoricalCandles(
            market.symbol,
            TIMEFRAME_MAP[tf].granularitySec,
            selection.historyBars
          );
        } catch {
          candles = [];
        }
        done += 1;
        if (candles.length < 200) {
          setProgress((p) => ({ ...p, completed: done, message: `Skipped ${market.displayName}: insufficient history.` }));
          continue;
        }
        out.push(
          ...walkForwardValidate({
            symbol: market.symbol,
            displayName: market.displayName,
            marketFamily: market.family,
            precision: market.precision,
            timeframe: tf,
            candles,
            models,
            cost: DEFAULT_COST_MODEL,
            windows: 5,
          })
        );
        setProgress((p) => ({ ...p, completed: done, message: `Validated ${market.displayName} (${tf}).` }));
      }
      setWalkForward(out);
      setProgress({
        status: 'COMPLETE',
        completed: done,
        total: marketsToUse.length,
        currentLabel: '',
        message: `Validation complete — ${out.length} walk-forward result(s).`,
      });
    } finally {
      runningRef.current = false;
    }
  }, [derivService, eligibleMarkets, selection]);

  const runMonitorPass = useCallback(async () => {
    const marketsToUse = eligibleMarkets();
    if (marketsToUse.length === 0) return;
    const tf = selectionRef.current.timeframes[0] ?? 'M5';
    const granularity = TIMEFRAME_MAP[tf].granularitySec;
    const reports: AnomalyReport[] = [];
    const changes: RegimeChangeEvent[] = [];
    for (const market of marketsToUse) {
      if (!monitorRef.current) break;
      let candles: Candle[] = [];
      try {
        candles = await derivService.fetchHistoricalCandles(market.symbol, granularity, MONITOR_BAR_COUNT);
      } catch {
        candles = [];
      }
      if (candles.length < 60) continue;
      const report = analyzeMarketAnomaly({
        symbol: market.symbol,
        displayName: market.displayName,
        timeframe: tf,
        granularitySec: granularity,
        candles,
      });
      reports.push(report);
      const prev = regimeHistoryRef.current.get(market.symbol);
      if (prev && prev !== report.regime.regime) {
        changes.push({
          symbol: market.symbol,
          displayName: market.displayName,
          from: prev,
          to: report.regime.regime,
          at: Date.now(),
        });
      }
      regimeHistoryRef.current.set(market.symbol, report.regime.regime);
    }
    setAnomalyReports(reports);
    if (changes.length > 0) setRegimeChanges((prev) => [...changes, ...prev].slice(0, 50));
    setLastMonitoredAt(Date.now());
  }, [derivService, eligibleMarkets]);

  useEffect(() => {
    if (!monitoring) return;
    monitorRef.current = true;
    void runMonitorPass();
    const id = setInterval(() => void runMonitorPass(), 30_000);
    return () => {
      monitorRef.current = false;
      clearInterval(id);
    };
  }, [monitoring, runMonitorPass]);

  const startMonitoring = useCallback(() => setMonitoring(true), []);
  const pauseMonitoring = useCallback(() => setMonitoring(false), []);

  const clearResults = useCallback(() => {
    setReport(null);
    setWalkForward([]);
    setAnomalyReports([]);
    setRegimeChanges([]);
    regimeHistoryRef.current = new Map();
  }, []);

  const exportResults = useCallback(() => {
    const rows: string[] = [
      'symbol,timeframe,model,rating,validated,setups,filled,winRate,expectancyR,expectancyAfterCostR,avgRr,profitFactor,maxDrawdownR,tp1Rate,tp2Rate,tp3Rate,stopRate,avgBarsHeld',
    ];
    for (const e of report?.evaluations ?? []) {
      rows.push(
        [
          e.symbol,
          e.timeframe,
          e.model,
          e.rating,
          e.validated,
          e.overall.totalSetups,
          e.overall.filledTrades,
          e.outOfSample.winRatePercent ?? '',
          e.outOfSample.expectancyR ?? '',
          e.outOfSample.expectancyAfterCostR ?? '',
          e.outOfSample.averageRr ?? '',
          e.outOfSample.profitFactor ?? '',
          e.outOfSample.maxDrawdownR,
          e.outOfSample.tp1Rate ?? '',
          e.outOfSample.tp2Rate ?? '',
          e.outOfSample.tp3Rate ?? '',
          e.outOfSample.stopRate ?? '',
          e.outOfSample.averageBarsHeld ?? '',
        ].join(',')
      );
    }
    return rows.join('\n');
  }, [report]);

  const progressPercent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  return {
    report,
    walkForward,
    progress,
    progressPercent,
    selection,
    allTimeframes: TIMEFRAMES,
    allModels: ENTRY_MODEL_IDS.map((id) => ({ id, label: ENTRY_MODEL_LABELS[id] })),
    historyOptions: [600, 1200, 2000],
    anomalyReports,
    regimeChanges,
    monitoring,
    sensitivity,
    lastMonitoredAt,
    setHistoryBars,
    toggleSymbol,
    toggleModel,
    setTimeframes,
    setSensitivity,
    startBacktest,
    stopBacktest,
    runValidation,
    startMonitoring,
    pauseMonitoring,
    clearResults,
    exportResults,
  };
}

export type StrategyLabHookValue = ReturnType<typeof useStrategyLab>;
