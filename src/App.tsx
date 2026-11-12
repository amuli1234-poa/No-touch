import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { DerivWebSocketManager } from './services/DerivWebSocketManager';
import { IndexedDbStorage } from './services/IndexedDbStorage';
import { PathSettlementTracker, ActiveObservedContract } from './services/PathSettlementTracker';
import { MarketStructureEngine } from './engines/MarketStructureEngine';
import { SupportResistanceEngine } from './engines/SupportResistanceEngine';
import { CandlestickEngine } from './engines/CandlestickEngine';
import { FvgEngine } from './engines/FvgEngine';
import { MarketShiftEngine } from './engines/MarketShiftEngine';
import { TradeableRangeEngine } from './engines/TradeableRangeEngine';
import { AdaptiveBarrierEngine } from './engines/AdaptiveBarrierEngine';
import { DualExpiryEngine } from './engines/DualExpiryEngine';
import { OpportunityScoringEngine } from './engines/OpportunityScoringEngine';
import { AppShell } from './components/shell/AppShell';
import { Route } from './components/shell/navigation';
import { OverviewPage } from './components/pages/OverviewPage';
import { ScannerPage } from './components/pages/ScannerPage';
import { AnalysisPage } from './components/pages/AnalysisPage';
import { PerformancePage } from './components/pages/PerformancePage';
import { SettingsPage } from './components/pages/SettingsPage';
import { ActiveSymbol, OpportunitySignal, ScannerSettings, Timeframe, PerformanceRecord } from './types/scanner';
import { DEFAULT_DISPLAY_PREFERENCES, DisplayPreferences } from './types/preferences';
import { ScannerFilter } from './components/LiveMarketScannerTable';

const SETTINGS_KEY = 'deriv_scanner_settings_v4';
const DISPLAY_KEY = 'deriv_scanner_display_v4';

const DEFAULT_SETTINGS: ScannerSettings = {
  appId: 1089,
  expiryMode: 'AUTO',
  fixedDurationMinutes: 5,
  minScoreThreshold: 90,
  fvgMinDisplacement: 0.0003,
  filterMarket: 'ALL',
  autoRefreshIntervalSec: 10,
  soundAlerts: true
};

