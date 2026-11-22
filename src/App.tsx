import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radar } from 'lucide-react';
import { reconcileEngines } from './analysis/coAnalysis';
import { weakModulesForAutoTrading } from './analysis/aiPerformance';
import { createModelPerformanceRecord } from './analysis/modelPerformance';
import { ChartAnalyserView } from './components/ChartAnalyserView';
import { ChartAnalysisView } from './components/ChartAnalysisView';
import { EntryModelAIView } from './components/EntryModelAIView';
import { ConnectionBadge } from './components/ConnectionBadge';
import { SingleChartCanvas } from './components/chart/SingleChartCanvas';
import { FloatingScanner } from './components/FloatingScanner';
import { ModuleOverlayProvider } from './context/ModuleOverlayContext';
import type { ModuleChartOverlay } from './types/chartOverlay';
import {
  MobileMenuSheet,
  MobileNav,
  Sidebar,
  type AppSection,
} from './components/nav/Navigation';
import { OpeningAnimation } from './components/OpeningAnimation';
import { TopBar } from './components/TopBar';
import { DashboardView } from './components/views/DashboardView';
import { BotBuilderView } from './components/views/BotBuilderView';
import { MyBotsView } from './components/views/MyBotsView';
import { AiIntelligenceView } from './components/views/AiIntelligenceView';
import { SettingsView } from './components/views/SettingsView';
import { TradeHistoryView } from './components/views/TradeHistoryView';
import { TradeView } from './components/views/TradeView';
import { TrainingView } from './components/views/TrainingView';
import { TrendlineScannerView } from './components/TrendlineScannerView';
import { DemandSupplyAIView } from './components/DemandSupplyAIView';
import { AiTabView } from './components/ai/moduleViews';
import { AlertsView } from './components/ai/AlertsView';
import { StrategyLabView } from './components/ai/StrategyLabView';
import { SystemHealthView } from './components/views/SystemHealthView';
import { RiskView } from './components/views/RiskView';
import { VolatilityScannerView } from './components/VolatilityScannerView';
import {
  WorkspaceProvider,
  type NavSection,
  type WorkspaceValue,
} from './context/WorkspaceContext';
import { useAppSettings } from './hooks/useAppSettings';
import { useDerivChartData } from './hooks/useDerivChartData';
import { usePriceActionAnalysis } from './hooks/usePriceActionAnalysis';
import { useAnalyserCycle } from './hooks/useAnalyserCycle';
import { completedTradeToLearningRecord } from './analysis/analyserCycle';
import { useSignalManager } from './hooks/useSignalManager';
import { useTheme, useSystemStatus } from './hooks/useTheme';
import { useTrainingEngine } from './hooks/useTrainingEngine';
import { useTrendlineScanner } from './hooks/useTrendlineScanner';
import { useDemandSupplyScanner } from './hooks/useDemandSupplyScanner';
import { AI_MODULE_DEFINITIONS, useAiModules } from './hooks/useAiModules';
import {
  observationsFromAiModules,
  observationsFromAnomalies,
  observationsFromDemandSupply,
  observationsFromHealthTest,
  observationsFromRecommendations,
  observationsFromRegimeChanges,
  observationsFromTrendline,
} from './analysis/alertSources';
import { useAiJournal } from './hooks/useAiJournal';
import { useAlertManager } from './hooks/useAlertManager';
import { useStrategyLab } from './hooks/useStrategyLab';
import { useSystemHealth } from './hooks/useSystemHealth';
import { onReconnect, refreshBalances, resetBalances } from './lib/balances';
import {
  resetExecutionControl,
  useExecutionControlPolling,
} from './lib/execution';
import { useAuth } from './lib/auth';
import { publishSystemSignal } from './lib/trade';
import { useVolatilityScanner } from './hooks/useVolatilityScanner';
import { useSignalRanking } from './hooks/useSignalRanking';
import type { CentralCandidateIntelligence } from './analysis/centralRanking';
import { useEntryModelAI } from './hooks/useEntryModelAI';
import { useLearningIntelligence } from './hooks/useLearningIntelligence';
import { buildLearningRecord, realisedRFrom } from './analysis/learningIntelligence';
import type { LearningOutcomeRecord } from './types/learning';
import type { SignalSnapshot } from './types/analysis';
import type { SetupOrigin } from './types/ranking';
import type { AiSignal } from './types/aiModule';
import type { TimeframeKey } from './types/market';
import type { SignalFeedItem } from './types/signals';
import { classifyMarketFamily } from './utils/derivParser';
import {
  setVoiceEnabled,
  showSignalNotification,
  speakSignal,
} from './utils/notify';
import { analyserSignalItem, buildSignalFeed, scannerSignalItem, trendlineSignalItem } from './utils/signalFeed';
import { deriveSignalLifecycle, passesQualityFilter } from './utils/signalStatus';
import { playSignalChime, primeAudio, setSoundEnabled, setSoundVolume } from './utils/sound';
import { SignalToastStack, type SignalToast } from './components/SignalToasts';

const VALID_SECTIONS: AppSection[] = [
  'dashboard',
  'trade',
  'chart',
  'chartanalysis',
  'analyser',
  'scanner',
  'trendlines',
  'demandsupply',
  'boschoch',
  'technical',
  'smc',
  'liquidity',
  'fvg',
  'orderblock',
  'momentum',
  'regime',
  'timeframealignment',
  'consolidation',
  'confluence',
  'live',
  'entrymodel',
  'performance',
  'risk',
  'alerts',
  'strategylab',
  'health',
  'training',
  'history',
  'settings',
  'botbuilder',
  'mybots',
  'aiintelligence',
];

const LEGACY_HASH: Record<string, AppSection> = {
  analysis: 'analyser',
  signal: 'entrymodel',
};

function sectionFromHash(): AppSection {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  if (LEGACY_HASH[raw]) return LEGACY_HASH[raw];
  return (VALID_SECTIONS as string[]).includes(raw) ? (raw as AppSection) : 'dashboard';
}

