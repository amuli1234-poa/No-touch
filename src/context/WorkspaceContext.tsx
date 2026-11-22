import { createContext, useContext } from 'react';
import type { AppSettings, DirectionPreference } from '../hooks/useAppSettings';
import type { CandleDataset, LiveCandleTick } from '../hooks/useDerivChartData';
import type { ConnectionDiagnostics } from '../services/derivWebSocket';
import type { TrainingEngineValue } from '../hooks/useTrainingEngine';
import type { TrendlineScannerValue } from '../hooks/useTrendlineScanner';
import type { DemandSupplyScannerValue } from '../hooks/useDemandSupplyScanner';
import type { ManagedSignal } from '../types/training';
import type { AnalyserCycleValue } from '../hooks/useAnalyserCycle';
import type {
  AnalysisControlMode,
  AnalysisRunState,
  FullAnalysisReport,
  SignalSnapshot,
} from '../types/analysis';
import type {
  Candle,
  ChartLoadState,
  ConnectionStatus,
  DerivErrorInfo,
  MarketFamily,
  SyntheticMarket,
  TimeframeKey,
} from '../types/market';
import type { EngineScanSummary, ModelPerformanceRecord } from '../types/engine';
import type { MonitorScanSummary } from '../types/scanner';
import type { CoAnalysisResult, SignalFeedItem } from '../types/signals';
import type { SetupOrigin } from '../types/ranking';
import type { EntryModelAIValue } from '../hooks/useEntryModelAI';
import type { SignalLifecycle } from '../utils/signalStatus';

export type NavSection =
  | 'dashboard'
  | 'trade'
  | 'chart'
  | 'chartanalysis'
  | 'analyser'
  | 'scanner'
  | 'trendlines'
  | 'demandsupply'
  | 'boschoch'
  | 'technical'
  | 'smc'
  | 'liquidity'
  | 'fvg'
  | 'orderblock'
  | 'momentum'
  | 'regime'
  | 'confluence'
  | 'live'
  | 'entrymodel'
  | 'performance'
  | 'risk'
  | 'alerts'
  | 'strategylab'
  | 'health'
  | 'training'
  | 'history'
  | 'settings'
  /* ------------------- visual strategy workspace (Phase 1) ------------------- */
  | 'botbuilder'
  | 'mybots'
  | 'aiintelligence';

export interface WorkspaceValue {
  // Market / connection
  markets: SyntheticMarket[];
  marketsLoading: boolean;
  selectedSymbol: string;
  selectedMarket: SyntheticMarket | null;
  marketName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  /** Active timeframe length in seconds (drives the right-edge candle countdown). */
  granularitySec: number;
  precision: number;
  connectionStatus: ConnectionStatus;
  connectionError: DerivErrorInfo | null;
  /** Live connection diagnostics: retries, last error, last message/tick time. */
  diagnostics: ConnectionDiagnostics;
  /** Epoch ms of the last live tick received, or null if none yet. */
  lastTickAt: number | null;
  /** True when the live feed is disconnected or has not ticked recently. */
  feedStale: boolean;

  // Chart data
  dataset: CandleDataset;
  candles: Candle[];
  liveTick: LiveCandleTick | null;
  loadState: ChartLoadState;
  dataError: string | null;
  isLoadingOlder: boolean;
  livePrice: number | null;

  // Analysis
  controlMode: AnalysisControlMode;
  runState: AnalysisRunState;
  report: FullAnalysisReport | null;
  isAnalyzing: boolean;
  analysisError: string | null;
  canRunAnalysis: boolean;
  lifecycle: SignalLifecycle | null;

  // Scanner (breadth engine: live monitor readings + its own best setup)
  isScanning: boolean;
  scanProgress: number;
  progressMessage: string;
  monitorSummary: MonitorScanSummary | null;
  /** Scanner's own single best setup from the last pass (null when none qualified). */
  scannerSummary: EngineScanSummary | null;
  analyserTimeframe: TimeframeKey;
  setAnalyserTimeframe: (tf: TimeframeKey) => void;
  include1Sec: boolean;
  autoRefresh: boolean;
  lastScannedAt: number | null;
  performanceRecords: ModelPerformanceRecord[];

