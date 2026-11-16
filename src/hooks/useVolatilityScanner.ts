import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createModelPerformanceRecord,
  evaluateModelPerformanceRecord,
  loadModelPerformance,
  saveModelPerformance,
} from '../analysis/modelPerformance';
import { analyzeInstrument, selectStrongestSignal } from '../analysis/signalEngine';
import { TIMEFRAME_MAP, TIMEFRAMES } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { EngineScanSummary, EngineSignal, ModelPerformanceRecord } from '../types/engine';
import type { Candle, ConnectionStatus, MarketFamily, SyntheticMarket, TimeframeKey } from '../types/market';
import type { InstrumentMonitorReading, MonitorScanSummary } from '../types/scanner';
import { eligibleMarkets } from '../utils/eligibleMarkets';

interface UseVolatilityScannerProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
  /** Live connection status — the background sweep only runs while connected. */
  connectionStatus?: ConnectionStatus;
  /** When false, the automatic background sweep is disabled (default: true). */
  autoStart?: boolean;
}

/**
 * Market Scanner — the breadth engine. A single live pass per instrument both reads
 * descriptive monitor data (price/activity/health so the user can pick an instrument)
 * AND runs the duration-free signal engine so the scanner can surface its own single
 * best setup. Nothing here references contract duration.
 *
 * The scanner runs AUTOMATICALLY in the background: it starts as soon as markets are
 * available and the connection is live, and then sweeps continuously. Scanning never
 * stops while setups are completed or invalidated — those events only change what is
 * ranked, never whether the sweep runs.
 */
