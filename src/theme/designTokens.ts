/**
 * GLOBAL DESIGN SYSTEM — single source of truth for the chart canvas and semantic colours.
 *
 * The candlestick chart always renders on a pure white canvas with the fixed teal/red candle
 * colours, independent of the surrounding theme or the selected AI module. Nothing here is
 * ever derived from a signal, so a theme switch can never recolour a candle.
 */
export const CHART_COLORS = {
  background: '#FFFFFF',
  grid: '#EEF1F4',
  priceLine: '#64748B',
  priceScale: '#475569',
  axisBorder: '#E5E9F0',
  crosshairLabel: '#334155',
  bullish: '#089981',
  bearish: '#F23645',
} as const;

/** Semantic interface colours, used consistently across every module. */
export const UI_COLORS = {
  bullish: '#2563EB',
  bearish: '#EF4444',
  watch: '#3B82F6',
  neutral: '#64748B',
  warning: '#F59E0B',
  success: '#16A34A',
} as const;

export type ConnectionTone = 'LIVE' | 'CONNECTING' | 'RECONNECTING' | 'DISCONNECTED';

export const CONNECTION_TONES: Record<ConnectionTone, string> = {
  LIVE: 'text-emerald-600',
  CONNECTING: 'text-amber-500',
  RECONNECTING: 'text-orange-500',
  DISCONNECTED: 'text-red-500',
};
