import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backtestModels, type RunParams } from '../analysis/backtest';
import { TIMEFRAMES, TIMEFRAME_MAP } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { EntryModelId } from '../types/engine';
import { ENTRY_MODEL_IDS, ENTRY_MODEL_LABELS } from '../types/engine';
import type { Candle, SyntheticMarket, TimeframeKey } from '../types/market';
import type { BacktestReport, TrainingProgress, TrainingRunResult } from '../types/training';
import { isVolatilityIndex } from '../utils/volatilityMarkets';

const STORAGE_KEY = 'lucky_deriv_training_run_v1';
/** Real candles fetched per instrument/timeframe for a training pass. */
const TRAINING_BAR_COUNT = 1200;
/** Upper bound only to keep a single pass finite — every eligible Volatility Index fits. */
const MAX_INSTRUMENTS = 64;

export interface TrainingSelection {
  /** Symbols to train on; empty means "auto-select eligible indices". */
  symbols: string[];
  timeframes: TimeframeKey[];
  models: EntryModelId[];
}

export interface TrainingEngineValue {
  result: TrainingRunResult | null;
  progress: TrainingProgress;
  progressPercent: number;
  selection: TrainingSelection;
  allTimeframes: typeof TIMEFRAMES;
  allModels: { id: EntryModelId; label: string }[];
  setTimeframes: (tfs: TimeframeKey[]) => void;
  toggleSymbol: (symbol: string) => void;
  toggleModel: (model: EntryModelId) => void;
  setModels: (models: EntryModelId[]) => void;
  eligibleMarkets: () => SyntheticMarket[];
  startTraining: () => Promise<void>;
  pauseTraining: () => void;
  resumeTraining: () => void;
  cancelTraining: () => void;
  clearTraining: () => void;
}

interface UseTrainingEngineProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
}

function loadPersisted(): TrainingRunResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TrainingRunResult;
  } catch {
    return null;
  }
}