export function useVolatilityScanner({
  derivService,
  markets,
  connectionStatus = 'connected',
  autoStart = true,
}: UseVolatilityScannerProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState(
    'Ready to scan every eligible Deriv index (Volatility standard + 1-second, Jump, Step) for the single best setup.'
  );
  const [monitorSummary, setMonitorSummary] = useState<MonitorScanSummary | null>(null);
  const [scanSummary, setScanSummary] = useState<EngineScanSummary | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeKey>('M5');
  // All eligible markets by default: standard + 1-second Volatility, Jump and Step.
  const [include1Sec, setInclude1Sec] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [performanceRecords, setPerformanceRecords] = useState<ModelPerformanceRecord[]>(() =>
    loadModelPerformance()
  );

  const scanAbortRef = useRef(false);
  const autoStartedRef = useRef(false);
  const isScanningRef = useRef(isScanning);
  isScanningRef.current = isScanning;
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

  const scanMarkets = useCallback(async () => {
    if (isScanningRef.current) return;
    scanAbortRef.current = false;
    setIsScanning(true);
    setScanProgress(0);
    setProgressMessage(`Scanning Deriv indices on ${timeframe} for the single best setup…`);

    try {
      // Every eligible market (standard + 1-second Volatility, Jump and Step). Boom/Crash
      // and all other synthetic families are excluded structurally by `eligibleMarkets`.
      const targetMarkets = eligibleMarkets(markets, { include1Sec });

      const familyCounts: Record<'VOLATILITY' | 'JUMP' | 'STEP' | 'RANGE_BREAK', number> = {
        VOLATILITY: targetMarkets.filter((m) => m.family === 'VOLATILITY').length,
        JUMP: targetMarkets.filter((m) => m.family === 'JUMP').length,
        STEP: targetMarkets.filter((m) => m.family === 'STEP').length,
        RANGE_BREAK: targetMarkets.filter((m) => m.family === 'RANGE_BREAK').length,
      };

      if (targetMarkets.length === 0) {
        setProgressMessage('No open Deriv indices match the selected market family toggles.');
        setMonitorSummary(null);
        setScanSummary(null);
        setIsScanning(false);
        return;
      }

      const tfConfig = TIMEFRAMES.find((t) => t.key === timeframe) ?? TIMEFRAMES[4];
      const granularity = tfConfig.granularitySec;

      const readings: InstrumentMonitorReading[] = [];
      const analyses = [];
      const total = targetMarkets.length;

      for (let i = 0; i < total; i++) {
        if (scanAbortRef.current) break;
        const market = targetMarkets[i];
        setProgressMessage(
          `Analysing ${market.displayName} [${market.family}]… (${i + 1}/${total})`
        );
        setScanProgress(Math.round(((i + 1) / total) * 100));

        try {
          const candles = await derivService.fetchHistoricalCandles(market.symbol, granularity, 160);
          const nowSec = Math.floor(Date.now() / 1000);
          let dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED' = 'HEALTHY';
          if (candles.length === 0) {
            dataHealth = 'STALE';
          } else {
            const latest = candles[candles.length - 1];
            const maxAllowedAgeSec = Math.max(180, granularity * 4);
            if (nowSec - latest.time > maxAllowedAgeSec) dataHealth = 'STALE';
          }

          // The sideways range is always defined on M15 and confirmed on M5, whatever
          // timeframe the scanner is set to.
          const rangeGranularity = TIMEFRAME_MAP.M15.granularitySec;
          const entryGranularity = TIMEFRAME_MAP.M5.granularitySec;
          let rangeCandles: Candle[] | undefined;
          let entryCandles: Candle[] | undefined;
          try {
            rangeCandles =
              granularity === rangeGranularity
                ? candles
                : await derivService.fetchHistoricalCandles(market.symbol, rangeGranularity, 160);
            entryCandles =
              granularity === entryGranularity
                ? candles
                : await derivService.fetchHistoricalCandles(market.symbol, entryGranularity, 160);
          } catch {
            rangeCandles = undefined;
            entryCandles = undefined;
          }

          const analysis = analyzeInstrument({
            symbol: market.symbol,
            displayName: market.displayName,
            precision: market.precision,
            marketFamily: market.family as MarketFamily,
            submarket: market.submarket,
            timeframe,
            candles,
            dataHealth,
            htfContext: {
              rangeCandles,
              entryCandles,
            },
          });
          analyses.push(analysis);

          // Descriptive monitor reading — no direction, no confidence.
          const latest = candles.length > 0 ? candles[candles.length - 1] : null;
          const price = latest?.close ?? 0;
          const lastCandleChangePercent =
            latest && latest.open !== 0
              ? ((latest.close - latest.open) / latest.open) * 100
              : null;
          let volatilityPercent: number | null = null;
          if (candles.length >= 5 && price > 0) {
            const window = candles.slice(-20);
            const hi = Math.max(...window.map((c) => c.high));
            const lo = Math.min(...window.map((c) => c.low));
            volatilityPercent = ((hi - lo) / price) * 100;
          }
          const activityLabel: InstrumentMonitorReading['activityLabel'] =
            dataHealth === 'STALE'
              ? 'Stale'
              : volatilityPercent !== null && volatilityPercent >= 0.5
                ? 'Active'
                : 'Quiet';

          readings.push({
            symbol: market.symbol,
            displayName: market.displayName,
            marketFamily: market.family,
            precision: market.precision,
            price,
            lastCandleChangePercent,
            candlesCount: candles.length,
            activityLabel,
            dataHealth,
            volatilityPercent,
            lastUpdated: nowSec * 1000,
          });
        } catch {
          readings.push({
            symbol: market.symbol,
            displayName: market.displayName,
            marketFamily: market.family,
            precision: market.precision,
            price: 0,
            lastCandleChangePercent: null,
            candlesCount: 0,
            activityLabel: 'Unavailable',
            dataHealth: 'DISCONNECTED',
            volatilityPercent: null,
            lastUpdated: Date.now(),
          });
        }

        await new Promise((r) => setTimeout(r, 70));
      }

      if (scanAbortRef.current) return;

      setMonitorSummary({
        readings,
        monitoredCount: readings.length,
        activeCount: readings.filter((r) => r.activityLabel === 'Active').length,
        staleCount: readings.filter((r) => r.dataHealth !== 'HEALTHY').length,
        scannedAt: Date.now(),
        timeframe,
      });

      const summary = selectStrongestSignal(analyses, timeframe, familyCounts);
      setScanSummary(summary);
      setLastScannedAt(summary.scannedAt);

      // Track the winning setup per-model for MFE/MAE learning, then settle open records.
      const settledExisting = performanceRecords.map((rec) => rec);
      let nextPerf = settledExisting;

      if (summary.winner) {
        const winner: EngineSignal = summary.winner;
        const existing = nextPerf.find((r) => r.id === winner.id);
        if (!existing) {
          const record = createModelPerformanceRecord(winner);
          nextPerf = [record, ...nextPerf].slice(0, 400);
        }
        setProgressMessage(
          `Best setup: ${winner.displayName} [${winner.marketFamily}] ${winner.direction} · ${winner.modelLabel} · ${winner.quality.total}/100. Open it in the Chart Analyser to co-analyse.`
        );
      } else {
        setProgressMessage(
          `Scan complete (${summary.scannedCount} indices analysed on ${timeframe}). NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION.`
        );
      }

      setPerformanceRecords(nextPerf);
      saveModelPerformance(nextPerf);
    } catch (err) {
      setProgressMessage(`Scan error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsScanning(false);
    }
  }, [derivService, include1Sec, markets, performanceRecords, timeframe]);

  const cancelScan = useCallback(() => {
    scanAbortRef.current = true;
    setIsScanning(false);
    setProgressMessage('Scan cancelled by user.');
  }, []);

  /** Re-evaluates every open performance record against fresh candles (structural settlement). */
  const refreshValidationSettlement = useCallback(async () => {
    const openRecords = performanceRecords.filter((r) => r.outcome === 'PENDING');
    if (openRecords.length === 0) {
      setProgressMessage('No open model records to settle.');
      return;
    }
    const granularity = (TIMEFRAMES.find((t) => t.key === timeframe) ?? TIMEFRAMES[4]).granularitySec;
    const updated = await Promise.all(
      performanceRecords.map(async (rec) => {
        if (rec.outcome !== 'PENDING') return rec;
        try {
          const bars = await derivService.fetchHistoricalCandles(rec.symbol, granularity, 240);
          return evaluateModelPerformanceRecord(rec, bars);
        } catch {
          return rec;
        }
      })
    );
    setPerformanceRecords(updated);
    saveModelPerformance(updated);
    setProgressMessage('Settled open model records against fresh price action.');
  }, [derivService, performanceRecords, timeframe]);

  // AUTOMATIC BACKGROUND SCANNER — start one pass as soon as markets are available and
  // the connection is live, then keep sweeping. Setup completion/invalidation never stops
  // this loop; it only changes what is ranked.
  useEffect(() => {
    if (!autoStart) return;
    if (connectionStatus !== 'connected') return;
    if (markets.length === 0) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void scanMarkets();
  }, [autoStart, connectionStatus, markets.length, scanMarkets]);

  // Continuous sweep while connected. The scanner keeps running for the whole session.
  useEffect(() => {
    if (!autoStart || !autoRefresh) return;
    if (connectionStatus !== 'connected') return;
    const interval = setInterval(() => {
      if (!isScanningRef.current && marketsRef.current.length > 0) {
        void scanMarkets();
      }
    }, 45_000);
    return () => clearInterval(interval);
  }, [autoStart, autoRefresh, connectionStatus, scanMarkets]);

  return {
    isScanning,
    scanProgress,
    progressMessage,
    monitorSummary,
    scanSummary,
    timeframe,
    include1Sec,
    autoRefresh,
    lastScannedAt,
    performanceRecords,
    setTimeframe,
    setInclude1Sec,
    setAutoRefresh,
    scanMarkets,
    cancelScan,
    refreshValidationSettlement,
  };
}
