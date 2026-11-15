export type TimeframeKey = 'H4' | 'H1' | 'M15' | 'M5' | 'M1';

export type MarketFamily = 'VOLATILITY' | 'JUMP' | 'STEP' | 'RANGE_BREAK' | 'OTHER';

export interface TimeframeConfig {
  key: TimeframeKey;
  label: string;
  granularitySec: number;
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
  | 'disconnected'
  | 'error';

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