export default function App() {
  const [section, setSection] = useState<AppSection>(() => sectionFromHash());
  const [showOpening, setShowOpening] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [floatingScannerOpen, setFloatingScannerOpen] = useState(() => {
    try {
      return localStorage.getItem('lucky_floating_scanner') === 'open';
    } catch {
      return false;
    }
  });
  const [moduleOverlay, setModuleOverlay] = useState<ModuleChartOverlay | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('lucky_floating_scanner', floatingScannerOpen ? 'open' : 'closed');
    } catch {
      // ignore storage errors
    }
  }, [floatingScannerOpen]);

  // A module overlay belongs to the module that published it — clear it on navigation.
  useEffect(() => {
    setModuleOverlay(null);
  }, [section]);

  const selectSection = useCallback((next: AppSection) => {
    setSection(next);
    if (sectionFromHash() !== next) {
      window.location.hash = `#/${next}`;
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Unlock audio on the first user gesture so later chimes are permitted.
  useEffect(() => {
    const unlock = () => primeAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  const {
    settings,
    setDirectionPreference,
    setMinQuality,
    toggleOverlay,
    setCompactChart,
    setTheme,
    toggleTheme,
    setAccentMode,
    setSoundEnabled: setSoundEnabledSetting,
    setSoundVolume: setSoundVolumeSetting,
    setNotificationsEnabled,
    setVoiceEnabled,
    resetSettings,
  } = useAppSettings();

  useTheme(settings.theme);

  useEffect(() => {
    setSoundEnabled(settings.soundEnabled);
  }, [settings.soundEnabled]);

  useEffect(() => {
    setSoundVolume(settings.soundVolume / 100);
  }, [settings.soundVolume]);

  useEffect(() => {
    setVoiceEnabled(settings.voiceEnabled);
  }, [settings.voiceEnabled]);

  // Snapshot of a scanner signal being reproduced on the chart (set when a scanner
  // signal is opened; cleared when the user navigates to a different instrument).
  const [pendingSnapshot, setPendingSnapshot] = useState<SignalSnapshot | null>(null);
  const clearPendingSnapshot = useCallback(() => setPendingSnapshot(null), []);

  const {
    markets,
    marketsLoading,
    selectedSymbol,
    selectedMarket,
    timeframe,
    granularitySec,
    connectionStatus,
    connectionError,
    diagnostics,
    lastTickAt,
    feedStale,
    dataset,
    candles,
    liveTick,
    loadState,
    dataError,
    isLoadingOlder,
    selectMarket,
    selectTimeframe,
    reconnect,
    loadOlderCandles,
    fetchCandlesSnapshot,
    derivService,
  } = useDerivChartData();

  const {
    isScanning,
    scanProgress,
    progressMessage,
    monitorSummary,
    scanSummary,
    timeframe: scannerTimeframe,
    include1Sec,
    autoRefresh,
    lastScannedAt,
    performanceRecords,
    setTimeframe: setScannerTimeframe,
    setInclude1Sec,
    setAutoRefresh,
    scanMarkets,
    cancelScan,
    refreshValidationSettlement,
  } = useVolatilityScanner({
    derivService,
    markets,
    connectionStatus,
  });

  const training = useTrainingEngine({ derivService, markets });

  const trendlineScanner = useTrendlineScanner({
    derivService,
    markets,
    connectionStatus,
    autoStartDelayMs: 3_000,
  });

  const demandSupplyScanner = useDemandSupplyScanner({
    derivService,
    markets,
    connectionStatus,
    autoStartDelayMs: 6_000,
  });

  // ONE LEARNING INTELLIGENCE AI — the single owner of the permanent outcome ledger. It is
  // created FIRST so the AI modules can consume its learned per-index timeframe plans.
  const learning = useLearningIntelligence();

  const aiModules = useAiModules({ derivService, markets, connectionStatus, learnerPlans: learning.planBySymbol });
  const aiJournal = useAiJournal();
  const alertManager = useAlertManager();
  const strategyLab = useStrategyLab({ derivService, markets });

  // CENTRAL SETUP VALIDATION & RANKING ENGINE — aggregates every AI's confirmed setups,
  // re-validates them live and exposes only the strongest currently valid opportunities
  // to the floating scanner. It never restarts the background market scanner.
  const aiSignalSubmissions = useMemo(() => {
    const out: { moduleLabel: string; signal: AiSignal }[] = [];
    for (const def of AI_MODULE_DEFINITIONS) {
      const scanner = aiModules[def.id];
      if (!scanner) continue;
      for (const sig of scanner.summary?.opportunities ?? []) {
        out.push({ moduleLabel: def.label, signal: sig });
      }
    }
    return out;
  }, [aiModules]);

  // UNIVERSAL ENTRY MODEL AI — evaluates the best entry model for EVERY qualified setup
  // from every specialised strategy before the ranking sees it. Only setups with a selected
  // entry model qualify for the final ranking (prioritise entry quality over quantity).
  const entryModelAI = useEntryModelAI({
    derivService,
    engineSignals: scanSummary?.winner ? [scanSummary.winner] : [],
    trendlineSignals: trendlineScanner.summary?.opportunities ?? [],
    dsSignals: demandSupplyScanner.summary?.opportunities ?? [],
    aiSignals: aiSignalSubmissions,
    indexProfiles: learning.profileBySymbol,
    bonusBySymbol: learning.bonusBySymbol,
    performance: learning.entryModelPerformance,
  });
  const entryModelKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of entryModelAI.decisions) {
      if (d.model) map.set(d.key, d.modelLabel);
    }
    return map;
  }, [entryModelAI.decisions]);

  // Advisory intelligence for the central ranking — the Timeframe Alignment AI's alignment
  // score and the Consolidation & Momentum AI's momentum/consolidation read, per index.
  const intelligenceBySymbol = useMemo(() => {
    const map = new Map<string, CentralCandidateIntelligence>();
    const put = (symbol: string, patch: CentralCandidateIntelligence) => {
      map.set(symbol, { ...(map.get(symbol) ?? {}), ...patch });
    };
    for (const a of aiModules['timeframealignment']?.analyses ?? []) {
      const read = a.intelligence;
      if (read && 'character' in read) put(a.symbol, { alignmentScore: read.alignmentScore });
    }
    for (const a of aiModules['consolidation']?.analyses ?? []) {
      const read = a.intelligence;
      if (read && 'classification' in read) {
        put(a.symbol, { momentumStrength: read.momentumStrength, consolidationScore: read.consolidationScore });
      }
    }
    return map;
  }, [aiModules]);

  const ranking = useSignalRanking({
    derivService,
    engineSignals: scanSummary?.winner ? [scanSummary.winner] : [],
    trendlineSignals: trendlineScanner.summary?.opportunities ?? [],
    dsSignals: demandSupplyScanner.summary?.opportunities ?? [],
    aiSignals: aiSignalSubmissions,
    entryModelByKey: entryModelKeys,
    entryDecisionByKey: entryModelAI.decisionByKey,
    indexProfiles: learning.profileBySymbol,
    learningPlans: learning.planBySymbol,
    intelligenceBySymbol,
    connectionStatus,
  });

  // ONE LEARNING INTELLIGENCE AI — permanently record the realised outcome of every settled
  // setup against the entry model the Entry Model AI selected for it, with FULL attribution
  // (originating AI, strategy, entry model, index, timeframe, direction, realised R). The
  // ledger dedupes by setup key and never overwrites a recorded outcome.
  const settledEntryModelKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const records: LearningOutcomeRecord[] = [];
    for (const setup of ranking.settledSetups) {
      if (settledEntryModelKeysRef.current.has(setup.key)) continue;
      settledEntryModelKeysRef.current.add(setup.key);
      const decision = entryModelAI.decisionByKey.get(setup.key);
      if (!decision || decision.model === null || !setup.outcome) continue;
      const plannedRr = setup.riskRewardRatio;
      const realisedRr = realisedRFrom(setup.outcome, plannedRr);
      records.push(
        buildLearningRecord({
          id: setup.key,
          sourceLabel: setup.sourceLabel,
          strategyId: setup.source,
          strategyLabel: setup.sourceLabel,
          entryModel: decision.model,
          entryModelLabel: decision.modelLabel,
          symbol: setup.symbol,
          displayName: setup.displayName,
          marketFamily: setup.marketFamily,
          timeframe: setup.timeframe,
          direction: setup.direction,
          plannedRr,
          realisedRr,
          highestTargetReached: setup.outcome === 'TARGET_HIT' ? 1 : 0,
          reachedBreakeven: false,
          outcome: setup.outcome,
          conditions: setup.reasons ?? [],
          confirmedAt: setup.createdAt,
          settledAt: setup.settledAt ?? Date.now(),
        })
      );
    }
    if (records.length > 0) learning.recordOutcomes(records);
  }, [ranking.settledSetups, entryModelAI.decisionByKey, learning]);

  const marketName = selectedMarket?.displayName ?? selectedSymbol;
  const precision = selectedMarket?.precision ?? 2;
  const marketFamily =
    selectedMarket?.family ?? classifyMarketFamily(selectedSymbol, '', marketName);

  const {
    controlMode,
    runState,
    report: rawReport,
    isAnalyzing,
    analysisError,
    startAnalysis,
    pauseAnalysis,
    resumeAnalysis,
    stopAnalysis,
  } = usePriceActionAnalysis({
    symbol: selectedSymbol,
    marketName,
    marketFamily,
    activeTimeframe: timeframe,
    precision,
    candles,
    liveTick,
    loadState,
    connectionStatus,
    feedStale,
    pendingSnapshot,
    fetchCandlesSnapshot,
  });

  // Declared before the cycle hook so the completion callback and re-analysis request can
  // reference them (hoisted as refs/state, not as function bodies).
  const autoRunTriggeredRef = useRef(false);

  // Account balances (DEMO + REAL, kept separate). Loaded once the session is
  // authenticated, revalidated whenever the market feed recovers (a fresh
  // connection is a natural point to confirm the Deriv authorization still
  // holds), and cleared on sign-out so one user's figures never linger.
  const auth = useAuth();
  // Automatic-trading control: one shared store the header switch and the Trade
  // panel both read, refreshed while signed in and cleared on sign-out.
  useExecutionControlPolling(auth.status === 'authenticated');
  const balancesLoadedRef = useRef(false);
  useEffect(() => {
    if (auth.status === 'authenticated') {
      if (!balancesLoadedRef.current) {
        balancesLoadedRef.current = true;
        void refreshBalances();
      }
    } else if (auth.status === 'anonymous') {
      balancesLoadedRef.current = false;
      resetBalances();
      resetExecutionControl();
    }
  }, [auth.status]);

  const prevConnectionRef = useRef(connectionStatus);
  useEffect(() => {
    const recovered =
      connectionStatus === 'connected' &&
      (prevConnectionRef.current === 'reconnecting' ||
        prevConnectionRef.current === 'error' ||
        prevConnectionRef.current === 'disconnected');
    prevConnectionRef.current = connectionStatus;
    if (recovered && auth.status === 'authenticated') onReconnect();
  }, [connectionStatus, auth.status]);

  const [historyRecords, setHistoryRecords] = useState(performanceRecords);
  useEffect(() => {
    setHistoryRecords(performanceRecords);
  }, [performanceRecords]);
  const livePrice = candles.length > 0 ? candles[candles.length - 1].close : null;

  // AUTOMATIC CHART RESET & FRESH-ENTRY CYCLE — detects TP/SL completion of the displayed
  // analyser setup, records the trade, clears its markings and re-analyses for a fresh
  // entry. `report` is the cleared view the rest of the app consumes; `rawReport` stays
  // the engine's own output so a completion is detected exactly once.
  const analyserCycle = useAnalyserCycle({
    report: rawReport,
    candles,
    livePrice,
    active: controlMode === 'running',
    requestReanalysis: () => {
      autoRunTriggeredRef.current = true;
      resumeAnalysis();
    },
    entryDecisionByKey: entryModelAI.decisionByKey,
    onTradeCompleted: (trade) => {
      // Trade Recording — append the completed analyser trade to the permanent history
      // ledger (never deleted) and feed the outcome into the ONE Learning Intelligence AI.
      setHistoryRecords((prev) => {
        if (prev.some((r) => r.id === trade.id)) return prev;
        const record = createModelPerformanceRecord({
          id: trade.id,
          symbol: trade.symbol,
          displayName: trade.displayName,
          marketFamily: trade.marketFamily,
          precision: trade.precision,
          direction: trade.direction,
          model: trade.modelId,
          modelLabel: trade.modelLabel,
          condition: trade.chartAnalysis.condition,
          analysisTimeframe: trade.timeframe,
          quality: trade.chartAnalysis.quality,
          entryPrice: trade.entry,
          entryZone: trade.entryZone,
          invalidationPrice: trade.invalidationPrice,
          invalidationCondition: `Verified ${trade.outcome} at ${trade.exitPrice}.`,
          target1: trade.takeProfit,
          target2: null,
          stopLoss: trade.stopLoss,
          riskRewardRatio: trade.riskRewardRatio,
          confirmationExplanation: trade.chartAnalysis.confirmationExplanation,
          bosChochEvidence: trade.chartAnalysis.bosChochEvidence,
          supportResistance: [],
          momentumEvidence: trade.chartAnalysis.momentumEvidence,
          reasons: trade.chartAnalysis.reasons,
          invalidations: [],
          availableSpaceAtr: trade.chartAnalysis.availableSpaceAtr,
          availableSpaceLabel: trade.chartAnalysis.availableSpaceLabel,
          indicators: {
            ema20: null,
            ema50: null,
            rsi14: null,
            macdLine: null,
            macdSignal: null,
            macdHistogram: null,
            adx14: null,
            trendConfirm: 'NEUTRAL',
            momentumConfirm: 'NEUTRAL',
            strengthConfirm: false,
            notes: [],
          },
          state: trade.outcome === 'TARGET_HIT' ? 'CONFIRMED' : 'INVALIDATED',
          instrumentLabel: 'Chart Analyser',
          explanation: trade.chartAnalysis.confirmationExplanation,
          createdAt: trade.confirmedAt,
          confirmedBarTime: trade.chartAnalysis.confirmedBarTime,
          lastUpdated: trade.settledAt,
        });
        return [record, ...prev].slice(0, 400);
      });
      learning.recordOutcomes([completedTradeToLearningRecord(trade)]);
    },
  });

  const report = analyserCycle.effectiveReport;

  // Auto-run analysis when opening the Chart Analyser with a ready market.
  useEffect(() => {
    const wantsAutoRun = section === 'analyser';
    if (
      wantsAutoRun &&
      connectionStatus === 'connected' &&
      loadState === 'ready' &&
      candles.length >= 26 &&
      !autoRunTriggeredRef.current &&
      !isAnalyzing
    ) {
      autoRunTriggeredRef.current = true;
      startAnalysis();
    }
  }, [section, connectionStatus, loadState, candles.length, isAnalyzing, startAnalysis]);

  const openChart = useCallback(
    (symbol: string, tf: TimeframeKey, snapshot?: SignalSnapshot | null) => {
      autoRunTriggeredRef.current = false;
      setPendingSnapshot(snapshot ?? null);
      selectMarket(symbol);
      selectTimeframe(tf);
      // Selecting a signal opens the dedicated full-screen Chart tab with its exact market,
      // timeframe and entry/SL/TP levels (master spec §3).
      selectSection('chart');
    },
    [selectMarket, selectTimeframe, selectSection]
  );

  const openAnalyser = useCallback(
    (symbol: string, tf: TimeframeKey, snapshot?: SignalSnapshot | null) => {
      autoRunTriggeredRef.current = false;
      setPendingSnapshot(snapshot ?? null);
      selectMarket(symbol);
      selectTimeframe(tf);
      selectSection('analyser');
    },
    [selectMarket, selectTimeframe, selectSection]
  );

  // CHART ANALYSIS — open a ranked setup (from the floating scanner) in the dedicated tab,
  // preserving its originating AI + analysis details.
  const [chartAnalysisSetup, setChartAnalysisSetup] = useState<SetupOrigin | null>(null);
  const clearChartAnalysisSetup = useCallback(() => setChartAnalysisSetup(null), []);
  const openSetupInChartAnalysis = useCallback(
    (symbol: string, tf: TimeframeKey, origin: SetupOrigin | null) => {
      autoRunTriggeredRef.current = false;
      setChartAnalysisSetup(origin);
      selectMarket(symbol);
      selectTimeframe(tf);
      selectSection('chart');
    },
    [selectMarket, selectTimeframe, selectSection]
  );

  // Record a confirmed Chart Analyser signal into trade history. This is the only
  // place analyser setups are recorded.
  const recordAnalyserSignal = useCallback<WorkspaceValue['recordAnalyserSignal']>(
    ({ direction, entryPrice }) => {
      const sig = report?.overlays.signal;
      if (!sig) return;
      const record = createModelPerformanceRecord({
        id: `${sig.id}-manual-${Date.now()}`,
        symbol: selectedSymbol,
        displayName: marketName,
        marketFamily,
        precision,
        direction,
        model: sig.model,
        modelLabel: sig.modelLabel,
        condition: sig.condition,
        analysisTimeframe: timeframe,
        quality: sig.quality,
        entryPrice,
        entryZone: null,
        invalidationPrice: sig.invalidationPrice,
        invalidationCondition: sig.invalidationCondition,
        target1: sig.takeProfit1,
        target2: sig.takeProfit2,
        stopLoss: sig.stopLoss,
        riskRewardRatio: sig.riskRewardRatio,
        confirmationExplanation: sig.confirmationExplanation,
        bosChochEvidence: sig.bosChochEvidence,
        supportResistance: [],
        momentumEvidence: sig.momentumEvidence,
        reasons: sig.reasons,
        invalidations: sig.invalidations,
        availableSpaceAtr: sig.availableSpaceAtr,
        availableSpaceLabel: sig.availableSpaceLabel,
        indicators: report.indicators,
        state: 'ACTIVE',
        instrumentLabel: 'Chart Analyser',
        explanation: sig.explanation ?? sig.confirmationExplanation,
        createdAt: Date.now(),
        confirmedBarTime: sig.entryCandleTime,
        lastUpdated: Date.now(),
      });
      setHistoryRecords((prev) => [record, ...prev].slice(0, 400));
    },
    [report, selectedSymbol, marketName, marketFamily, timeframe]
  );

  const recordValidatedSignal = useCallback<WorkspaceValue['recordValidatedSignal']>(
    (item: SignalFeedItem) => {
      if (!item.model || item.entryPrice === null) return;
      const record = createModelPerformanceRecord({
        id: `${item.id}-validated-${Date.now()}`,
        symbol: item.symbol,
        displayName: item.displayName,
        marketFamily: item.marketFamily,
        precision: 2,
        direction: item.direction,
        model: item.model,
        modelLabel: item.modelLabel ?? 'Confirmed Setup',
        condition: item.condition,
        analysisTimeframe: item.timeframe,
        quality:
          item.quality ?? {
            structure: 0,
            levelZone: 0,
            entryConfirmation: 0,
            momentum: 0,
            multiTimeframe: 0,
            availableSpace: 0,
            total: item.confidence,
            tier: 'HIGH_QUALITY',
            publishable: true,
          },
        entryPrice: item.entryPrice,
        entryZone: null,
        invalidationPrice: item.stopLoss ?? item.entryPrice,
        invalidationCondition: 'Recorded from validated dual-engine signal.',
        target1: item.takeProfit1,
        target2: item.takeProfit2,
        stopLoss: item.stopLoss ?? item.entryPrice,
        riskRewardRatio: item.riskRewardRatio ?? 0,
        confirmationExplanation: item.coAnalysis?.notes.join(' ') ?? 'Shared-validation signal.',
        bosChochEvidence: [],
        supportResistance: [],
        momentumEvidence: [],
        reasons: item.coAnalysis?.notes ?? [],
        invalidations: [],
        availableSpaceAtr: 0,
        availableSpaceLabel: 'N/A',
        indicators: {
          ema20: null,
          ema50: null,
          rsi14: null,
          macdLine: null,
          macdSignal: null,
          macdHistogram: null,
          adx14: null,
          trendConfirm: 'NEUTRAL',
          momentumConfirm: 'NEUTRAL',
          strengthConfirm: false,
          notes: [],
        },
        state: 'ACTIVE',
        instrumentLabel: item.marketFamily,
        explanation: item.coAnalysis?.notes.join(' ') ?? 'Shared-validation signal.',
        createdAt: Date.now(),
        confirmedBarTime: Date.now(),
        lastUpdated: Date.now(),
      });
      setHistoryRecords((prev) => [record, ...prev].slice(0, 400));
    },
    []
  );

  const playSignalSound = useCallback<WorkspaceValue['playSignalSound']>(
    (kind = 'validated') => {
      primeAudio();
      playSignalChime(kind);
    },
    []
  );

  // Dual-engine co-analysis for the currently selected instrument.
  const coAnalysis = useMemo(
    () =>
      reconcileEngines({
        symbol: selectedSymbol,
        timeframe,
        scanner: scanSummary?.winner ?? null,
        analyser: report,
      }),
    [selectedSymbol, timeframe, scanSummary, report]
  );

  // Merge both engines into one clickable feed and remember it for the session.
  // The dedicated Trendline Scanner contributes its own confirmed signals too.
  const trendlineFeed = useMemo(
    () =>
      (trendlineScanner.summary?.opportunities ?? [])
        .map((sig) => trendlineSignalItem(sig))
        .filter((item): item is SignalFeedItem => item !== null),
    [trendlineScanner.summary]
  );

  const liveFeed = useMemo(
    () =>
      buildSignalFeed([
        scannerSignalItem(scanSummary?.winner ?? null, coAnalysis),
        analyserSignalItem(report, coAnalysis),
        ...trendlineFeed,
      ]),
    [scanSummary, report, coAnalysis, trendlineFeed]
  );

  const playedKeysRef = useRef<Set<string>>(new Set());
  const settleBucketRef = useRef<number>(-1);
  const [feedStore, setFeedStore] = useState<SignalFeedItem[]>([]);
  const [toasts, setToasts] = useState<SignalToast[]>([]);

  const {
    managedSignals,
    openSignals: openManagedSignals,
    getManaged: getManagedSignal,
  } = useSignalManager({
    feed: feedStore,
    candles,
    currentSymbol: selectedSymbol,
    precision,
  });

  const dismissToast = useCallback((toastId: string) => {
    setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }, []);

  const { notificationsEnabled, voiceEnabled } = settings;

  useEffect(() => {
    if (liveFeed.length === 0) return;
    const fresh: SignalFeedItem[] = [];
    for (const item of liveFeed) {
      const key = `${item.symbol}|${item.timeframe}|${item.direction}`;
      if (!playedKeysRef.current.has(key)) {
        playedKeysRef.current.add(key);
        fresh.push(item);
      }
    }
    setFeedStore((prev) => {
      const map = new Map(prev.map((i) => [`${i.symbol}|${i.timeframe}|${i.direction}`, i]));
      for (const item of liveFeed) {
        map.set(`${item.symbol}|${item.timeframe}|${item.direction}`, item);
      }
      return Array.from(map.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);
    });
    for (const item of fresh) {
      playSignalChime(
        item.source === 'CO-ANALYSIS'
          ? 'validated'
          : item.source === 'SCANNER'
            ? 'scanner'
            : item.source === 'TRENDLINE'
              ? 'analyser'
              : 'analyser'
      );
      if (notificationsEnabled) {
        setToasts((prev) =>
          [{ ...item, toastId: `${item.id}-${Date.now()}` }, ...prev].slice(0, 3)
        );
        showSignalNotification(item);
      }
      if (voiceEnabled) speakSignal(item);
    }
  }, [liveFeed, notificationsEnabled, voiceEnabled]);

  // Publish each confirmed signal to the server, so the automatic trader can act
  // on it. This is best-effort and never blocks the UI. The key is stable per
  // setup, so a signal that keeps re-deriving is published once; the server also
  // dedupes and only trades it for users who chose automatic mode.
  //
  // Only signals that clear the customer's Signal Quality Filter are published,
  // so the set the automatic trader acts on is exactly the set the customer is
  // shown (feed, notifications, dashboard, live trade management).
  const publishedSystemKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    for (const item of liveFeed) {
      if (!passesQualityFilter(item.confidence, settings.minQuality)) continue;
      const setupKey = `${item.symbol}|${item.timeframe}|${item.direction}|${item.source}`;
      if (publishedSystemKeysRef.current.has(setupKey)) continue;
      publishedSystemKeysRef.current.add(setupKey);
      void publishSystemSignal({
        symbol: item.symbol,
        displayName: item.displayName,
        direction: item.direction,
        timeframe: item.timeframe,
        confidence: item.confidence,
        entryPrice: item.entryPrice,
        stopLoss: item.stopLoss,
        takeProfit: item.takeProfit1 ?? item.takeProfit2 ?? null,
        setupKey,
        source: item.source,
        minQuality: settings.minQuality
      });
    }
  }, [liveFeed, auth.status, settings.minQuality]);

  // Trade Performance & Learning AI — journal every module's published signals and re-verify
  // outcomes against fresh candles (id-keyed, so re-scans never duplicate records).
  const aiJournalRef = useRef(aiJournal);
  aiJournalRef.current = aiJournal;
  const publishedSignature = useMemo(
    () =>
      Object.entries(aiModules)
        .flatMap(([id, scanner]) =>
          scanner.analyses.filter((a) => a.signal !== null).map((a) => `${id}:${a.signal?.id ?? ''}`)
        )
        .join('|'),
    [aiModules]
  );

  useEffect(() => {
    const entries: { module: string; signal: AiSignal }[] = [];
    for (const [id, scanner] of Object.entries(aiModules)) {
      for (const analysis of scanner.analyses) {
        if (analysis.signal) entries.push({ module: id, signal: analysis.signal });
      }
    }
    if (entries.length > 0) aiJournalRef.current.ingest(entries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishedSignature]);

  // Publish every AI module's confirmed signal to the server too — these are the
  // setups the performance table scores. Deduped by a stable per-setup key, so a
  // module that keeps re-publishing the same setup is sent once. Only setups that
  // clear the customer's Signal Quality Filter are published, so the automatic
  // trader never acts on a weaker setup than the customer is shown.
  const publishedAiKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    // Concentrate automatic trading on modules with a healthy settled record: a
    // module proven weak over a meaningful sample is not auto-entered, while one
    // without enough settled evidence yet is still allowed through.
    const weakModules = weakModulesForAutoTrading(aiJournal.records);
    for (const [id, scanner] of Object.entries(aiModules)) {
      if (weakModules.has(id)) continue;
      for (const analysis of scanner.analyses) {
        const sig = analysis.signal;
        if (!sig) continue;
        if (!passesQualityFilter(sig.score, settings.minQuality)) continue;
        const setupKey = `${sig.symbol}|${sig.timeframes[0]?.timeframe ?? ''}|${sig.direction}|${id}`;
        if (publishedAiKeysRef.current.has(setupKey)) continue;
        publishedAiKeysRef.current.add(setupKey);
        void publishSystemSignal({
          symbol: sig.symbol,
          displayName: sig.displayName,
          direction: sig.direction,
          timeframe: sig.timeframes[0]?.timeframe ?? '',
          confidence: sig.score,
          entryPrice: sig.entryPrice,
          stopLoss: sig.stopLoss,
          takeProfit: sig.takeProfit1,
          setupKey,
          source: `AI:${id}`,
          minQuality: settings.minQuality
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishedSignature, auth.status, aiJournal.records, settings.minQuality]);

  useEffect(() => {
    if (candles.length === 0) return;
    const bucket = Math.floor(Date.now() / 30_000);
    if (settleBucketRef.current === bucket) return;
    settleBucketRef.current = bucket;
    const map = new Map<string, typeof candles>();
    map.set(selectedSymbol, candles);
    aiJournalRef.current.settle(map);
  }, [candles, selectedSymbol]);

  // AI ALERTS & NOTIFICATION MANAGER — collect published events from every module and the
  // independent journal. The alert layer only classifies, de-duplicates and communicates.
  const alertManagerRef = useRef(alertManager);
  alertManagerRef.current = alertManager;
  const alertSignature = useMemo(
    () =>
      [
        ...Object.entries(aiModules).flatMap(([id, scanner]) =>
          scanner.analyses.filter((a) => a.signal).map((a) => `${id}:${a.signal?.id}`)
        ),
        ...trendlineScanner.analyses.filter((a) => a.signal).map((a) => `trendlines:${a.signal?.id}`),
        ...demandSupplyScanner.analyses
          .filter((a) => a.signal)
          .map((a) => `demandsupply:${a.signal?.id}`),
        ...aiJournal.records.filter((r) => r.outcome !== 'PENDING').map((r) => `j:${r.id}:${r.outcome}`),
      ].join('|'),
    [aiModules, trendlineScanner.analyses, demandSupplyScanner.analyses, aiJournal.records]
  );

  useEffect(() => {
    const manager = alertManagerRef.current;
    const labels: Record<string, string> = {};
    for (const def of AI_MODULE_DEFINITIONS) labels[def.id] = def.label;
    manager.ingestObservations([
      ...observationsFromAiModules(aiModules, labels),
      ...observationsFromTrendline('Trendline AI', trendlineScanner.analyses),
      ...observationsFromDemandSupply('Demand & Supply AI', demandSupplyScanner.analyses),
    ]);
    manager.ingestJournal(aiJournal.records);
    manager.ingestObservations(
      observationsFromAnomalies(strategyLab.anomalyReports, strategyLab.sensitivity)
    );
    manager.ingestObservations(observationsFromRegimeChanges(strategyLab.regimeChanges));
    manager.ingestObservations(
      observationsFromRecommendations(strategyLab.report?.recommendations ?? [])
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    alertSignature,
    strategyLab.anomalyReports,
    strategyLab.regimeChanges,
    strategyLab.report,
  ]);

  // SYSTEM HEALTH & DIAGNOSTICS — collects real runtime evidence and runs the live
  // integration test. Results are also pushed into the alert manager as system alerts.
  // `run` counts modules that COMPLETED a pass; `active` counts modules that produced an
  // analysis for the selected instrument. A module that has not run yet is NOT_TESTED,
  // never a failure — that distinction is what keeps the health board honest.
  const aiModulesRun = useMemo(() => {
    let n = 0;
    for (const scanner of Object.values(aiModules)) if (scanner.hasRun) n += 1;
    if (trendlineScanner.hasRun) n += 1;
    if (demandSupplyScanner.hasRun) n += 1;
    return n;
  }, [
    aiModules,
    trendlineScanner.hasRun,
    demandSupplyScanner.hasRun,
  ]);

  const aiModulesActive = useMemo(() => {
    let n = 0;
    for (const scanner of Object.values(aiModules)) {
      if (scanner.summary || scanner.analyses.length > 0) n += 1;
    }
    if (trendlineScanner.analyses.length > 0) n += 1;
    if (demandSupplyScanner.analyses.length > 0) n += 1;
    return n;
  }, [aiModules, trendlineScanner.analyses, demandSupplyScanner.analyses]);

  // Surface a concrete reason when the modules ran but produced nothing (e.g. a rate limit
  // starved every data fetch) instead of a bare "0/12".
  const aiScanError = useMemo(() => {
    const errors = Object.values(aiModules)
      .map((s) => s.lastScanError)
      .filter((e): e is string => e !== null);
    return errors.length > 0 ? errors[0] : null;
  }, [aiModules]);

  const health = useSystemHealth({
    derivService,
    markets,
    marketsLoading,
    selectedSymbol,
    connectionStatus,
    diagnostics,
    lastTickAt,
    feedStale,
    candleCount: candles.length,
    loadState,
    dataError,
    candles,
    isAnalyzing,
    report,
    analysisError,
    scannerRanAt: lastScannedAt,
    scannerRows: monitorSummary?.readings.length ?? 0,
    floatingScannerOpen,
    aiModulesRun,
    aiModulesActive,
    aiModulesTotal: AI_MODULE_DEFINITIONS.length + 2,
    aiScanError,
    alertCount: alertManager.alerts.length,
    backtestEvaluations: strategyLab.report?.evaluations.length ?? 0,
    performanceRecords: historyRecords.length,
    anomalyReports: strategyLab.anomalyReports.length,
    onIntegrationResult: (result) => {
      alertManagerRef.current.ingestObservations(observationsFromHealthTest(result));
    },
  });

  const canRunAnalysis =
    connectionStatus === 'connected' && loadState === 'ready' && candles.length >= 26;
  const lifecycle = useMemo(
    () =>
      deriveSignalLifecycle(report, {
        minQuality: settings.minQuality,
        directionPreference: settings.directionPreference,
      }),
    [report, settings.minQuality, settings.directionPreference]
  );

  // The interface accent tracks the live system status (green bullish, red bearish,
  // blue analysis, purple training, amber developing) unless pinned in Settings.
  const systemStatus = useSystemStatus({
    lifecycle,
    report,
    isAnalyzing,
    isScanning,
    trainingRunning: training.progress.status === 'RUNNING',
    accentMode: settings.accentMode,
    theme: settings.theme,
  });
  void systemStatus;

  const workspaceValue: WorkspaceValue = {
    markets,
    marketsLoading,
    selectedSymbol,
    selectedMarket,
    marketName,
    marketFamily,
    timeframe,
    granularitySec,
    precision,
    connectionStatus,
    connectionError,
    diagnostics,
    lastTickAt,
    feedStale,
    dataset,
    candles,
    liveTick,
    loadState,
    dataError,
    isLoadingOlder,
    livePrice,
    controlMode,
    runState,
    report,
    isAnalyzing,
    analysisError,
    canRunAnalysis,
    lifecycle,
    isScanning,
    scanProgress,
    progressMessage,
    monitorSummary,
    scannerSummary: scanSummary,
    analyserTimeframe: scannerTimeframe,
    setAnalyserTimeframe: setScannerTimeframe,
    include1Sec,
    autoRefresh,
    lastScannedAt,
    performanceRecords: historyRecords,
    coAnalysis,
    signalFeed: feedStore,
    playSignalSound,
    pendingSnapshot,
    clearPendingSnapshot,
    settings,
    selectMarket,
    selectTimeframe,
    reconnect: () => {
      void reconnect();
    },
    loadOlderCandles: () => {
      void loadOlderCandles();
    },
    startAnalysis,
    pauseAnalysis,
    resumeAnalysis,
    stopAnalysis,
    setDirectionPreference,
    setMinQuality,
    toggleOverlay,
    setCompactChart,
    setTheme,
    toggleTheme,
    setAccentMode,
    setSoundEnabled: setSoundEnabledSetting,
    setSoundVolume: setSoundVolumeSetting,
    setNotificationsEnabled,
    setVoiceEnabled,
    resetSettings,
    setScannerTimeframe,
    setInclude1Sec,
    setAutoRefresh,
    scanMarkets: () => {
      void scanMarkets();
    },
    cancelScan,
    refreshValidationSettlement: () => {
      void refreshValidationSettlement();
    },
    recordAnalyserSignal,
    recordValidatedSignal,
    openChart,
    openAnalyser,
    openSetupInChartAnalysis,
    chartAnalysisSetup,
    clearChartAnalysisSetup,
    entryModelAI,
    analyserCycle,
    navigate: (target: NavSection) => {
      autoRunTriggeredRef.current = false;
      selectSection(target);
    },
    training,
    managedSignals,
    openManagedSignals,
    getManagedSignal,
    trendlineScanner,
    demandSupplyScanner,
  };

  // Exactly ONE chart in the whole app. Chart-centric modules render the shared canvas plus an
  // intelligence panel beside it (including Trade, which needs the chart in view to place an
  // order against what the scanner is seeing); data-heavy workspaces (dashboard, health, lab,
  // history, alerts, settings) keep their original full-width layout.
  const FULL_WIDTH_SECTIONS: AppSection[] = [
    'dashboard',
    'health',
    'settings',
    'training',
    'history',
    'alerts',
    'strategylab',
    'entrymodel',
    'botbuilder',
    'mybots',
    'aiintelligence',
  ];
  const isFullWidth = FULL_WIDTH_SECTIONS.includes(section);
  // The dedicated Chart tab is the master spec's "CHART ONLY" workspace: the shared canvas
  // fills the whole viewport and the sidebar / top bar / bottom nav are hidden.
  const isChartOnly = section === 'chart';

  return (
    <WorkspaceProvider value={workspaceValue}>
      <ModuleOverlayProvider value={{ overlay: moduleOverlay, setOverlay: setModuleOverlay }}>
        {showOpening && <OpeningAnimation onComplete={() => setShowOpening(false)} />}

        {settings.notificationsEnabled && (
          <SignalToastStack toasts={toasts} onDismiss={dismissToast} onOpen={openChart} />
        )}

        <div className="flex h-dvh w-full bg-app text-ink overflow-hidden">
          <Sidebar
            active={section}
            onSelect={selectSection}
            badges={{ alerts: alertManager.unreadCount }}
            statusBadge={
              <ConnectionBadge status={connectionStatus} onReconnect={() => void reconnect()} />
            }
            hidden={isChartOnly}
          />

          <div className="flex flex-col flex-1 min-w-0">
            {!isChartOnly && <TopBar />}

            <div className="flex flex-1 min-h-0 min-w-0">
              {isFullWidth ? (
                <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
                  <div key={section} className="animate-view-enter flex flex-col min-h-full">
                    {section === 'dashboard' && <DashboardView />}
                    {section === 'botbuilder' && <BotBuilderView />}
                    {section === 'mybots' && <MyBotsView />}
                    {section === 'aiintelligence' && <AiIntelligenceView />}
                    {section === 'entrymodel' && <EntryModelAIView />}
                    {section === 'health' && <SystemHealthView health={health} />}
                    {section === 'settings' && <SettingsView />}
                    {section === 'training' && <TrainingView />}
                    {section === 'history' && <TradeHistoryView />}
                    {section === 'alerts' && <AlertsView manager={alertManager} />}
                    {section === 'strategylab' && <StrategyLabView lab={strategyLab} />}
                  </div>
                </main>
              ) : isChartOnly ? (
                <section className="flex flex-col flex-1 min-w-0 min-h-0">
                  <SingleChartCanvas
                    moduleOverlay={moduleOverlay}
                    fullScreen
                    onBack={() => selectSection('dashboard')}
                  />
                </section>
              ) : (
                <>
                  <section className="flex flex-col flex-1 min-w-0 min-h-0">
                    <SingleChartCanvas
                      moduleOverlay={moduleOverlay}
                      panelToggle={{ open: panelOpen, onToggle: () => setPanelOpen((v) => !v) }}
                    />
                  </section>

                  <aside
                    className={`shrink-0 border-l border-line bg-app min-h-0 overflow-hidden transition-[width] duration-200 ${
                      panelOpen ? 'w-full xl:w-[420px]' : 'hidden xl:block xl:w-[420px]'
                    }`}
                  >
                    <div className="h-full min-h-0 overflow-hidden flex flex-col">
                      {section === 'analyser' && <ChartAnalyserView />}
                      {section === 'chartanalysis' && <ChartAnalysisView />}
                      {section === 'scanner' && (
                        <div className="h-full overflow-y-auto">
                          <VolatilityScannerView
                            isScanning={isScanning}
                            scanProgress={scanProgress}
                            progressMessage={progressMessage}
                            monitorSummary={monitorSummary}
                            scannerSummary={scanSummary}
                            timeframe={scannerTimeframe}
                            include1Sec={include1Sec}
                            autoRefresh={autoRefresh}
                            lastScannedAt={lastScannedAt}
                            onTimeframeChange={setScannerTimeframe}
                            onToggle1Sec={setInclude1Sec}
                            onToggleAutoRefresh={setAutoRefresh}
                            onScanNow={() => void scanMarkets()}
                            onCancelScan={cancelScan}
                            onOpenAnalyser={openAnalyser}
                            onOpenChartOnly={openChart}
                          />
                        </div>
                      )}
                      {section === 'trendlines' && (
                        <div className="h-full overflow-y-auto">
                          <TrendlineScannerView scanner={trendlineScanner} />
                        </div>
                      )}
                      {section === 'demandsupply' && (
                        <div className="h-full overflow-y-auto">
                          <DemandSupplyAIView scanner={demandSupplyScanner} />
                        </div>
                      )}
                      {(section === 'boschoch' ||
                        section === 'technical' ||
                        section === 'smc' ||
                        section === 'liquidity' ||
                        section === 'fvg' ||
                        section === 'orderblock' ||
                        section === 'momentum' ||
                        section === 'regime' ||
                        section === 'timeframealignment' ||
                        section === 'consolidation' ||
                        section === 'confluence' ||
                        section === 'live' ||
                        section === 'performance') && (
                        <div className="h-full overflow-y-auto">
                          <AiTabView id={section} scanners={aiModules} journal={aiJournal} />
                        </div>
                      )}
                      {section === 'trade' && (
                        <div className="h-full overflow-y-auto">
                          <TradeView />
                        </div>
                      )}
                      {section === 'risk' && (
                        <div className="h-full overflow-y-auto">
                          <RiskView />
                        </div>
                      )}
                    </div>
                  </aside>
                </>
              )}
            </div>

            {!isChartOnly && (
              <MobileNav
                active={section}
                onSelect={selectSection}
                badges={{ alerts: alertManager.unreadCount }}
                onOpenMenu={() => setMobileMenuOpen(true)}
              />
            )}
          </div>
        </div>

        {mobileMenuOpen && (
          <MobileMenuSheet
            active={section}
            onSelect={selectSection}
            onClose={() => setMobileMenuOpen(false)}
          />
        )}

        <FloatingScanner
          open={floatingScannerOpen}
          onClose={() => setFloatingScannerOpen(false)}
          monitorSummary={monitorSummary}
          markets={markets}
          timeframe={scannerTimeframe}
          livePrice={livePrice}
          selectedSymbol={selectedSymbol}
          onOpenMarket={openChart}
          onOpenAnalyser={openAnalyser}
          rankedSetups={ranking.topSetups}
          activeSetupCount={ranking.activeSetups.length}
          onRunScan={ranking.runScan}
          isValidating={ranking.isValidating}
          lastRankedAt={ranking.lastRankedAt}
          filterConfig={ranking.filterConfig}
          onFilterConfigChange={ranking.setFilterConfig}
          filterAccepted={ranking.filterAccepted}
          filterRejected={ranking.filterRejected}
          central={ranking.central}
          onOpenSetup={(setup) =>
            openSetupInChartAnalysis(setup.symbol, setup.timeframe, {
              sourceLabel: setup.sourceLabel,
              modelLabel: setup.modelLabel,
              direction: setup.direction,
              timeframe: setup.timeframe,
              symbol: setup.symbol,
              displayName: setup.displayName,
              score: setup.score,
              entryModelLabel: setup.entryModelLabel ?? null,
            })
          }
        />

        {!isFullWidth && !floatingScannerOpen && (
          <button
            type="button"
            onClick={() => setFloatingScannerOpen(true)}
            data-testid="open-floating-scanner"
            className="fixed bottom-20 right-4 lg:bottom-6 z-20 inline-flex items-center gap-1.5 h-10 px-3.5 rounded-full bg-accent text-white text-[13px] font-semibold shadow-lg hover:bg-accent-soft active:scale-[0.98] transition-all duration-150 cursor-pointer"
          >
            <Radar className="w-4 h-4" aria-hidden="true" />
            Scanner
          </button>
        )}
      </ModuleOverlayProvider>
    </WorkspaceProvider>
  );
}