  // Dual-engine co-analysis + unified signal feed
  /** Scanner × analyser reconciliation for the currently selected instrument. */
  coAnalysis: CoAnalysisResult | null;
  /** Merged, clickable feed of signals from both engines. */
  signalFeed: SignalFeedItem[];
  /** Play the confirmation chime (also used by the settings test button). */
  playSignalSound: (kind?: 'validated' | 'scanner' | 'analyser' | 'invalidated') => void;
  /** Scanner evidence being reproduced on the chart, if a scanner signal was opened. */
  pendingSnapshot: SignalSnapshot | null;
  clearPendingSnapshot: () => void;

  // Settings
  settings: AppSettings;

  // Actions
  selectMarket: (symbol: string) => void;
  selectTimeframe: (tf: TimeframeKey) => void;
  reconnect: () => void;
  loadOlderCandles: () => void;

  startAnalysis: () => void;
  pauseAnalysis: () => void;
  resumeAnalysis: () => void;
  stopAnalysis: () => void;

  setDirectionPreference: (pref: DirectionPreference) => void;
  setMinQuality: (quality: AppSettings['minQuality']) => void;
  toggleOverlay: (key: keyof AppSettings['overlays']) => void;
  setCompactChart: (compact: boolean) => void;
  setTheme: (theme: AppSettings['theme']) => void;
  toggleTheme: () => void;
  setAccentMode: (mode: AppSettings['accentMode']) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setSoundVolume: (volume: number) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  resetSettings: () => void;

  setScannerTimeframe: (tf: TimeframeKey) => void;
  setInclude1Sec: (include: boolean) => void;
  setAutoRefresh: (enabled: boolean) => void;
  scanMarkets: () => void;
  cancelScan: () => void;
  refreshValidationSettlement: () => void;
  /** Records a Chart Analyser confirmed signal into the model-performance ledger. */
  recordAnalyserSignal: (params: { direction: 'RISE' | 'FALL'; entryPrice: number }) => void;
  /** Records a shared-validated (dual-engine) signal into trade history. */
  recordValidatedSignal: (item: SignalFeedItem) => void;

  openChart: (symbol: string, tf: TimeframeKey, snapshot?: SignalSnapshot | null) => void;
  openAnalyser: (symbol: string, tf: TimeframeKey, snapshot?: SignalSnapshot | null) => void;
  /** Opens a ranked setup in the dedicated CHART ANALYSIS tab, preserving its origin. */
  openSetupInChartAnalysis: (
    symbol: string,
    tf: TimeframeKey,
    origin: SetupOrigin | null
  ) => void;
  /** The setup currently opened in the CHART ANALYSIS tab (its originating AI details). */
  chartAnalysisSetup: SetupOrigin | null;
  clearChartAnalysisSetup: () => void;
  navigate: (section: NavSection) => void;

  // AI training & backtesting
  training: TrainingEngineValue;
  // Dedicated Trendline Scanner strategy module (independent of the price-action engine).
  trendlineScanner: TrendlineScannerValue;
  // Demand & Supply AI strategy module (independent of every other engine).
  demandSupplyScanner: DemandSupplyScannerValue;
  // Live trade management (locked entry/SL, dynamic take-profit)
  managedSignals: ManagedSignal[];
  openManagedSignals: ManagedSignal[];
  getManagedSignal: (id: string) => ManagedSignal | null;

  /** UNIVERSAL ENTRY MODEL AI — best entry model per qualified setup, across all strategies. */
  entryModelAI: EntryModelAIValue;

  /**
   * AUTOMATIC CHART RESET & FRESH-ENTRY CYCLE for the Chart Analyser — completion
   * detection, completed-trade recording, automatic chart cleanup and fresh-entry status.
   */
  analyserCycle: AnalyserCycleValue;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return ctx;
}
