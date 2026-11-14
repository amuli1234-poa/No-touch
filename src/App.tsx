import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { DerivWebSocketManager } from './services/DerivWebSocketManager';
import { IndexedDbStorage } from './services/IndexedDbStorage';
import { WhatsAppService } from './services/WhatsAppService';
import { telemetry } from './services/TelemetryService';
import { refreshBalances, onReconnect } from './lib/balances';
import { OpportunityScoringEngine } from './engines/OpportunityScoringEngine';
import { AppShell } from './components/shell/AppShell';
import { Route } from './components/shell/navigation';
import { BestMarketView } from './components/views/BestMarketView';
import { StrategyScannerView } from './components/views/StrategyScannerView';
import { MtfPrecisionEntryView } from './components/views/MtfPrecisionEntryView';
import { LiveMarketScannerTable } from './components/views/LiveMarketScannerTable';
import { TradingWorkspace } from './components/chart/TradingWorkspace';
import { OpportunityCard } from './components/views/OpportunityCard';
import { SignalsView } from './components/views/SignalsView';
import { PerformanceDashboard } from './components/views/PerformanceDashboard';
import { SettingsView } from './components/views/SettingsView';
import { Card, CardHeader, CardBody, EmptyState } from './components/ui';
import { SectionTitle } from './components/ui/StatCard';
import { LineChart } from 'lucide-react';
import {
  ActiveSymbol,
  OpportunitySignal,
  ScannerSettings,
  SignalHistoryEntry,
  Timeframe,
  WhatsAppProviderStatus,
  WhatsAppSignalRecord
} from './types/scanner';

const SETTINGS_KEY = 'wicksentinel_settings_v1';

const DEFAULT_SETTINGS: ScannerSettings = {
  appId: 1089,
  minScoreThreshold: 75,
  fvgMinDisplacement: 0.00025,
  autoRefreshIntervalSec: 10,
  soundAlerts: true,
  whatsappAutoSend: false,
  whatsappNotifyUpdates: true,
  showSecondaryIndicators: true
};

