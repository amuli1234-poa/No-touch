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
  neutral: 'text-fg-4',
  accent: 'text-accent-strong',
  info: 'text-accent-cyan',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger'
};

export const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-fg-5/10 text-fg-3 border-line-strong/40',
  accent: 'bg-accent/12 text-accent-soft border-accent/30',
  info: 'bg-accent-cyan/12 text-accent-cyan border-accent-cyan/30',
  success: 'bg-success/12 text-success border-success/30',
  warning: 'bg-warning/12 text-warning border-warning/30',
  danger: 'bg-danger/12 text-danger border-danger/30'
};

/* Tone colours for inline styles and SVG attributes. These resolve through CSS
   variables so they follow the active theme; the literals are fallbacks for the
   dark palette (used if a var is ever unresolved). */
export const TONE_HEX: Record<Tone, string> = {
  neutral: 'var(--fg-4, #94A3B8)',
  accent: 'var(--accent, #0068B5)',
  info: 'var(--accent-cyan, #38BDF8)',
  success: 'var(--success, #4ADE80)',
  warning: 'var(--warning, #FBBF24)',
  danger: 'var(--danger, #F87171)'
};

/** Colour for a 0–100 score bar/figure, matching `scoreTone`. */
export function scoreHex(score: number): string {
  if (score >= 90) return TONE_HEX.success;
  if (score >= 80) return TONE_HEX.warning;
  return TONE_HEX.neutral;
}
