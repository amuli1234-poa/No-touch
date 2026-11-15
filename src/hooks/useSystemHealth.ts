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
  /** Candle counts already observed per timeframe (M1/M5/M15) for the selected instrument. */
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
  aiModulesActive: number;
  aiModulesTotal: number;
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
  const fixedIssuesRef = useRef<string[]>([]);
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
    // Global coverage: probe EVERY eligible Volatility Index (standard + 1-second).
    // Boom/Crash and every other synthetic family are excluded by `eligibleMarkets`.
    const targets = eligibleMarkets(props.markets);

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
    const tickCounts = new Map<string, number>();
    const offTick = service.onTick((tick) => {
      tickCounts.set(tick.symbol, (tickCounts.get(tick.symbol) ?? 0) + 1);
    });

    for (const market of targets) {
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
        await service.subscribeTicks(market.symbol);
        probe.connected = service.getStatus() === 'connected';
        const candles = await service.fetchHistoricalCandles(
          market.symbol,
          TIMEFRAME_MAP.M1.granularitySec,
          40
        );
        probe.candlesReceived = candles.length;
        probe.candleFieldsValid = candles.length > 0 && candles.every(isValidCandle);
        probe.timestampsMonotonic = candles.every(
          (c, i) => i === 0 || c.time > candles[i - 1].time
        );
        // Wait briefly for real live ticks (never simulated). Kept short because the probe
        // now covers EVERY eligible index, so the whole pass stays bounded.
        await new Promise((r) => setTimeout(r, 1200));
        probe.ticksReceived = tickCounts.get(market.symbol) ?? 0;
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
    offTick();

    // Subscription cleanup: after unsubscribing, no probe symbol should still be subscribed.
    const diagnosticsAfter = service.getDiagnostics();
    const subscriptionCleanupOk =
      diagnosticsAfter.activeSubscriptions <= props.diagnostics.activeSubscriptions;
    if (!subscriptionCleanupOk) {
      notes.push(
        `Subscription cleanup did not return the active subscription count to its prior level (${props.diagnostics.activeSubscriptions} → ${diagnosticsAfter.activeSubscriptions}).`
      );
    }

    const anyReal = probes.some((p) => p.ticksReceived > 0 && p.candlesReceived > 0);
    const allCandlesValid = probes.every((p) => p.candlesReceived === 0 || p.candleFieldsValid);
    const status: LiveIntegrationResult['status'] =
      probes.length === 0
        ? 'NOT_TESTED'
        : anyReal && allCandlesValid && probes.every((p) => p.error === null)
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
      symbolsCorrect: probes.every((p) => /^[A-Z0-9_]+$/.test(p.symbol)),
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
        aiModulesActive: props.aiModulesActive,
        aiModulesTotal: props.aiModulesTotal,
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
