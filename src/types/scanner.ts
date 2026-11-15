import type { MarketFamily, TimeframeKey } from './market';

/**
 * Descriptive, monitor-only instrument reading produced by the Market Scanner so a
 * user can pick an instrument. Carries no direction/entry/confidence — signals come
 * from the signal engine.
 */
export interface InstrumentMonitorReading {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  price: number;
  lastCandleChangePercent: number | null;
  candlesCount: number;
  activityLabel: 'Active' | 'Quiet' | 'Stale' | 'Closed' | 'Unavailable';
  dataHealth: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  /** Descriptive recent range vs price. Not a signal. */
  volatilityPercent: number | null;
  lastUpdated: number;
}

export interface MonitorScanSummary {
  readings: InstrumentMonitorReading[];
  monitoredCount: number;
  activeCount: number;
  staleCount: number;
  scannedAt: number;
  timeframe: TimeframeKey;
}

// The signal engine's scan summary lives with the engine types.
export type { EngineScanSummary, EngineSignal, InstrumentAnalysis } from './engine';
