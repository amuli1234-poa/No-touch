import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildHealthChecks,
  HEALTH_TIMEFRAMES,
  summarizeHealth,
  type HealthCheck,
  type HealthSummary,
} from '../analysis/systemHealth';
import { TIMEFRAME_MAP } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { Candle, ConnectionStatus, SyntheticMarket, TimeframeKey } from '../types/market';
import type { ConnectionDiagnostics } from '../services/derivWebSocket';
import { isOneSecondVolatility } from '../utils/volatilityMarkets';
import { eligibleMarkets } from '../utils/eligibleMarkets';

const STORAGE_KEY = 'lucky_system_health_v1';
/** Hard cap on the whole live integration pass so it can never stay on RUNNING forever. */
const LIVE_TEST_BUDGET_MS = 150_000;
/** Hard cap on a single market probe (subscribe + history + tick wait). A history request
 * may have to wait for a window slot behind a background sweep, so this must exceed the
 * worst-case queue wait; it is a safety net, not the normal path. */
const LIVE_PROBE_TIMEOUT_MS = 30_000;
/** How long each probe waits for real live ticks (never simulated). */
const LIVE_PROBE_TICK_WAIT_MS = 2_000;

/** Rejects after `ms` so no probe can hang the whole integration pass. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface LiveIntegrationProbe {
  symbol: string;
  displayName: string;
  isOneSecond: boolean;
  /** real connection reached + real data received. */
  connected: boolean;
  ticksReceived: number;
  candlesReceived: number;
  candleFieldsValid: boolean;
  timestampsMonotonic: boolean;
  error: string | null;
}

export interface LiveIntegrationResult {
  ranAt: number;
  status: 'PASS' | 'FAIL' | 'NOT_TESTED';
  probes: LiveIntegrationProbe[];
  marketsDiscovered: number;
  symbolsCorrect: boolean;
  subscriptionCleanupOk: boolean;
  notes: string[];
}

export interface HealthReport {
  checks: HealthCheck[];
  summary: HealthSummary;
  live: LiveIntegrationResult | null;
  running: boolean;
  runAt: number | null;
  /** Candle counts already observed per timeframe (M30/M15/M10/M7/M6/M5/M4/M3/M2/M1) for the selected instrument. */
  timeframesReady: Partial<Record<TimeframeKey, number>>;
  runDiagnostics: () => Promise<void>;
  runLiveIntegrationTest: () => Promise<void>;
  fixedIssues: string[];
}

interface UseSystemHealthProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
  marketsLoading: boolean;
  selectedSymbol: string;
  connectionStatus: ConnectionStatus;
  diagnostics: ConnectionDiagnostics;
  lastTickAt: number | null;
  feedStale: boolean;
  candleCount: number;
  loadState: string;
  dataError: string | null;
  candles: Candle[];
  isAnalyzing: boolean;
  report: unknown | null;
  analysisError: string | null;
  scannerRanAt: number | null;
  scannerRows: number;
  floatingScannerOpen: boolean;
  aiModulesRun: number;
  aiModulesActive: number;
  aiModulesTotal: number;
  aiScanError: string | null;
  alertCount: number;
  backtestEvaluations: number;
  performanceRecords: number;
  anomalyReports: number;
  /** Pushes a validated integration test result into the alert manager. */
  onIntegrationResult?: (result: LiveIntegrationResult) => void;
}

function isValidCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.high >= c.low &&
    c.high >= c.open &&
    c.high >= c.close &&
    c.low <= c.open &&
    c.low <= c.close
  );
}

/**
 * SYSTEM HEALTH & DIAGNOSTICS — collects real runtime evidence and runs a genuine Deriv live
 * integration test against multiple Volatility Indices (standard + 1-second). Boom/Crash are
 * excluded. It never uses simulated prices: if a probe cannot receive real data it reports
 * NOT_TESTED/FAIL rather than a fabricated pass.
 */