function persist(result: TrainingRunResult | null): void {
  try {
    if (result === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch {
    // Ignore storage write errors
  }
}

/**
 * Historical training + backtesting engine. Fetches REAL Deriv candles across the
 * selected Volatility / Jump / Step indices, replays them chronologically and
 * aggregates per-model, per-market and per-timeframe performance. It never fabricates
 * data or statistics, and it pauses between instruments so the UI stays responsive.
 */
export function useTrainingEngine({ derivService, markets }: UseTrainingEngineProps) {
  const [result, setResult] = useState<TrainingRunResult | null>(() => loadPersisted());
  const [progress, setProgress] = useState<TrainingProgress>({
    status: 'IDLE',
    completed: 0,
    total: 0,
    currentLabel: '',
    message: 'Idle. Choose markets, timeframes and models, then start training.',
  });
  const [selection, setSelection] = useState<TrainingSelection>({
    symbols: [],
    timeframes: ['M5'],
    models: [...ENTRY_MODEL_IDS],
  });

  const cancelRef = useRef(false);
  const pauseRef = useRef(false);
  const runningRef = useRef(false);

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

  const setModels = useCallback((models: EntryModelId[]) => {
    setSelection((prev) => ({ ...prev, models }));
  }, []);

  const eligibleMarkets = useCallback((): SyntheticMarket[] => {
    const pool =
      selection.symbols.length > 0
        ? markets.filter((m) => selection.symbols.includes(m.symbol) && isVolatilityIndex(m))
        : markets.filter((m) => m.isOpen && isVolatilityIndex(m));
    return pool.slice(0, MAX_INSTRUMENTS);
  }, [markets, selection.symbols]);

  const waitWhilePaused = useCallback(async () => {
    while (pauseRef.current && !cancelRef.current) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }, []);

  const startTraining = useCallback(async () => {
    if (runningRef.current) return;
    const marketsToUse = eligibleMarkets();
    const models = selection.models.length > 0 ? selection.models : [...ENTRY_MODEL_IDS];
    const timeframes = selection.timeframes.length > 0 ? selection.timeframes : (['M5'] as TimeframeKey[]);

    if (marketsToUse.length === 0 || timeframes.length === 0) {
      setProgress((p) => ({
        ...p,
        status: 'IDLE',
        message: 'Select at least one open market and one timeframe before training.',
      }));
      return;
    }

    cancelRef.current = false;
    pauseRef.current = false;
    runningRef.current = true;
    const total = marketsToUse.length * timeframes.length;
    let completed = 0;
    const reports: BacktestReport[] = [];
    let totalBars = 0;

    setProgress({
      status: 'RUNNING',
      completed: 0,
      total,
      currentLabel: '',
      message: `Training ${models.length} model(s) across ${marketsToUse.length} market(s) × ${timeframes.length} timeframe(s) on real Deriv history…`,
    });

    try {
      for (const market of marketsToUse) {
        for (const tf of timeframes) {
          if (cancelRef.current) break;
          await waitWhilePaused();
          if (cancelRef.current) break;

          const label = `${market.displayName} · ${tf}`;
          setProgress((p) => ({ ...p, currentLabel: label, message: `Fetching ${TRAINING_BAR_COUNT} ${tf} candles for ${label}…` }));

          let candles: Candle[];
          try {
            candles = await derivService.fetchHistoricalCandles(
              market.symbol,
              TIMEFRAME_MAP[tf].granularitySec,
              TRAINING_BAR_COUNT
            );
          } catch {
            candles = [];
          }

          if (candles.length < 80) {
            completed++;
            setProgress((p) => ({
              ...p,
              completed,
              message: `Skipped ${label}: only ${candles.length} candles returned (need ≥ 80). No data fabricated.`,
            }));
            continue;
          }

          setProgress((p) => ({ ...p, message: `Replaying ${label} chronologically…` }));
          await new Promise((r) => setTimeout(r, 0));

          const params: RunParams = {
            symbol: market.symbol,
            displayName: market.displayName,
            marketFamily: market.family,
            precision: market.precision,
            timeframe: tf,
            candles,
          };
          const modelReports = backtestModels(params, models);
          reports.push(...modelReports);
          totalBars += candles.length;

          completed++;
          setProgress((p) => ({
            ...p,
            completed,
            message: `Completed ${label} (${candles.length} bars, ${modelReports.reduce(
              (a, r) => a + r.trades.length,
              0
            )} setups).`,
          }));
        }
        if (cancelRef.current) break;
      }

      if (cancelRef.current) {
        setProgress((p) => ({ ...p, status: 'CANCELLED', message: 'Training cancelled by user.' }));
        return;
      }

      const next: TrainingRunResult = {
        reports,
        generatedAt: Date.now(),
        marketCount: marketsToUse.length,
        timeframeCount: timeframes.length,
        modelCount: models.length,
        totalBarsAnalyzed: totalBars,
      };
      setResult(next);
      persist(next);
      setProgress({
        status: 'COMPLETE',
        completed,
        total,
        currentLabel: '',
        message: `Training complete — ${reports.length} report(s) over ${totalBars} real candles. Out-of-sample results shown in the dashboard.`,
      });
    } finally {
      runningRef.current = false;
    }
  }, [derivService, eligibleMarkets, selection.models, selection.timeframes, waitWhilePaused]);

  const pauseTraining = useCallback(() => {
    if (!runningRef.current) return;
    pauseRef.current = true;
    setProgress((p) => ({ ...p, status: 'PAUSED', message: 'Training paused. Resume to continue.' }));
  }, []);

  const resumeTraining = useCallback(() => {
    if (!runningRef.current) return;
    pauseRef.current = false;
    setProgress((p) => ({ ...p, status: 'RUNNING', message: 'Resuming training…' }));
  }, []);

  const cancelTraining = useCallback(() => {
    cancelRef.current = true;
    pauseRef.current = false;
    setProgress((p) => ({ ...p, status: 'CANCELLED', message: 'Cancelling training…' }));
  }, []);

  const clearTraining = useCallback(() => {
    setResult(null);
    persist(null);
    setProgress({
      status: 'IDLE',
      completed: 0,
      total: 0,
      currentLabel: '',
      message: 'Cleared stored training results. Start a new pass to rebuild them.',
    });
  }, []);

  // Keep the progress bar coherent if the tab is re-opened mid-run.
  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const progressPercent =
    progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  const allModels = useMemo(
    () => ENTRY_MODEL_IDS.map((id) => ({ id, label: ENTRY_MODEL_LABELS[id] })),
    []
  );

  return {
    result,
    progress,
    progressPercent,
    selection,
    allTimeframes: TIMEFRAMES,
    allModels,
    setTimeframes,
    toggleSymbol,
    toggleModel,
    setModels,
    eligibleMarkets,
    startTraining,
    pauseTraining,
    resumeTraining,
    cancelTraining,
    clearTraining,
  };
}
