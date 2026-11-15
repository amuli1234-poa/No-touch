import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SYMBOL,
  DEFAULT_TIMEFRAME,
  HISTORY_PAGE_COUNT,
  INITIAL_CANDLE_COUNT,
  TIMEFRAME_MAP,
  WS_STALE_TICK_MS,
} from '../config/deriv';
import { DerivWebSocketService, type ConnectionDiagnostics } from '../services/derivWebSocket';
import type {
  Candle,
  ChartLoadState,
  ConnectionStatus,
  DerivErrorInfo,
  SyntheticMarket,
  TimeframeKey,
} from '../types/market';
import {
  candleEquals,
  foldTickIntoCandle,
  mergeCandleUpdate,
  prependHistoricalCandles,
} from '../utils/derivParser';

export interface CandleDataset {
  datasetId: number;
  symbol: string;
  timeframe: TimeframeKey;
  candles: Candle[];
}

export interface LiveCandleTick {
  datasetId: number;
  seq: number;
  candle: Candle;
}

export function useDerivChartData() {
  const serviceRef = useRef<DerivWebSocketService | null>(null);
  if (!serviceRef.current) {
    serviceRef.current = new DerivWebSocketService();
  }
  const service = serviceRef.current;

  const [markets, setMarkets] = useState<SyntheticMarket[]>([]);
  const [marketsLoading, setMarketsLoading] = useState<boolean>(true);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [timeframe, setTimeframe] = useState<TimeframeKey>(DEFAULT_TIMEFRAME);

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting');
  const [connectionError, setConnectionError] = useState<DerivErrorInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics>(() =>
    service.getDiagnostics()
  );
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [feedStale, setFeedStale] = useState<boolean>(false);

  const [dataset, setDataset] = useState<CandleDataset>({
    datasetId: 0,
    symbol: DEFAULT_SYMBOL,
    timeframe: DEFAULT_TIMEFRAME,
    candles: [],
  });
  const [liveTick, setLiveTick] = useState<LiveCandleTick | null>(null);
  const [loadState, setLoadState] = useState<ChartLoadState>('loading');
  const [dataError, setDataError] = useState<string | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState<boolean>(false);
  const [hasMoreHistory, setHasMoreHistory] = useState<boolean>(true);

  const requestCounterRef = useRef(0);
  const activeDatasetIdRef = useRef(0);
  const tickSeqRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const bootstrappingRef = useRef(false);
  const datasetRef = useRef<CandleDataset>(dataset);
  const marketsRef = useRef<SyntheticMarket[]>(markets);
  const activeSymbolRef = useRef(selectedSymbol);
  const activeTimeframeRef = useRef(timeframe);
  const activeStreamRef = useRef<{ symbol: string; granularity: number } | null>(null);

  datasetRef.current = dataset;
  marketsRef.current = markets;
  activeSymbolRef.current = selectedSymbol;
  activeTimeframeRef.current = timeframe;

  const selectedMarket = useMemo<SyntheticMarket | null>(() => {
    return markets.find((m) => m.symbol === selectedSymbol) ?? null;
  }, [markets, selectedSymbol]);

  const loadHistoryAndStream = useCallback(
    async (symbol: string, tf: TimeframeKey) => {
      const reqSeq = ++requestCounterRef.current;
      const nextDatasetId = reqSeq;
      activeDatasetIdRef.current = nextDatasetId;
      const granularity = TIMEFRAME_MAP[tf].granularitySec;

      // Release the previous instrument's streams so only one candle + tick stream
      // per instrument is ever open; other concurrent streams are left untouched.
      const prev = activeStreamRef.current;
      if (prev) {
        void service
          .unsubscribeCandleSubscription(prev.symbol, prev.granularity)
          .catch(() => {});
        void service.unsubscribeTicks(prev.symbol).catch(() => {});
      }
      activeStreamRef.current = { symbol, granularity };

      setLoadState('loading');
      setDataError(null);
      setHasMoreHistory(true);
      setLiveTick(null);
      setDataset({
        datasetId: nextDatasetId,
        symbol,
        timeframe: tf,
        candles: [],
      });

      const knownMarkets = marketsRef.current;
      if (knownMarkets.length > 0 && !knownMarkets.some((m) => m.symbol === symbol)) {
        setDataError(`Market symbol "${symbol}" is not listed in active Deriv synthetic indices.`);
        setLoadState('error');
        return;
      }

      try {
        const historical = await service.subscribeCandles(
          symbol,
          granularity,
          INITIAL_CANDLE_COUNT
        );
        // A newer switch superseded this request while it was in flight: abandon it before
        // opening any tick stream, otherwise this symbol would stream forever unobserved.
        if (requestCounterRef.current !== reqSeq) return;
        // Open a continuous tick stream so the forming candle updates between OHLC frames.
        void service.subscribeTicks(symbol).catch(() => {});

        setDataset({
          datasetId: nextDatasetId,
          symbol,
          timeframe: tf,
          candles: historical,
        });

        if (historical.length === 0) {
          setLoadState('empty');
        } else {
          setLoadState('ready');
        }
      } catch (err) {
        if (requestCounterRef.current !== reqSeq) return;
        const message =
          err instanceof Error
            ? err.message
            : 'Unable to load historical candle data from Deriv.';
        setDataError(message);
        setLoadState('error');
      }
    },
    [service]
  );

  const bootstrap = useCallback(async () => {
    if (bootstrappingRef.current) return;
    bootstrappingRef.current = true;
    setMarketsLoading(true);
    setDataError(null);
    try {
      const list = await service.fetchSyntheticMarkets();
      if (list.length === 0) {
        throw new Error('Deriv active_symbols returned zero synthetic index markets.');
      }
      marketsRef.current = list;
      setMarkets(list);
      setMarketsLoading(false);

      const resolvedSymbol =
        list.find((m) => m.symbol === activeSymbolRef.current)?.symbol ??
        list.find((m) => m.symbol === DEFAULT_SYMBOL)?.symbol ??
        list[0].symbol;

      if (resolvedSymbol !== activeSymbolRef.current) {
        activeSymbolRef.current = resolvedSymbol;
        setSelectedSymbol(resolvedSymbol);
      }

      await loadHistoryAndStream(resolvedSymbol, activeTimeframeRef.current);
    } catch (err) {
      setMarketsLoading(false);
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to connect to Deriv market feed.';
      setDataError(message);
      setLoadState('error');
    } finally {
      bootstrappingRef.current = false;
    }
  }, [loadHistoryAndStream, service]);

  useEffect(() => {
    const unsubStatus = service.onStatusChange((status, err) => {
      setConnectionStatus(status);
      setConnectionError(err ?? null);
      setDiagnostics(service.getDiagnostics());
    });

    // Applies an incoming live candle without ever rebuilding history. The forming
    // candle is only committed when its OHLC actually changes, so a duplicate or
    // no-op frame cannot trigger a chart repaint (the source of the flicker).
    const commitLiveCandle = (nextCandles: Candle[], datasetId: number) => {
      const current = datasetRef.current;
      if (current.datasetId !== datasetId) return;

      // Quantise the tick timestamp to the second so a burst of ticks cannot trigger
      // more than one parent re-render per second (matters on lower-end Android).
      const nowSec = Math.floor(Date.now() / 1000) * 1000;
      setLastTickAt((prev) => (prev === nowSec ? prev : nowSec));
      setFeedStale(false);

      const nextLast = nextCandles[nextCandles.length - 1];
      if (nextLast === undefined) return;

      const prevLast = current.candles[current.candles.length - 1];
      const changed =
        nextCandles !== current.candles &&
        (prevLast === undefined || !candleEquals(prevLast, nextLast));
      if (!changed) return;

      setDataset((prev) =>
        prev.datasetId === datasetId ? { ...prev, candles: nextCandles } : prev
      );
      tickSeqRef.current += 1;
      setLiveTick({ datasetId, seq: tickSeqRef.current, candle: nextLast });
      setLoadState((prevState) =>
        prevState === 'loading' || prevState === 'empty' ? 'ready' : prevState
      );
    };

    const unsubOhlc = service.onOhlc((event) => {
      const expectedGranularity = TIMEFRAME_MAP[activeTimeframeRef.current].granularitySec;
      const currentDatasetId = activeDatasetIdRef.current;
      if (
        event.symbol !== activeSymbolRef.current ||
        event.granularity !== expectedGranularity ||
        datasetRef.current.datasetId !== currentDatasetId
      ) {
        return;
      }
      commitLiveCandle(
        mergeCandleUpdate(datasetRef.current.candles, event.candle),
        currentDatasetId
      );
    });

    const unsubTick = service.onTick((event) => {
      const expectedGranularity = TIMEFRAME_MAP[activeTimeframeRef.current].granularitySec;
      const currentDatasetId = activeDatasetIdRef.current;
      if (
        event.symbol !== activeSymbolRef.current ||
        datasetRef.current.datasetId !== currentDatasetId
      ) {
        return;
      }
      // Fold the tick into the forming candle so its true open/high/low/close are kept
      // (never reset to a flat candle), then commit only when OHLC actually changes.
      commitLiveCandle(
        foldTickIntoCandle(datasetRef.current.candles, expectedGranularity, {
          epochSec: event.epochSec,
          quote: event.quote,
        }),
        currentDatasetId
      );
    });

    const unsubSnapshot = service.onCandleSnapshot((event) => {
      const expectedGranularity = TIMEFRAME_MAP[activeTimeframeRef.current].granularitySec;
      const currentDatasetId = activeDatasetIdRef.current;
      if (
        event.symbol !== activeSymbolRef.current ||
        event.granularity !== expectedGranularity ||
        datasetRef.current.datasetId !== currentDatasetId
      ) {
        return;
      }
      setDataset((prev) => {
        if (prev.datasetId !== currentDatasetId) return prev;
        return { ...prev, candles: event.candles };
      });
      setLoadState('ready');
    });

    void bootstrap();

    return () => {
      unsubStatus();
      unsubOhlc();
      unsubTick();
      unsubSnapshot();
      service.disconnect();
    };
  }, [bootstrap, service]);

  // A live feed is stale when no tick has arrived within the staleness window.
  useEffect(() => {
    const id = setInterval(() => {
      const tickAt = lastTickAtRef.current;
      const isStale =
        connectionStatus !== 'connected' ||
        tickAt === null ||
        Date.now() - tickAt > WS_STALE_TICK_MS;
      setFeedStale((prev) => (prev === isStale ? prev : isStale));
      setDiagnostics(service.getDiagnostics());
    }, 3000);
    return () => clearInterval(id);
  }, [connectionStatus, service]);

  const prevStatusRef = useRef<ConnectionStatus>('connecting');
  const lastTickAtRef = useRef<number | null>(null);
  lastTickAtRef.current = lastTickAt;
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = connectionStatus;

    const recovered =
      (prev === 'reconnecting' || prev === 'error' || prev === 'disconnected') &&
      connectionStatus === 'connected';

    // Subscriptions are restored by the service itself on every reconnect. Only the
    // market list needs re-fetching here; the chart snapshot arrives via onCandleSnapshot.
    if (recovered && !bootstrappingRef.current && marketsRef.current.length === 0) {
      void bootstrap();
    }
  }, [bootstrap, connectionStatus]);

  const selectMarket = useCallback(
    (symbol: string) => {
      if (symbol === activeSymbolRef.current && loadState === 'ready') return;
      if (marketsRef.current.length > 0 && !marketsRef.current.some((m) => m.symbol === symbol)) {
        setDataError(`Market symbol "${symbol}" is not available in active Deriv synthetic indices.`);
        setLoadState('error');
        return;
      }
      activeSymbolRef.current = symbol;
      setSelectedSymbol(symbol);
      void loadHistoryAndStream(symbol, activeTimeframeRef.current);
    },
    [loadHistoryAndStream, loadState]
  );

  const selectTimeframe = useCallback(
    (tf: TimeframeKey) => {
      if (tf === activeTimeframeRef.current && loadState === 'ready') return;
      activeTimeframeRef.current = tf;
      setTimeframe(tf);
      void loadHistoryAndStream(activeSymbolRef.current, tf);
    },
    [loadHistoryAndStream, loadState]
  );

  const reconnect = useCallback(async () => {
    setDataError(null);
    setLoadState('loading');
    try {
      await service.reconnect();
      // The service re-issues all registered subscriptions on the new socket; the fresh
      // candle snapshot arrives via onCandleSnapshot, so no teardown is needed here.
      if (marketsRef.current.length === 0) {
        await bootstrap();
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Reconnection to Deriv failed.';
      setDataError(message);
      setLoadState('error');
    }
  }, [bootstrap, service]);

  const loadOlderCandles = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreHistory) return;
    const currentSnapshot = datasetRef.current;
    if (currentSnapshot.candles.length === 0) return;

    const datasetIdAtStart = currentSnapshot.datasetId;
    const symbolAtStart = currentSnapshot.symbol;
    const tfAtStart = currentSnapshot.timeframe;
    const granularity = TIMEFRAME_MAP[tfAtStart].granularitySec;
    const oldestTime = currentSnapshot.candles[0].time;

    loadingOlderRef.current = true;
    setIsLoadingOlder(true);

    try {
      const older = await service.fetchOlderCandles(
        symbolAtStart,
        granularity,
        oldestTime - 1,
        HISTORY_PAGE_COUNT
      );

      if (activeDatasetIdRef.current !== datasetIdAtStart) {
        return;
      }

      if (older.length === 0) {
        setHasMoreHistory(false);
      } else {
        setDataset((prev) => {
          if (prev.datasetId !== datasetIdAtStart) return prev;
          const merged = prependHistoricalCandles(prev.candles, older);
          if (merged.length === prev.candles.length) {
            setHasMoreHistory(false);
          }
          return {
            ...prev,
            candles: merged,
          };
        });
      }
    } catch {
      // Ignore transient pagination errors without interrupting the live chart
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [hasMoreHistory, service]);

  const fetchCandlesSnapshot = useCallback(
    async (symbol: string, tf: TimeframeKey, count = 180): Promise<Candle[]> => {
      const granularity = TIMEFRAME_MAP[tf].granularitySec;
      return service.fetchHistoricalCandles(symbol, granularity, count);
    },
    [service]
  );

  return {
    markets,
    marketsLoading,
    selectedSymbol,
    selectedMarket,
    timeframe,
    granularitySec: TIMEFRAME_MAP[timeframe].granularitySec,
    connectionStatus,
    connectionError,
    diagnostics,
    lastTickAt,
    feedStale,
    dataset,
    candles: dataset.candles,
    liveTick,
    loadState,
    dataError,
    isLoadingOlder,
    hasMoreHistory,
    selectMarket,
    selectTimeframe,
    reconnect,
    loadOlderCandles,
    fetchCandlesSnapshot,
    derivService: service,
  };
}