export default function App() {
  const [settings, setSettings] = useState<ScannerSettings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (!saved) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(saved) as Partial<ScannerSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        minScoreThreshold: Math.max(75, parsed.minScoreThreshold ?? 75)
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [wsManager] = useState(() => new DerivWebSocketManager(settings.appId));
  const [storage] = useState(() => new IndexedDbStorage());
  const [waService] = useState(() => new WhatsAppService());

  const [connectionState, setConnectionState] = useState<
    'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING'
  >('RECONNECTING');
  const [symbols, setSymbols] = useState<ActiveSymbol[]>(() => wsManager.getDiscoveredSymbols());
  const [selectedSymbol, setSelectedSymbol] = useState<string>('R_100');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('5m');
  const [route, setRoute] = useState<Route>('LIVE_CHART');

  const [opportunities, setOpportunities] = useState<Map<string, OpportunitySignal>>(new Map());
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTimestamp, setLastScanTimestamp] = useState<number>(0);
  const [candleRevision, setCandleRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);

  const [waStatus, setWaStatus] = useState<WhatsAppProviderStatus>({
    configured: false,
    provider: null,
    recipientMasked: null,
    missingFields: ['Checking server configuration...']
  });
  const [waLogs, setWaLogs] = useState<WhatsAppSignalRecord[]>([]);

  const activeTrackedSignalsRef = useRef<Map<string, SignalHistoryEntry>>(new Map());

  const playChime = useCallback(() => {
    if (!settings.soundAlerts) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    } catch {
      // audio blocked by the browser
    }
  }, [settings.soundAlerts]);

  const refreshWaStatus = useCallback(async () => {
    const status = await waService.getStatus();
    setWaStatus(status);
  }, [waService]);

  const handleUpdateSettings = (next: ScannerSettings) => {
    const normalized: ScannerSettings = {
      ...next,
      minScoreThreshold: Math.max(75, next.minScoreThreshold)
    };
    setSettings(normalized);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
    telemetry.settingsChanged();
    if (normalized.appId !== settings.appId) {
      wsManager.updateAppId(normalized.appId);
    }
  };

  const dispatchWhatsAppAlert = useCallback(
    async (opp: OpportunitySignal, eventType: 'NEW_SIGNAL' | 'MATERIAL_UPDATE' | 'INVALIDATED') => {
      const record = await waService.sendSignal(opp, eventType);
      setWaLogs((prev) => [record, ...prev].slice(0, 100));
      await storage.saveWhatsAppLog(record).catch(() => {});
    },
    [waService, storage]
  );

  // Initialize storage, WhatsApp status and the WebSocket event streams.
  useEffect(() => {
    storage.init().then(async () => {
      const [logs, hist] = await Promise.all([
        storage.getWhatsAppLogs().catch(() => []),
        storage.getSignalHistory().catch(() => [])
      ]);
      setWaLogs(logs);
      for (const item of hist) {
        if (item.outcomeStatus === 'ACTIVE') {
          activeTrackedSignalsRef.current.set(item.symbol, item);
        }
      }
    });

    refreshWaStatus();

    // Client telemetry: start the batched sender for this page load.
    telemetry.start();

    // Load the customer's account balances (DEMO + REAL kept separate).
    void refreshBalances();

    const connHandler = (state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => {
      setConnectionState(state);
      // Revalidate balances when the feed reconnects: a fresh connection is a
      // natural point to confirm the account authorization still holds.
      if (state === 'CONNECTED') onReconnect();
    };
    wsManager.onConnectionChange(connHandler);

    const tickHandler = (symbol: string, tick: { epoch: number; quote: number }) => {
      setSymbols((prev) =>
        prev.map((s) =>
          s.symbol === symbol
            ? { ...s, lastQuote: tick.quote, lastTickEpoch: tick.epoch, isStale: false }
            : s
        )
      );

      // Resolve tracked signals on live price: target hit vs structural invalidation.
      const activeSig = activeTrackedSignalsRef.current.get(symbol);
      if (activeSig && activeSig.takeProfit && activeSig.invalidationLevel) {
        let resolved: 'TP_HIT' | 'INVALIDATED' | null = null;
        if (activeSig.direction === 'BULLISH') {
          if (tick.quote >= activeSig.takeProfit) resolved = 'TP_HIT';
          else if (tick.quote <= activeSig.invalidationLevel) resolved = 'INVALIDATED';
        } else if (activeSig.direction === 'BEARISH') {
          if (tick.quote <= activeSig.takeProfit) resolved = 'TP_HIT';
          else if (tick.quote >= activeSig.invalidationLevel) resolved = 'INVALIDATED';
        }
        if (resolved) {
          const updated: SignalHistoryEntry = {
            ...activeSig,
            outcomeStatus: resolved,
            resolvedEpoch: tick.epoch,
            resolvedPrice: tick.quote
          };
          activeTrackedSignalsRef.current.delete(symbol);
          storage
            .saveSignalHistory(updated)
            .then(() => setHistoryRevision((r) => r + 1))
            .catch(() => {});
        }
      }
    };
    wsManager.onTick(tickHandler);

    const healthTimer = setInterval(() => {
      const discovered = wsManager.getDiscoveredSymbols();
      if (discovered.length > 0) {
        setSymbols(discovered);
        setSelectedSymbol((cur) =>
          discovered.some((s) => s.symbol === cur) ? cur : discovered[0].symbol
        );
      }
    }, 1500);

    return () => {
      clearInterval(healthTimer);
      wsManager.offTick(tickHandler);
      wsManager.offConnectionChange(connHandler);
      wsManager.destroy();
      telemetry.stop();
    };
  }, [wsManager, storage, refreshWaStatus]);

  // Top-down H4 → H1 → M15 → M5 → M1 analysis for a single symbol.
  const scanMarket = useCallback(
    async (symbol: string) => {
      const symStore = wsManager.candles.get(symbol);
      if (!symStore) return;

      const symInfo = wsManager.activeSymbols.get(symbol);
      if (!symInfo) return;

      const c4h = symStore.get('4h') || [];
      const c1h = symStore.get('1h') || [];
      const c15m = symStore.get('15m') || [];
      const c5m = symStore.get('5m') || [];
      const c1m = symStore.get('1m') || [];

      const opportunity = OpportunityScoringEngine.analyzeTopDown({
        symbolInfo: symInfo,
        c4h,
        c1h,
        c15m,
        c5m,
        c1m,
        minScoreThreshold: settings.minScoreThreshold,
        fvgMinDisplacement: settings.fvgMinDisplacement
      });

      if (!opportunity) return;

      setOpportunities((prev) => {
        const next = new Map(prev);
        const old = next.get(symbol);
        if (
          opportunity.setupTier === 'HIGH_QUALITY' &&
          (!old || old.setupTier !== 'HIGH_QUALITY')
        ) {
          playChime();
          telemetry.signal(opportunity.symbol, selectedTimeframe, opportunity.score.total);
          const histEntry: SignalHistoryEntry = {
            id: opportunity.id,
            symbol: opportunity.symbol,
            displayName: opportunity.displayName,
            is1s: opportunity.is1s,
            detectedEpoch: opportunity.detectedEpoch,
            direction: opportunity.direction,
            riseFallLabel: opportunity.riseFallLabel,
            selectedStrategy: opportunity.selectedStrategy.label,
            confluenceScore: opportunity.score.total,
            setupTier: opportunity.setupTier,
            marketCondition: opportunity.marketCondition,
            entryPrice: opportunity.entryAndTp.entryPrice,
            takeProfit: opportunity.entryAndTp.takeProfit,
            invalidationLevel: opportunity.entryAndTp.invalidationLevel,
            outcomeStatus: 'ACTIVE',
            explanation: opportunity.explanation
          };
          activeTrackedSignalsRef.current.set(symbol, histEntry);
          storage
            .saveSignalHistory(histEntry)
            .then(() => setHistoryRevision((r) => r + 1))
            .catch(() => {});
        }
        next.set(symbol, opportunity);
        return next;
      });

      if (settings.whatsappAutoSend && waStatus.configured) {
        const event = waService.evaluateDispatchEvent(
          opportunity,
          settings.minScoreThreshold,
          settings.whatsappNotifyUpdates
        );
        if (event) {
          await dispatchWhatsAppAlert(opportunity, event);
        }
      }
    },
    [
      wsManager,
      settings.minScoreThreshold,
      settings.fvgMinDisplacement,
      settings.whatsappAutoSend,
      settings.whatsappNotifyUpdates,
      waStatus.configured,
      waService,
      storage,
      playChime,
      dispatchWhatsAppAlert,
      selectedTimeframe
    ]
  );

  const scanAllMarkets = useCallback(async () => {
    if (isScanning || symbols.length === 0) return;
    setIsScanning(true);
    setLastScanTimestamp(Date.now());
    const openSymbols = symbols.filter((s) => s.isOpen);
    telemetry.setScanning(true, openSymbols.map((s) => s.symbol), [selectedTimeframe]);
    try {
      await Promise.allSettled(openSymbols.map((s) => scanMarket(s.symbol)));
    } finally {
      setIsScanning(false);
      telemetry.setScanning(false, openSymbols.map((s) => s.symbol), [selectedTimeframe]);
    }
  }, [symbols, isScanning, scanMarket, selectedTimeframe]);

  useEffect(() => {
    const interval = setInterval(() => {
      scanAllMarkets();
    }, settings.autoRefreshIntervalSec * 1000);
    return () => clearInterval(interval);
  }, [settings.autoRefreshIntervalSec, scanAllMarkets]);

  useEffect(() => {
    const candleHandler = (symbol: string, tf: Timeframe, _c: any, isClosed: boolean) => {
      if (symbol === selectedSymbol && tf === selectedTimeframe) {
        setCandleRevision((r) => r + 1);
      }
      if ((tf === '1m' || tf === '5m') && isClosed) {
        scanMarket(symbol);
      }
    };
    wsManager.onCandle(candleHandler);
    return () => wsManager.offCandle(candleHandler);
  }, [wsManager, scanMarket, selectedSymbol, selectedTimeframe]);

  const activeCandles = useMemo(() => {
    const symMap = wsManager.candles.get(selectedSymbol);
    if (!symMap) return [];
    return [...(symMap.get(selectedTimeframe) || [])];
  }, [wsManager, selectedSymbol, selectedTimeframe, candleRevision]);

  const activeSymbolInfo = symbols.find((s) => s.symbol === selectedSymbol);
  const activeOpp = opportunities.get(selectedSymbol);

  const plainSymbols = useMemo(() => symbols.filter((s) => !s.is1s), [symbols]);
  const oneSecSymbols = useMemo(() => symbols.filter((s) => s.is1s), [symbols]);
  const oppList = useMemo(() => Array.from(opportunities.values()), [opportunities]);
  const confirmedCount = useMemo(
    () => oppList.filter((o) => o.setupTier === 'HIGH_QUALITY' && o.entryAndTp.confirmed).length,
    [oppList]
  );

  const handleSelectSymbol = useCallback(
    (sym: string, targetTab?: 'LIVE_CHART' | 'ANALYSIS') => {
      setSelectedSymbol(sym);
      if (targetTab) setRoute(targetTab);
    },
    []
  );

  return (
    <AppShell
      activeRoute={route}
      onNavigate={setRoute}
      connectionState={connectionState}
      isScanning={isScanning}
      onScanAll={scanAllMarkets}
      scanDisabled={symbols.length === 0}
      signalBadge={confirmedCount}
      lastTickAt={activeSymbolInfo?.lastTickEpoch ? activeSymbolInfo.lastTickEpoch * 1000 : null}
    >
      {route === 'BEST_MARKET' && (
        <BestMarketView
          symbols={symbols}
          opportunities={opportunities}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={(sym, goTo) => handleSelectSymbol(sym, goTo)}
        />
      )}

      {route === 'STRATEGY_SCANNER' && (
        <StrategyScannerView
          symbols={symbols}
          opportunities={opportunities}
          selectedSymbol={selectedSymbol}
          isScanning={isScanning}
          storage={storage}
          historyRevision={historyRevision}
          onScanAll={scanAllMarkets}
          onSelectSymbol={(sym, goTo) => handleSelectSymbol(sym, goTo)}
          onSendWhatsApp={(opp) => dispatchWhatsAppAlert(opp, 'NEW_SIGNAL')}
        />
      )}

      {route === 'MTF_ENTRY' && (
        <MtfPrecisionEntryView
          symbols={symbols}
          opportunities={opportunities}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={(sym, goTo) => handleSelectSymbol(sym, goTo)}
          wsManager={wsManager}
        />
      )}

      {route === 'PLAIN_INDICES' && (
        <LiveMarketScannerTable
          title="Plain Volatility Indices"
          subtitle="Standard Deriv volatility indices only (Jump, Step, Boom & Crash excluded)."
          symbols={plainSymbols}
          opportunities={opportunities}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={(sym, openChart) =>
            handleSelectSymbol(sym, openChart ? 'LIVE_CHART' : undefined)
          }
        />
      )}

      {route === 'VOLATILITY_1S' && (
        <LiveMarketScannerTable
          title="Volatility 1-Second Indices"
          subtitle="High-frequency one-second Deriv volatility indices analysed separately from standard markets."
          symbols={oneSecSymbols}
          opportunities={opportunities}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={(sym, openChart) =>
            handleSelectSymbol(sym, openChart ? 'LIVE_CHART' : undefined)
          }
        />
      )}

      {route === 'LIVE_CHART' && (
        <TradingWorkspace
          symbols={symbols}
          opportunities={opportunities}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={setSelectedSymbol}
          selectedTimeframe={selectedTimeframe}
          onSelectTimeframe={setSelectedTimeframe}
          candles={activeCandles}
          activeSymbolInfo={activeSymbolInfo}
          activeOpp={activeOpp}
          connectionState={connectionState}
          waStatus={waStatus}
          alertsAutoSend={settings.whatsappAutoSend}
          onOpenAnalysis={() => setRoute('ANALYSIS')}
        />
      )}

      {route === 'ANALYSIS' && (
        <div className="space-y-4">
          <SectionTitle
            eyebrow="Instrument analysis"
            title={activeSymbolInfo?.displayName || selectedSymbol}
            description="Top-down H4 → H1 → M15 → M5 → M1 strategy breakdown"
            actions={
              <div className="flex items-center gap-2">
                <select
                  value={selectedSymbol}
                  onChange={(e) => setSelectedSymbol(e.target.value)}
                  className="h-9 rounded-[10px] border border-line bg-surface-deepest px-3 text-[13px] text-fg-1 focus:border-accent focus:outline-none"
                >
                  {symbols.map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.displayName} ({s.is1s ? '1s' : 'Plain'})
                    </option>
                  ))}
                </select>
              </div>
            }
          />
          {activeOpp ? (
            <OpportunityCard
              opp={activeOpp}
              onOpenChart={(sym) => handleSelectSymbol(sym, 'LIVE_CHART')}
              onSendWhatsApp={(opp) => dispatchWhatsAppAlert(opp, 'NEW_SIGNAL')}
            />
          ) : (
            <Card>
              <EmptyState
                icon={<LineChart className="h-5 w-5" />}
                title="Gathering multi-timeframe history"
                description={`Building H4 → M1 candle buffers for ${selectedSymbol}. Analysis appears once enough history has streamed in.`}
              />
            </Card>
          )}
        </div>
      )}

      {route === 'SIGNALS' && (
        <SignalsView
          opportunities={oppList}
          waStatus={waStatus}
          waLogs={waLogs}
          waService={waService}
          onRefreshStatus={refreshWaStatus}
          onManualDispatch={(opp) => dispatchWhatsAppAlert(opp, 'NEW_SIGNAL')}
          onOpenChart={(sym) => handleSelectSymbol(sym, 'LIVE_CHART')}
        />
      )}

      {route === 'HISTORY' && <PerformanceDashboard storage={storage} />}

      {route === 'SETTINGS' && (
        <SettingsView
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onReconnectWs={() => wsManager.reconnect()}
          waStatus={waStatus}
          onRefreshWaStatus={refreshWaStatus}
        />
      )}
    </AppShell>
  );
}

