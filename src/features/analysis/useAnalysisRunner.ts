import { useCallback, useRef, useState } from 'react';
import { runAnalysis } from './orchestrator';
import type { AnalysisResult, AnalysisStage } from './types';
import type { AnalysisEngine } from './engines/types';
import type { Candle, Timeframe } from '../../types/scanner';

/**
 * Drives a single RUN ANALYSIS lifecycle for the panel.
 *
 * Concurrency is guarded here: while a run is in flight `run()` is a no-op, so
 * duplicate concurrent requests are impossible regardless of how fast the user
 * clicks. Cancellation aborts the in-flight run and marks it cancelled.
 */
export interface AnalysisRunnerDeps {
  engines: AnalysisEngine[];
  symbol: string;
  displayName: string;
  timeframe: Timeframe;
  candles: readonly Candle[];
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  isStale?: boolean;
  /** Called once per run when it finishes, for drawing creation / history. */
  onResult?: (result: AnalysisResult) => void;
}

export interface AnalysisRunner {
  running: boolean;
  stages: AnalysisStage[];
  result: AnalysisResult | null;
  run: () => void;
  cancel: () => void;
}

export function useAnalysisRunner(deps: AnalysisRunnerDeps): AnalysisRunner {
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<AnalysisStage[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const run = useCallback(() => {
    if (abortRef.current) return; // a run is already in flight
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);

    const d = depsRef.current;
    runAnalysis(
      {
        symbol: d.symbol,
        displayName: d.displayName,
        timeframe: d.timeframe,
        candles: d.candles,
        connectionState: d.connectionState,
        isStale: d.isStale,
        engines: d.engines,
        onProgress: setStages
      },
      controller.signal
    )
      .then((res) => {
        setResult(res);
        depsRef.current.onResult?.(res);
      })
      .catch(() => {
        // runAnalysis resolves rather than rejecting; this is a belt-and-braces guard.
      })
      .finally(() => {
        abortRef.current = null;
        setRunning(false);
      });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  return { running, stages, result, run, cancel };
}
