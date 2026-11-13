import { OpportunityStatus } from '../../types/scanner';

/* --------------------------------------------------------------------------
   Number & value formatting
   -------------------------------------------------------------------------- */

export function formatPrice(value: number | undefined | null, digits = 3): string {
  if (value === undefined || value === null || Number.isNaN(value) || value === 0) return '—';
  return value.toFixed(digits);
}

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function formatSigned(value: number, digits = 2): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(digits)}`;
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function formatClock(epochMs: number): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function formatRelative(epochMs: number): string {
  if (!epochMs) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/* --------------------------------------------------------------------------
   Status semantics — one vocabulary for the whole application
   -------------------------------------------------------------------------- */

export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export const STATUS_LABEL: Record<OpportunityStatus, string> = {
  QUALIFIED: 'Qualified',
  WATCHLIST: 'Watchlist',
  REJECTED: 'Rejected',
  WAITING: 'Pending',
  INVALIDATED: 'Invalidated',
  EXPIRED: 'Expired',
  DATA_UNAVAILABLE: 'Insufficient data'
};

export function statusTone(status: OpportunityStatus): Tone {
  switch (status) {
    case 'QUALIFIED':
      return 'success';
    case 'WATCHLIST':
      return 'warning';
    case 'REJECTED':
    case 'INVALIDATED':
      return 'danger';
    case 'WAITING':
      return 'info';
    default:
      return 'neutral';
  }
}

export function scoreTone(score: number): Tone {
  if (score >= 90) return 'success';
  if (score >= 80) return 'warning';
  if (score > 0) return 'neutral';
  return 'neutral';
}

export function biasTone(direction: string): Tone {
  if (direction === 'BULLISH') return 'success';
  if (direction === 'BEARISH') return 'danger';
  return 'neutral';
}

export function volatilityTone(regime: 'LOW' | 'MEDIUM' | 'HIGH'): Tone {
  if (regime === 'HIGH') return 'danger';
  if (regime === 'MEDIUM') return 'warning';
  return 'success';
}

/* --------------------------------------------------------------------------
   Design-system class tokens shared across components
   -------------------------------------------------------------------------- */

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-slate-400',
  accent: 'text-[#2E8AD8]',
  info: 'text-sky-400',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  danger: 'text-rose-400'
};

export const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-slate-500/10 text-slate-300 border-slate-600/40',
  accent: 'bg-[#0068B5]/12 text-[#60A5FA] border-[#0068B5]/30',
  info: 'bg-sky-500/12 text-sky-300 border-sky-500/30',
  success: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/30',
  warning: 'bg-amber-500/12 text-amber-300 border-amber-500/30',
  danger: 'bg-rose-500/12 text-rose-300 border-rose-500/30'
};

export const TONE_HEX: Record<Tone, string> = {
  neutral: '#64748B',
  accent: '#0068B5',
  info: '#38BDF8',
  success: '#16A34A',
  warning: '#F59E0B',
  danger: '#DC2626'
};