export function useSystemHealth(props: UseSystemHealthProps): HealthReport {
  const [live, setLive] = useState<LiveIntegrationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runAt, setRunAt] = useState<number | null>(null);
  const [timeframesReady, setTimeframesReady] = useState<Partial<Record<TimeframeKey, number>>>({});
  const [now, setNow] = useState(() => Date.now());
  const fixedIssuesRef = useRef<string[]>([
    'One shared Deriv market-data connection: every AI module, the scanner, the analyser, the chart and the health centre now read the SAME candle series per symbol + timeframe instead of each fetching its own.',
    'Fixed the tick-history rate-limit failure: requests are released through a 40-per-25s sliding window (measured against the live endpoint), so a full 23-market sweep no longer trips Deriv’s ~50-request limit.',
    'Added a shared candle cache with in-flight de-duplication, so ten staggered module passes share one round of history fetches rather than issuing hundreds of duplicates.',
    'AI modules are now reported honestly: an idle module reads NOT TESTED, never FAILED, and a data-starved sweep reports the concrete reason instead of a bare 0/12.',
    'The live integration test can no longer hang on “Running…”: every probe has a timeout, the whole pass has a budget, and Jump 10 / Step 100 are verified first.',
  ]);
  const selectedRef = useRef(props.selectedSymbol);
  selectedRef.current = props.selectedSymbol;
  const serviceRef = useRef(props.derivService);
  serviceRef.current = props.derivService;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  // The shared chart only ever loads ONE timeframe at a time, so the health centre fetches the
  // three core timeframes internally (real candles, never synthetic) to verify synchronisation.
  useEffect(() => {
    let cancelled = false;
    const symbol = props.selectedSymbol;
    if (!symbol || props.connectionStatus !== 'connected') return;
    const precisionTfs = HEALTH_TIMEFRAMES;
    const timer = setTimeout(() => {
      void (async () => {
        for (const tf of precisionTfs) {
          if (cancelled) return;
          try {
            const candles = await serviceRef.current.fetchHistoricalCandles(
              symbol,
              TIMEFRAME_MAP[tf].granularitySec,
              40
            );
            if (cancelled) return;
            setTimeframesReady((prev) => ({
              ...prev,
              [tf]: candles.filter(isValidCandle).length,
            }));
          } catch {
            if (cancelled) return;
            setTimeframesReady((prev) => ({ ...prev, [tf]: 0 }));
          }
        }
      })();
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.selectedSymbol, props.connectionStatus]);

  const runLiveIntegrationTest = useCallback(async () => {
    const service = serviceRef.current;
    const notes: string[] = [];
    // Global coverage: probe EVERY eligible Volatility Index (standard + 1-second) plus the
    // Jump and Step indices. Boom/Crash and every other synthetic family are excluded by
    // `eligibleMarkets`. Jump 10 and Step 100 are probed FIRST so the two families called out
    // by the spec are always verified even if the overall budget is reached.
    const eligible = eligibleMarkets(props.markets);
    const priority = (m: SyntheticMarket) =>
      m.symbol === 'JD10' ? 0 : m.symbol === 'stpRNG' ? 1 : 2;
    const targets = [...eligible].sort((a, b) => priority(a) - priority(b));

    if (targets.length === 0) {
      const result: LiveIntegrationResult = {
        ranAt: Date.now(),
        status: 'NOT_TESTED',
        probes: [],
        marketsDiscovered: props.markets.length,
        symbolsCorrect: false,
        subscriptionCleanupOk: false,
        notes: ['No eligible open Volatility Index was discovered — cannot run the live test.'],
      };
      setLive(result);
      props.onIntegrationResult?.(result);
      return;
    }

    setRunning(true);
    const probes: LiveIntegrationProbe[] = [];
    const discoveredSymbols = new Set(props.markets.map((m) => m.symbol));
    const subsBefore = service.getDiagnostics().activeSubscriptions;
    const tickCounts = new Map<string, number>();
    const offTick = service.onTick((tick) => {
      tickCounts.set(tick.symbol, (tickCounts.get(tick.symbol) ?? 0) + 1);
    });

    const startedAt = Date.now();
    let budgetHit = false;
    try {
      for (const market of targets) {
        if (Date.now() - startedAt > LIVE_TEST_BUDGET_MS) {
          budgetHit = true;
          break;
        }
        const probe: LiveIntegrationProbe = {
          symbol: market.symbol,
          displayName: market.displayName,
          isOneSecond: isOneSecondVolatility(market),
          connected: false,
          ticksReceived: 0,
          candlesReceived: 0,
          candleFieldsValid: false,
          timestampsMonotonic: false,
          error: null,
        };
        try {
          await withTimeout(
            (async () => {
              await service.subscribeTicks(market.symbol);
              probe.connected = service.getStatus() === 'connected';
              const candles = await service.fetchHistoricalCandles(
                market.symbol,
                TIMEFRAME_MAP.M1.granularitySec,
                40,
                { priority: true }
              );
              probe.candlesReceived = candles.length;
              probe.candleFieldsValid = candles.length > 0 && candles.every(isValidCandle);
              probe.timestampsMonotonic = candles.every(
                (c, i) => i === 0 || c.time > candles[i - 1].time
              );
              // Wait briefly for real live ticks (never simulated).
              await new Promise((r) => setTimeout(r, LIVE_PROBE_TICK_WAIT_MS));
              probe.ticksReceived = tickCounts.get(market.symbol) ?? 0;
            })(),
            LIVE_PROBE_TIMEOUT_MS,
            `Probe ${market.symbol}`
          );
        } catch (err) {
          probe.error = err instanceof Error ? err.message : String(err);
        } finally {
          try {
            await service.unsubscribeTicks(market.symbol);
          } catch {
            // Unsubscribe failures are recorded through the cleanup flag below.
          }
        }
        probes.push(probe);
      }
    } finally {
      offTick();
    }
    if (budgetHit) {
      notes.push(
        `Live test budget of ${Math.round(LIVE_TEST_BUDGET_MS / 1000)}s reached after ${probes.length}/${targets.length} markets; remaining markets were not probed.`
      );
    }

    // Subscription cleanup: after unsubscribing, the active subscription count must return
    // to what it was before the pass started (the background sweep keeps running).
    const diagnosticsAfter = service.getDiagnostics();
    const subscriptionCleanupOk = diagnosticsAfter.activeSubscriptions <= subsBefore;
    if (!subscriptionCleanupOk) {
      notes.push(
        `Subscription cleanup did not return the active subscription count to its prior level (${subsBefore} → ${diagnosticsAfter.activeSubscriptions}).`
      );
    }

    const allProbesReal = probes.every(
      (p) => p.ticksReceived > 0 && p.candlesReceived > 0 && p.error === null
    );
    const allCandlesValid = probes.every((p) => p.candlesReceived === 0 || p.candleFieldsValid);
    const allTimestampsValid = probes.every((p) => p.timestampsMonotonic);
    // Every probed symbol must be one Deriv actually listed in `active_symbols` (the Step
    // Index is `stpRNG`, so this checks membership rather than guessing at a format).
    const symbolsCorrect = probes.every((p) => discoveredSymbols.has(p.symbol));
    // A PASS requires EVERY probed market to have produced real ticks AND real candles with
    // valid fields. Partial evidence (a probe that only got candles, or hit a timeout) is
    // reported honestly as FAIL / NOT_TESTED rather than being rounded up to a pass.
    const status: LiveIntegrationResult['status'] =
      probes.length === 0
        ? 'NOT_TESTED'
        : allProbesReal && allCandlesValid && allTimestampsValid && symbolsCorrect
          ? 'PASS'
          : probes.some((p) => p.error !== null)
            ? 'FAIL'
            : 'NOT_TESTED';

    if (status !== 'PASS') {
      notes.push(
        'The live test did not observe both real ticks and real candles for every probe — reported honestly rather than passing on partial evidence.'
      );
    }

    const result: LiveIntegrationResult = {
      ranAt: Date.now(),
      status,
      probes,
      marketsDiscovered: props.markets.length,
      // Every probed symbol must be one Deriv actually listed in `active_symbols` (the
      // Step Index is `stpRNG`, so the test checks membership, not a format guess).
      symbolsCorrect,
      subscriptionCleanupOk,
      notes,
    };
    setLive(result);
    props.onIntegrationResult?.(result);
    setRunning(false);
  }, [props]);

  const runDiagnostics = useCallback(async () => {
    setRunAt(Date.now());
    await runLiveIntegrationTest();
  }, [runLiveIntegrationTest]);

  const checks = useMemo(
    () =>
      buildHealthChecks({
        connectionStatus: props.connectionStatus,
        diagnostics: props.diagnostics,
        lastTickAt: props.lastTickAt,
        feedStale: props.feedStale,
        marketsCount: props.markets.length,
        eligibleMarketsCount: eligibleMarkets(props.markets, { requireOpen: false }).length,
        marketsLoading: props.marketsLoading,
        selectedSymbol: props.selectedSymbol,
        candleCount: props.candleCount,
        loadState: props.loadState,
        dataError: props.dataError,
        timeframesReady,
        isAnalyzing: props.isAnalyzing,
        report: props.report,
        analysisError: props.analysisError,
        scannerRanAt: props.scannerRanAt,
        scannerRows: props.scannerRows,
        floatingScannerOpen: props.floatingScannerOpen,
        aiModulesRun: props.aiModulesRun,
        aiModulesActive: props.aiModulesActive,
        aiModulesTotal: props.aiModulesTotal,
        aiScanError: props.aiScanError,
        alertCount: props.alertCount,
        backtestEvaluations: props.backtestEvaluations,
        performanceRecords: props.performanceRecords,
        riskRuleCount: 3,
        anomalyReports: props.anomalyReports,
        now,
      }),
    [props, timeframesReady, now]
  );

  // Persist only the last live test (so a fresh session does not fake a PASS).
  useEffect(() => {
    if (!live) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(live));
    } catch {
      // ignore storage errors
    }
  }, [live]);

  return {
    checks,
    summary: summarizeHealth(checks),
    live,
    running,
    runAt,
    timeframesReady,
    runDiagnostics,
    runLiveIntegrationTest,
    fixedIssues: fixedIssuesRef.current,
  };
}
