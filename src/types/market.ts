export type TimeframeKey =
  | 'H4'
  | 'H1'
  | 'M30'
  | 'M15'
  | 'M10'
  | 'M7'
  | 'M6'
  | 'M5'
  | 'M4'
  | 'M3'
  | 'M2'
  | 'M1';

export type MarketFamily = 'VOLATILITY' | 'JUMP' | 'STEP' | 'RANGE_BREAK' | 'OTHER';

export interface TimeframeConfig {
  key: TimeframeKey;
  label: string;
  /** Logical candle size in seconds (M7 = 420, M3 = 180). */
  granularitySec: number;
  /**
   * Granularity actually requested from Deriv. Identical to `granularitySec` for every
   * native timeframe; for the internally-built M7 series it is the M1 source (60s) because
   * Deriv's documented candle granularities do not include 420 seconds.
   */
  sourceGranularitySec: number;
  /** True when the series is built internally from `sourceGranularitySec` candles. */
  derived: boolean;
}

export interface Candle {
  time: number; // Unix timestamp in seconds (candle open time)
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SyntheticMarket {
  symbol: string;
  displayName: string;
  submarket: string;
  submarketDisplayName: string;
  family: MarketFamily;
  pip: number;
  precision: number;
  isOpen: boolean;
  isSuspended: boolean;
}

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'rate_limited'
  | 'stale'
  | 'disconnected'
  | 'error';

/** Human-facing connection labels — the compact status the UI shows. */
export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'CONNECTED',
  connecting: 'CONNECTING',
  reconnecting: 'RECONNECTING',
  rate_limited: 'RATE LIMITED',
  stale: 'STALE DATA',
  disconnected: 'DISCONNECTED',
  error: 'DISCONNECTED',
};

export type ChartLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error';

export interface CrosshairReadout {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePercent: number;
  isLiveBar: boolean;
}

export interface DerivErrorInfo {
  code?: string;
  message: string;
}