export default function App() {
  const [settings, setSettings] = useState<ScannerSettings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [display, setDisplay] = useState<DisplayPreferences>(() => {
    try {
      const saved = localStorage.getItem(DISPLAY_KEY);
      return saved ? { ...DEFAULT_DISPLAY_PREFERENCES, ...JSON.parse(saved) } : DEFAULT_DISPLAY_PREFERENCES;
    } catch {
      return DEFAULT_DISPLAY_PREFERENCES;
    }
  });

  const [wsManager] = useState(() => new DerivWebSocketManager(settings.appId));
  const [storage] = useState(() => new IndexedDbStorage());
  const [tracker] = useState(() => new PathSettlementTracker(wsManager, storage));

  const [connectionState, setConnectionState] = useState<'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING'>('RECONNECTING');
  const [symbols, setSymbols] = useState<ActiveSymbol[]>(() => wsManager.getDiscoveredSymbols());
  const [selectedSymbol, setSelectedSymbol] = useState<string>('R_100');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>(display.defaultTimeframe);
  const [route, setRoute] = useState<Route>('SCANNER');
  const [showLanding, setShowLanding] = useState(false);
  const [filterMode, setFilterMode] = useState<ScannerFilter>('ALL');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [opportunities, setOpportunities] = useState<Map<string, OpportunitySignal>>(new Map());
  const [activeMonitored, setActiveMonitored] = useState<ActiveObservedContract[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTimestamp, setLastScanTimestamp] = useState<number>(0);
  const [totalScans, setTotalScans] = useState<number>(0);
  const [candleVersion, setCandleVersion] = useState(0);

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
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    } catch {
      // audio disabled or blocked by the browser
    }
  }, [settings.soundAlerts]);

  const handleUpdateSettings = (newSettings: ScannerSettings) => {
    setSettings(newSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
    if (newSettings.appId !== settings.appId) {
      wsManager.updateAppId(newSettings.appId);
    }
  };

  const handleUpdateDisplay = (prefs: DisplayPreferences) => {
    setDisplay(prefs);
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(prefs));
    setSelectedTimeframe(prefs.defaultTimeframe);
  };

  // 1. Initialize storage and subscribe to feed / tracker events
  useEffect(() => {
    storage.init();

    const connHandler = (state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => {
      setConnectionState(state);
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
    };
    wsManager.onTick(tickHandler);

    tracker.onUpdate((list) => {
      setActiveMonitored(list);
    });

    tracker.setOnSettledCallback((record: PerformanceRecord) => {
      console.log('Contract settled:', record.symbol, record.contractSettledWon ? 'WIN' : 'LOSS');
    });

    const checkInterval = setInterval(() => {
      const discovered = wsManager.getDiscoveredSymbols();
      if (discovered.length > 0) {
        setSymbols(discovered);
        if (!discovered.some((s) => s.symbol === selectedSymbol)) {
          setSelectedSymbol(discovered[0].symbol);
        }
      }
    }, 1500);

    return () => {
      clearInterval(checkInterval);
      wsManager.offTick(tickHandler);
      wsManager.offConnectionChange(connHandler);
      wsManager.destroy();
    };
  }, [wsManager, storage, tracker]);

  // 2. Analytical scanning pipeline for a single symbol (engine logic unchanged)
  const scanMarket = useCallback(
    async (symbol: string) => {
      const symStore = wsManager.candles.get(symbol);
      if (!symStore) return;

      const c2m = symStore.get('2m') || [];
      const c5m = symStore.get('5m') || [];
      if (c2m.length < 15 || c5m.length < 10) return;

      const currentPrice = c2m[c2m.length - 1].close;
      const symInfo = symbols.find((s) => s.symbol === symbol) || wsManager.activeSymbols.get(symbol);

      const pivots5m = MarketStructureEngine.findPivots(c5m, 3, 3);
      const pivots2m = MarketStructureEngine.findPivots(c2m, 3, 3);
      const { sweeps: sweeps2m } = MarketStructureEngine.evaluateLiquiditySweeps(c2m, pivots2m);
      const zones5m = SupportResistanceEngine.mapZones(c5m, pivots5m, '5m');

      const tf5mBias = MarketStructureEngine.getDirectionalBias(pivots5m, currentPrice);

      const latest2m = c2m[c2m.length - 1];
      const prior2m_1 = c2m.length >= 2 ? c2m[c2m.length - 2] : undefined;
      const prior2m_2 = c2m.length >= 3 ? c2m[c2m.length - 3] : undefined;
      const reversalSignal = CandlestickEngine.evaluate(latest2m, prior2m_1, prior2m_2);

      const shifts2m = MarketStructureEngine.detectStructuralShifts(c2m, pivots2m);
      const activeShift = shifts2m.length > 0 ? shifts2m[shifts2m.length - 1] : null;

      const fvgs2m = FvgEngine.scan(c2m, '2m', settings.fvgMinDisplacement);
      const activeFvg = fvgs2m.length > 0 ? fvgs2m[fvgs2m.length - 1] : null;

      let candidateDir = reversalSignal.direction !== 'NEUTRAL'
        ? reversalSignal.direction
        : activeShift
        ? activeShift.direction
        : tf5mBias;

      if (candidateDir === 'NEUTRAL' && sweeps2m.length > 0) {
        candidateDir = sweeps2m[sweeps2m.length - 1].type === 'SELLSIDE' ? 'BULLISH' : 'BEARISH';
      }

      const shiftValidation = MarketShiftEngine.validate(
        candidateDir,
        zones5m,
        sweeps2m,
        reversalSignal,
        shifts2m,
        fvgs2m,
        currentPrice
      );

      const atr = AdaptiveBarrierEngine.calculateATR(c2m, 14);
      const atrRatio = atr / currentPrice;
      const volRegime: 'LOW' | 'MEDIUM' | 'HIGH' =
        atrRatio > 0.0035 ? 'HIGH' : atrRatio > 0.0018 ? 'MEDIUM' : 'LOW';

      let tradeableRange = null;
      if (pivots2m.length >= 2 && activeFvg) {
        const sweptPivot = pivots2m[pivots2m.length - 2];
        const displacementPivot = pivots2m[pivots2m.length - 1];
        tradeableRange = TradeableRangeEngine.calculate(
          candidateDir,
          sweptPivot,
          displacementPivot,
          activeFvg,
          currentPrice,
          volRegime,
          tf5mBias === candidateDir
        );
      }

      let barrierProposal = null;
      if (tradeableRange && tradeableRange.isRetracementValid) {
        if (settings.expiryMode === 'AUTO') {
          const autoEval = await DualExpiryEngine.determineAutoExpiry(
            symbol,
            currentPrice,
            candidateDir,
            tradeableRange,
            c2m,
            wsManager
          );
          barrierProposal = autoEval.recommended?.barrierProposal || null;
        } else {
          barrierProposal = await AdaptiveBarrierEngine.evaluateBestBarrier(
            symbol,
            currentPrice,
            candidateDir,
            tradeableRange,
            c2m,
            wsManager,
            settings.fixedDurationMinutes
          );
        }
      }

      const relevantSweep = sweeps2m.find(
        (s) =>
          (candidateDir === 'BULLISH' && s.type === 'SELLSIDE') ||
          (candidateDir === 'BEARISH' && s.type === 'BUYSIDE')
      );

      const { breakdown, status, rejectionReasons, explanation } =
        OpportunityScoringEngine.evaluateScore(
          tf5mBias,
          candidateDir,
          !!relevantSweep,
          tradeableRange !== null && tradeableRange.isRetracementValid,
          reversalSignal,
          activeShift,
          activeFvg,
          tradeableRange,
          barrierProposal,
          settings.minScoreThreshold
        );

      const opportunity: OpportunitySignal = {
        id: `${symbol}_${Date.now()}`,
        symbol,
        displayName: symInfo ? symInfo.displayName : symbol,
        is1s: symInfo ? symInfo.is1s : false,
        currentPrice,
        status,
        detectedEpoch: Math.floor(Date.now() / 1000),
        direction: candidateDir,
        score: breakdown,
        barrierProposal: barrierProposal || undefined,
        tradeableRange: tradeableRange || undefined,
        activeFvg: activeFvg || undefined,
        reversalPattern: reversalSignal,
        marketShift: activeShift || undefined,
        sweptPool: relevantSweep,
        stepAudit: shiftValidation.auditItems,
        rejectionReasons,
        explanation,
        volatilityRegime: volRegime,
        atr
      };

      setOpportunities((prev) => {
        const next = new Map(prev);
        const old = next.get(symbol);
        if (opportunity.status === 'QUALIFIED' && (!old || old.status !== 'QUALIFIED')) {
          playChime();
          tracker.registerContract(opportunity);
        }
        next.set(symbol, opportunity);
        return next;
      });

      if (opportunity.status === 'QUALIFIED') {
        storage.saveOpportunity(opportunity);
      }
    },
    [wsManager, symbols, settings, storage, tracker, playChime]
  );

  // 3. Scan all active symbols concurrently
  const scanAllMarkets = useCallback(async () => {
    if (isScanning || symbols.length === 0) return;
    setIsScanning(true);
    setLastScanTimestamp(Date.now());
    setTotalScans((n) => n + 1);

    try {
      const openSymbols = symbols.filter((s) => s.isOpen);
      const selectedMarkets = openSymbols.filter(
        (s) =>
          settings.filterMarket === 'ALL' ||
          (settings.filterMarket === '1S' ? s.is1s : !s.is1s)
      );
      await Promise.allSettled(selectedMarkets.map((s) => scanMarket(s.symbol)));
    } finally {
      setIsScanning(false);
    }
  }, [symbols, isScanning, scanMarket, settings.filterMarket]);

  // Automatic interval-based re-scan
  useEffect(() => {
    const interval = setInterval(() => {
      scanAllMarkets();
    }, settings.autoRefreshIntervalSec * 1000);
    return () => clearInterval(interval);
  }, [settings.autoRefreshIntervalSec, scanAllMarkets]);

  // Trigger instant scan when a 2m candle closes on a market
  useEffect(() => {
    const candleHandler = (symbol: string, tf: Timeframe, _c: any, isClosed: boolean) => {
      if (tf === '2m' && isClosed) {
        scanMarket(symbol);
      }
    };
    wsManager.onCandle(candleHandler);
    return () => wsManager.offCandle(candleHandler);
  }, [wsManager, scanMarket]);

  // Chart buffers are mutated in place by the feed, so a low-frequency version
  // counter drives re-derivation and hands the chart a fresh array reference.
  useEffect(() => {
    const interval = setInterval(() => setCandleVersion((v) => v + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const activeCandles = useMemo(() => {
    const symMap = wsManager.candles.get(selectedSymbol);
    if (!symMap) return [];
    const list = symMap.get(selectedTimeframe) || [];
    return list.slice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsManager, selectedSymbol, selectedTimeframe, candleVersion]);

  const activeOpp = opportunities.get(selectedSymbol);

  const handleOpenAnalysis = useCallback((symbol: string) => {
    setSelectedSymbol(symbol);
    setRoute('ANALYSIS');
  }, []);

  if (showLanding) {
    return (
      <OverviewPage
        onEnterScanner={() => setShowLanding(false)}
        connectionState={connectionState}
        symbolCount={symbols.length}
      />
    );
  }

  return (
    <AppShell
      activeRoute={route}
      onNavigate={setRoute}
      onNavigateOverview={() => setShowLanding(true)}
      connectionState={connectionState}
      lastScanTimestamp={lastScanTimestamp}
      isScanning={isScanning}
      onScanAll={scanAllMarkets}
      scanDisabled={symbols.length === 0}
      mobileNavOpen={mobileNavOpen}
      onOpenMobileNav={() => setMobileNavOpen(true)}
      onCloseMobileNav={() => setMobileNavOpen(false)}
    >
      {route === 'SCANNER' && (
        <ScannerPage
          symbols={symbols}
          opportunities={opportunities}
          activeMonitored={display.showPathMonitor ? activeMonitored : []}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={setSelectedSymbol}
          filterMode={filterMode}
          onFilterChange={setFilterMode}
          selectedTimeframe={selectedTimeframe}
          onTimeframeChange={setSelectedTimeframe}
          activeCandles={activeCandles}
          isScanning={isScanning}
          lastScanTimestamp={lastScanTimestamp}
          connectionState={connectionState}
          onOpenAnalysis={handleOpenAnalysis}
          density={display.density}
        />
      )}

      {route === 'ANALYSIS' && (
        <AnalysisPage
          symbols={symbols}
          opportunities={opportunities}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={setSelectedSymbol}
          selectedTimeframe={selectedTimeframe}
          onTimeframeChange={setSelectedTimeframe}
          activeCandles={activeCandles}
        />
      )}

      {route === 'PERFORMANCE' && (
        <PerformancePage
          storage={storage}
          opportunities={opportunities}
          totalScans={totalScans}
          lastScanTimestamp={lastScanTimestamp}
        />
      )}

      {route === 'SETTINGS' && (
        <SettingsPage
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          display={display}
          onUpdateDisplay={handleUpdateDisplay}
          onReconnectWs={() => wsManager.reconnect()}
          connectionState={connectionState}
          symbolCount={symbols.length}
        />
      )}
    </AppShell>
  );
}
