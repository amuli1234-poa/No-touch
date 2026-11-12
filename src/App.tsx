import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
import { InteractiveLightweightChart } from './components/InteractiveLightweightChart';
import { LiveMarketScannerTable } from './components/LiveMarketScannerTable';
import { OpportunityCard } from './components/OpportunityCard';
import { PerformanceDashboard } from './components/PerformanceDashboard';
import { ScannerSettingsModal } from './components/ScannerSettingsModal';
import {
  ActiveSymbol,
  OpportunitySignal,
  ScannerSettings,
  Timeframe,
  PerformanceRecord
} from './types/scanner';
import {
  Activity,
  Layers,
  Award,
  Sliders,
  ShieldCheck,
  Zap,
  RefreshCw,
  Sparkles,
  BarChart3
} from 'lucide-react';

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
      const saved = localStorage.getItem('deriv_scanner_settings_v4');
      return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [wsManager] = useState(() => new DerivWebSocketManager(settings.appId));
  const [storage] = useState(() => new IndexedDbStorage());
  const [tracker] = useState(() => new PathSettlementTracker(wsManager, storage));

  const [connectionState, setConnectionState] = useState<'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING'>('RECONNECTING');
  const [symbols, setSymbols] = useState<ActiveSymbol[]>(() => wsManager.getDiscoveredSymbols());
  const [selectedSymbol, setSelectedSymbol] = useState<string>('R_100');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('2m');
  const [activeTab, setActiveTab] = useState<'SCANNER' | 'ANALYSIS' | 'PERFORMANCE'>('SCANNER');
  const [showLanding, setShowLanding] = useState(false);
  const [filterMode, setFilterMode] = useState<'ALL' | 'STANDARD' | '1S' | 'QUALIFIED' | 'WATCHLIST'>('ALL');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [opportunities, setOpportunities] = useState<Map<string, OpportunitySignal>>(new Map());
  const [activeMonitored, setActiveMonitored] = useState<ActiveObservedContract[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTimestamp, setLastScanTimestamp] = useState<number>(0);

  // Web Audio Context for Chimes
  const playChime = useCallback(() => {
    if (!settings.soundAlerts) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    } catch {
      // audio disabled or blocked
    }
  }, [settings.soundAlerts]);

  // Save settings
  const handleUpdateSettings = (newSettings: ScannerSettings) => {
    setSettings(newSettings);
    localStorage.setItem('deriv_scanner_settings_v4', JSON.stringify(newSettings));
    if (newSettings.appId !== settings.appId) {
      wsManager.updateAppId(newSettings.appId);
    }
  };

  // 1. Initialize DB and Listeners
  useEffect(() => {
    storage.init();

    const connHandler = (state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => {
      setConnectionState(state);
    };
    wsManager.onConnectionChange(connHandler);

    // Listen to live ticks to update quotes smoothly
    const tickHandler = (symbol: string, tick: { epoch: number; quote: number }) => {
      setSymbols((prev) =>
        prev.map((s) => (s.symbol === symbol ? { ...s, lastQuote: tick.quote, lastTickEpoch: tick.epoch, isStale: false } : s))
      );
    };
    wsManager.onTick(tickHandler);

    // Track active monitored contracts
    tracker.onUpdate((list) => {
      setActiveMonitored(list);
    });

    // Handle contract settlement event
    tracker.setOnSettledCallback((record: PerformanceRecord) => {
      console.log('Contract Settled:', record.symbol, record.contractSettledWon ? 'WIN' : 'LOSS');
    });

    // Check symbol discovery
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

  // 2. Analytical Scanning Pipeline on a Symbol
  const scanMarket = useCallback(
    async (symbol: string) => {
      const symStore = wsManager.candles.get(symbol);
      if (!symStore) return;

      const c2m = symStore.get('2m') || [];
      const c5m = symStore.get('5m') || [];
      if (c2m.length < 15 || c5m.length < 10) return;

      const currentPrice = c2m[c2m.length - 1].close;
      const symInfo = symbols.find((s) => s.symbol === symbol) || wsManager.activeSymbols.get(symbol);

      // Phase 3 & 4: Market Structure & Support/Resistance
      const pivots5m = MarketStructureEngine.findPivots(c5m, 3, 3);
      const pivots2m = MarketStructureEngine.findPivots(c2m, 3, 3);
      const { sweeps: sweeps2m } = MarketStructureEngine.evaluateLiquiditySweeps(c2m, pivots2m);
      const zones5m = SupportResistanceEngine.mapZones(c5m, pivots5m, '5m');

      // 5m Directional Alignment
      const tf5mBias = MarketStructureEngine.getDirectionalBias(pivots5m, currentPrice);

      // Phase 4: Candlestick Reversals
      const latest2m = c2m[c2m.length - 1];
      const prior2m_1 = c2m.length >= 2 ? c2m[c2m.length - 2] : undefined;
      const prior2m_2 = c2m.length >= 3 ? c2m[c2m.length - 3] : undefined;
      const reversalSignal = CandlestickEngine.evaluate(latest2m, prior2m_1, prior2m_2);

      // Phase 5: Structural Shifts (CHoCH / BOS)
      const shifts2m = MarketStructureEngine.detectStructuralShifts(c2m, pivots2m);
      const activeShift = shifts2m.length > 0 ? shifts2m[shifts2m.length - 1] : null;

      // Phase 5: Fair Value Gaps
      const fvgs2m = FvgEngine.scan(c2m, '2m', settings.fvgMinDisplacement);
      const activeFvg = fvgs2m.length > 0 ? fvgs2m[fvgs2m.length - 1] : null;

      // Candidate Direction: determined by reversal or displacement shift
      let candidateDir = reversalSignal.direction !== 'NEUTRAL'
        ? reversalSignal.direction
        : activeShift
        ? activeShift.direction
        : tf5mBias;

      if (candidateDir === 'NEUTRAL' && sweeps2m.length > 0) {
        candidateDir = sweeps2m[sweeps2m.length - 1].type === 'SELLSIDE' ? 'BULLISH' : 'BEARISH';
      }

      // Phase 6: Market Shift 7-Step Sequence Validation
      const shiftValidation = MarketShiftEngine.validate(
        candidateDir,
        zones5m,
        sweeps2m,
        reversalSignal,
        shifts2m,
        fvgs2m,
        currentPrice
      );

      // Volatility & ATR
      const atr = AdaptiveBarrierEngine.calculateATR(c2m, 14);
      const atrRatio = atr / currentPrice;
      const volRegime: 'LOW' | 'MEDIUM' | 'HIGH' =
        atrRatio > 0.0035 ? 'HIGH' : atrRatio > 0.0018 ? 'MEDIUM' : 'LOW';

      // Phase 6: Tradeable Range & Protected Swing
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

      // Phase 7: Dual Expiry & Adaptive No Touch Barrier Proposal
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

      // Phase 8: Opportunity Scoring & Gating
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
        // If transitioning into QUALIFIED from other status, trigger sound chime and register with settlement tracker
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

    try {
      const openSymbols = symbols.filter((s) => s.isOpen);
          const selectedMarkets = openSymbols.filter((s) => settings.filterMarket === 'ALL' || (settings.filterMarket === '1S' ? s.is1s : !s.is1s));
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

  // Hook candle completion to trigger instant scan on that market
  useEffect(() => {
    const candleHandler = (symbol: string, tf: Timeframe, _c: any, isClosed: boolean) => {
      if (tf === '2m' && isClosed) {
        scanMarket(symbol);
      }
    };
    wsManager.onCandle(candleHandler);
    return () => wsManager.offCandle(candleHandler);
  }, [wsManager, scanMarket]);

  // Active Symbol Candle Buffer for Charting
  const activeCandles = useMemo(() => {
    const symMap = wsManager.candles.get(selectedSymbol);
    if (!symMap) return [];
    return symMap.get(selectedTimeframe) || [];
  }, [wsManager, selectedSymbol, selectedTimeframe]);

  const activeOpp = opportunities.get(selectedSymbol);

  // Aggregated Counters for SECTION A (OVERVIEW)
  const oppList = useMemo(() => Array.from(opportunities.values()), [opportunities]);
  const qualifiedList = useMemo(() => oppList.filter((o) => o.status === 'QUALIFIED'), [oppList]);
  const rejectedCount = useMemo(() => oppList.filter((o) => o.status === 'REJECTED').length, [oppList]);

  if (showLanding) {
    return (
      <div className="min-h-screen overflow-hidden bg-[#070b12] text-slate-100">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_70%_15%,rgba(8,145,178,0.16),transparent_38%),radial-gradient(ellipse_at_10%_45%,rgba(79,70,229,0.14),transparent_36%)]" />
        <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300"><Activity className="h-5 w-5" /></div>
            <div><div className="text-sm font-extrabold tracking-[0.14em] text-white">NORTHSTAR</div><div className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">Deriv market intelligence</div></div>
          </div>
          <button onClick={() => setShowLanding(false)} className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-cyan-400/40 hover:text-white">Open scanner <span className="ml-2 text-cyan-300">→</span></button>
        </header>

        <main className="relative z-10 mx-auto max-w-7xl px-6 pb-20 pt-10 lg:px-10 lg:pt-20">
          <section className="grid items-center gap-14 lg:grid-cols-[1fr_0.95fr]">
            <div className="max-w-2xl">
              <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-200"><span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> Synthetic market analysis workspace</div>
              <h1 className="text-5xl font-extrabold leading-[1.08] tracking-[-0.045em] text-white sm:text-6xl lg:text-7xl">See the market<br /><span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-indigo-300 bg-clip-text text-transparent">with more clarity.</span></h1>
              <p className="mt-7 max-w-xl text-base leading-7 text-slate-400 sm:text-lg">A focused workspace for monitoring Deriv synthetic indices, reading multi-timeframe structure, and reviewing No Touch setups as conditions develop.</p>
              <div className="mt-9 flex flex-wrap items-center gap-4">
                <button onClick={() => setShowLanding(false)} className="group inline-flex items-center gap-3 rounded-xl bg-cyan-400 px-5 py-3.5 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-950/40 transition hover:bg-cyan-300">Launch live scanner <span className="transition group-hover:translate-x-1">→</span></button>
                <span className="text-xs text-slate-500">Analysis tools for informed review</span>
              </div>
              <div className="mt-12 flex flex-wrap gap-x-8 gap-y-3 border-t border-slate-800/80 pt-6 text-xs text-slate-400"><span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-cyan-300" /> Structure-aware signals</span><span className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-indigo-300" /> Multi-timeframe context</span><span className="flex items-center gap-2"><Zap className="h-4 w-4 text-amber-300" /> Live market feed</span></div>
            </div>

            <div className="relative mx-auto w-full max-w-xl">
              <div className="absolute -inset-8 rounded-full bg-cyan-500/[0.08] blur-3xl" />
              <div className="relative rounded-2xl border border-slate-700/80 bg-[#0b111c]/95 p-4 shadow-2xl shadow-black/50 sm:p-5">
                <div className="flex items-center justify-between border-b border-slate-800 pb-4"><div><div className="text-xs font-bold text-white">MARKET OVERVIEW</div><div className="mt-1 text-[10px] text-slate-500">Scanner interface preview</div></div><div className="rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-semibold text-slate-400">SAMPLE VIEW</div></div>
                <div className="mt-4 grid grid-cols-3 gap-2.5">{[['MARKETS', '20'], ['QUALIFIED', '04'], ['WATCHLIST', '07']].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"><div className="text-[9px] font-semibold tracking-wider text-slate-500">{label}</div><div className="mt-1.5 font-mono text-xl font-bold text-white">{value}</div></div>)}</div>
                <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3.5 sm:p-4"><div className="flex items-center justify-between"><div><div className="text-xs font-bold text-slate-200">R_100 <span className="ml-1 font-normal text-slate-500">Volatility 100 Index</span></div><div className="mt-1 font-mono text-[10px] text-slate-500">2m structure · 5m confirmation</div></div><div className="text-right"><div className="font-mono text-sm font-bold text-white">8,426.18</div><div className="text-[10px] text-emerald-400">+0.42%</div></div></div>
                  <div className="relative mt-5 h-36 overflow-hidden rounded-lg bg-[#080d16] px-2 pt-4"><div className="absolute inset-x-2 top-1/2 border-t border-dashed border-slate-700/70" /><div className="absolute inset-x-2 top-[28%] border-t border-dashed border-cyan-400/40" /><div className="absolute right-2 top-[21%] rounded bg-cyan-400/10 px-1.5 py-0.5 text-[8px] text-cyan-300">BARRIER</div><div className="flex h-full items-end gap-1.5 px-1">{[33,45,40,57,49,62,54,70,61,75,65,81,72,88,76,94,82,90,73,85,68,79,62,72,58,70,55,65,48,60,52,69,58,76].map((height, index) => <div key={index} className={`w-full rounded-t-[2px] ${index % 5 === 1 ? 'bg-rose-400/70' : 'bg-cyan-400/70'}`} style={{ height: `${height}%` }} />)}</div></div>
                  <div className="mt-3 flex items-center justify-between rounded-lg border border-emerald-400/15 bg-emerald-400/[0.05] px-3 py-2.5"><div><div className="text-[9px] font-semibold tracking-wider text-slate-500">SIGNAL STATUS</div><div className="mt-0.5 text-xs font-bold text-emerald-300">Setup under review</div></div><div className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 font-mono text-xs font-bold text-emerald-300">92%</div></div>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-24 grid gap-4 border-t border-slate-800/80 pt-8 sm:grid-cols-3">
            {[['01', 'Read the structure', 'Combine market pivots, liquidity sweeps, and directional context in one view.'], ['02', 'Review the setup', 'Inspect barrier proposals alongside the price chart and signal rationale.'], ['03', 'Track outcomes', 'Follow observed paths and review historical scanner performance.']].map(([number, title, description]) => <article key={number} className="rounded-xl border border-slate-800/80 bg-slate-900/30 p-5"><div className="font-mono text-[10px] text-cyan-300">{number}</div><h2 className="mt-3 text-sm font-bold text-white">{title}</h2><p className="mt-2 text-xs leading-5 text-slate-400">{description}</p></article>)}
          </section>
          <footer className="mt-14 flex flex-col gap-3 border-t border-slate-800/70 pt-6 text-[11px] text-slate-500 sm:flex-row sm:items-center sm:justify-between"><span>Market analysis workspace · Deriv synthetic indices</span><span>Signals are analytical observations and are not guarantees of outcome.</span></footer>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30">
      {/* Top Main Navigation Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center space-x-3.5">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div
              className={`w-2.5 h-2.5 rounded-full absolute -bottom-0.5 -right-0.5 ring-2 ring-slate-900 ${
                connectionState === 'CONNECTED'
                  ? 'bg-emerald-500 animate-pulse'
                  : connectionState === 'RECONNECTING'
                  ? 'bg-amber-500'
                  : 'bg-rose-500'
              }`}
            />
          </div>

          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-base font-extrabold tracking-tight text-white">
                DERIV MARKET INTELLIGENCE
              </h1>
              <span className="text-[10px] font-mono font-bold bg-indigo-950 text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-700/60">
                v4.0 PRO
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-mono">
              2m Displacement & 5m Alignment Imbalance Engine
            </p>
          </div>
        </div>

        {/* Center / Right Tools */}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowLanding(true)} className="px-2 py-1.5 text-xs font-semibold text-slate-400 transition hover:text-white">Overview</button>
          {/* Main Tab Switcher */}
          <div className="bg-slate-950/80 p-1 rounded-xl border border-slate-800 flex flex-wrap items-center gap-1">
            <button
              onClick={() => setActiveTab('SCANNER')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeTab === 'SCANNER'
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Live Scanner</span>
            </button>

            <button onClick={() => setActiveTab('ANALYSIS')} className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${activeTab === 'ANALYSIS' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30' : 'text-slate-400 hover:text-white'}`}>
              <Activity className="w-3.5 h-3.5" /><span>Market Analysis</span>
            </button>
            <button
              onClick={() => setActiveTab('PERFORMANCE')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeTab === 'PERFORMANCE'
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Award className="w-3.5 h-3.5" />
              <span>Performance</span>
            </button>
          </div>

          {/* Quick Rescan Button */}
          <button
            onClick={scanAllMarkets}
            disabled={isScanning}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700/80 transition disabled:opacity-50"
            title="Scan all active markets concurrently"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-cyan-400' : ''}`} />
            <span>{isScanning ? 'Scanning...' : 'Scan All'}</span>
          </button>

          {/* Settings Trigger */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 transition"
            title="Configure Strategy & Connection"
          >
            <Sliders className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 p-4 md:p-6 space-y-6 max-w-[1760px] w-full mx-auto">
        {/* SECTION A: OVERVIEW SUMMARY BAR */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded-xl shadow-sm">
            <span className="text-[10px] font-mono uppercase text-slate-400 font-semibold block">
              Total Markets
            </span>
            <div className="text-2xl font-bold font-mono text-white mt-1">
              {symbols.length}
            </div>
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
              Active Deriv Synthetics
            </span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded-xl shadow-sm">
            <span className="text-[10px] font-mono uppercase text-emerald-400 font-semibold block flex items-center space-x-1">
              <ShieldCheck className="w-3 h-3" />
              <span>Qualified</span>
            </span>
            <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
              {qualifiedList.length}
            </div>
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
              Mandatory gates passed
            </span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded-xl shadow-sm">
            <span className="text-[10px] font-mono uppercase text-cyan-400 font-semibold block">Aligned Markets</span>
            <div className="text-2xl font-bold font-mono text-cyan-400 mt-1">{oppList.filter((o) => o.score.structureAlignment === 20).length}</div>
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">5m bias matches 2m structure</span>
          </div>
          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded-xl shadow-sm">
            <span className="text-[10px] font-mono uppercase text-rose-400 font-semibold block">Rejected Setups</span>
            <div className="text-2xl font-bold font-mono text-rose-400 mt-1">{rejectedCount}</div>
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">Current scan results</span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded-xl shadow-sm">
            <span className="text-[10px] font-mono uppercase text-slate-400 font-semibold block">Last Scan</span>
            <div className="text-lg font-bold font-mono text-cyan-300 mt-2">{lastScanTimestamp ? new Date(lastScanTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not scanned'}</div>
            <span className={`text-[10px] font-mono mt-0.5 block ${connectionState === 'CONNECTED' ? 'text-emerald-400' : 'text-amber-400'}`}>Feed {connectionState.toLowerCase()}</span>
          </div>
        </section>

        {/* SCANNER VIEW */}
        {activeTab === 'SCANNER' && (
          <div className="space-y-6">
            {/* Live Active Monitored Excursions Strip (If any qualified opportunity is in-flight) */}
            {activeMonitored.length > 0 && (
              <div className="p-3.5 rounded-xl bg-indigo-950/40 border border-indigo-800/50 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-indigo-300 font-bold flex items-center space-x-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                    <span>IN-FLIGHT LIVE TICK PATH MONITOR ({activeMonitored.length} CONTRACTS)</span>
                  </span>
                  <span className="text-slate-400 text-[11px]">
                    Verifying continuous path excursion survival against real ticks
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {activeMonitored.map((c) => {
                    const remainingSec = Math.max(0, c.expiryEpoch - Math.floor(Date.now() / 1000));
                    return (
                      <div
                        key={c.id}
                        className={`p-3 rounded-lg border font-mono text-xs ${
                          c.hasTouched
                            ? 'bg-rose-950/40 border-rose-800 text-rose-300'
                            : 'bg-slate-900/90 border-slate-800 text-slate-200'
                        }`}
                      >
                        <div className="flex justify-between items-center font-bold">
                          <span>{c.displayName}</span>
                          <span className={c.hasTouched ? 'text-rose-400' : 'text-emerald-400'}>
                            {c.hasTouched ? 'TOUCHED (LOST)' : 'SURVIVING'}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1 flex justify-between">
                          <span>Barrier: {c.barrierLevel.toFixed(3)} ({c.barrierDirection})</span>
                          <span>{remainingSec}s left</span>
                        </div>
                        <div className="text-[11px] text-slate-400 flex justify-between mt-0.5">
                          <span>Distance: {c.currentDistance.toFixed(3)} pts</span>
                          <span className="text-cyan-400 font-semibold">${c.payout.toFixed(2)} payout</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Scanner table uses the full viewport width so all analysis columns remain readable. */}
            <div className="space-y-6">
              {/* SECTION B: LIVE MARKET SCANNER TABLE (5 Cols) */}
              <div className="w-full min-w-0">
                <LiveMarketScannerTable
                  symbols={symbols}
                  opportunities={opportunities}
                  selectedSymbol={selectedSymbol}
                  onSelectSymbol={(sym) => setSelectedSymbol(sym)}
                  filterMode={filterMode}
                  onFilterChange={setFilterMode}
                />
              </div>

              {/* SECTION D & C: CHART ANALYSIS & SELECTED SIGNAL CARD (7 Cols) */}
              <div className="w-full min-w-0 grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
                <div className="xl:col-span-8 space-y-5">
                {/* SECTION D: CHART ANALYSIS */}
                <div className="space-y-3">
                  {/* Timeframe Switcher & Chart Header */}
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                    <div className="flex items-center space-x-2">
                      <h2 className="text-sm font-bold text-white tracking-wide font-mono">
                        {selectedSymbol} CHART ANALYSIS
                      </h2>
                      <span className="text-[10px] text-slate-400 font-mono">
                        Primary 2m • Confirmation 5m
                      </span>
                    </div>

                    <div className="flex items-center space-x-1 bg-slate-900/80 p-1 rounded-lg border border-slate-800">
                      {(['1m', '2m', '5m', '15m', '1h'] as Timeframe[]).map((tf) => (
                        <button
                          key={tf}
                          onClick={() => setSelectedTimeframe(tf)}
                          className={`px-2.5 py-1 text-xs font-mono font-semibold rounded-md transition ${
                            selectedTimeframe === tf
                              ? 'bg-indigo-600 text-white'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>
                  </div>

                  <InteractiveLightweightChart
                    candles={activeCandles}
                    symbol={selectedSymbol}
                    timeframe={selectedTimeframe}
                    fvg={activeOpp?.activeFvg}
                    tradeableRange={activeOpp?.tradeableRange}
                    barrier={activeOpp?.barrierProposal}
                    structuralShift={activeOpp?.marketShift}
                    sweptPool={activeOpp?.sweptPool}
                  />
                </div>

                {/* SECTION C: DETAILED NO TOUCH OPPORTUNITY SIGNAL CARD */}
                {activeOpp && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono px-1">
                      Target Market Opportunity Analysis
                    </h3>
                    <OpportunityCard
                      opp={activeOpp}
                      onSelectMarket={(sym) => setSelectedSymbol(sym)}
                      isSelected={true}
                    />
                  </div>
                )}
                </div>
                <aside className="xl:col-span-4 rounded-xl border border-slate-800/80 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between"><div><div className="text-xs font-semibold text-white">Market context</div><div className="mt-1 text-[11px] text-slate-500">Deriv synthetic indices</div></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${connectionState === 'CONNECTED' ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'}`}>{connectionState}</span></div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-slate-500">5m alignment</div><div className="mt-1 font-semibold text-slate-100">{activeOpp?.score.structureAlignment === 20 ? 'Aligned' : activeOpp ? 'Divergent / neutral' : 'Awaiting data'}</div></div>
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-slate-500">2m shift</div><div className="mt-1 font-semibold text-slate-100">{activeOpp?.marketShift ? activeOpp.marketShift.type : 'No confirmed shift'}</div></div>
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-slate-500">Liquidity sweep</div><div className="mt-1 font-semibold text-slate-100">{activeOpp?.sweptPool ? `${activeOpp.sweptPool.type} swept` : 'Not detected'}</div></div>
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-slate-500">Fair value gap</div><div className="mt-1 font-semibold text-slate-100">{activeOpp?.activeFvg ? (activeOpp.activeFvg.fresh ? 'Fresh' : 'Mitigated') : 'Not detected'}</div></div>
                  </div>
                  {activeOpp && <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-500">Current setup</div><div className="mt-1 flex items-center justify-between"><span className="text-sm font-semibold text-white">{activeOpp.status}</span><span className="font-mono text-indigo-300">{activeOpp.score.total}/100</span></div><div className="mt-2 text-xs leading-relaxed text-slate-400">{activeOpp.explanation}</div></div>}
                </aside>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ANALYSIS' && (
          <section className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[11px] font-mono uppercase tracking-[.18em] text-indigo-300">Market workspace</p><h2 className="mt-1 text-xl font-bold text-white">{symbols.find((s) => s.symbol === selectedSymbol)?.displayName || selectedSymbol} analysis</h2><p className="mt-1 text-xs text-slate-400">2m displacement · 5m alignment · live market context</p></div><select value={selectedSymbol} onChange={(e) => setSelectedSymbol(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">{symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.displayName}</option>)}</select></div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3"><div className="text-xs text-slate-400">{activeOpp?.explanation || 'Analysis will populate as market candles arrive.'}</div><div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">{(['1m', '2m', '5m', '15m', '1h'] as Timeframe[]).map((tf) => <button key={tf} onClick={() => setSelectedTimeframe(tf)} className={`rounded-md px-3 py-1.5 text-xs font-mono ${selectedTimeframe === tf ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>{tf}</button>)}</div></div>
            <InteractiveLightweightChart candles={activeCandles} symbol={selectedSymbol} timeframe={selectedTimeframe} fvg={activeOpp?.activeFvg} tradeableRange={activeOpp?.tradeableRange} barrier={activeOpp?.barrierProposal} structuralShift={activeOpp?.marketShift} sweptPool={activeOpp?.sweptPool} />
            {activeOpp && <OpportunityCard opp={activeOpp} onSelectMarket={setSelectedSymbol} isSelected />}
          </section>
        )}

        {/* PERFORMANCE & CALIBRATION VIEW */}
        {activeTab === 'PERFORMANCE' && (
          <PerformanceDashboard storage={storage} />
        )}
      </main>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <ScannerSettingsModal
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onClose={() => setIsSettingsOpen(false)}
          onReconnectWs={() => wsManager.reconnect()}
        />
      )}
    </div>
  );
}
