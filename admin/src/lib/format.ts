/** Presentation helpers. Pure functions — no React, no side effects. */

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatCurrency(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: [number, string][] = [
    [60_000, 'second'],
    [3_600_000, 'minute'],
    [86_400_000, 'hour'],
    [2_592_000_000, 'day'],
    [31_536_000_000, 'month']
  ];
  if (abs < 45_000) return 'just now';
  let value = 0;
  let unit = 'second';
  if (abs < 60_000) { value = Math.round(abs / 1000); unit = 'second'; }
  else if (abs < 3_600_000) { value = Math.round(abs / 60_000); unit = 'minute'; }
  else if (abs < 86_400_000) { value = Math.round(abs / 3_600_000); unit = 'hour'; }
  else if (abs < 2_592_000_000) { value = Math.round(abs / 86_400_000); unit = 'day'; }
  else if (abs < 31_536_000_000) { value = Math.round(abs / 2_592_000_000); unit = 'month'; }
  else { value = Math.round(abs / 31_536_000_000); unit = 'year'; }
  const plural = value === 1 ? '' : 's';
  void units;
  return future ? `in ${value} ${unit}${plural}` : `${value} ${unit}${plural} ago`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Renders a human label from a machine action key such as `user.suspend`. */
export function humanizeAction(action: string): string {
  return action
    .split('.')
    .map((p) => p.replace(/_/g, ' '))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' → ');
}

export function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Maps a status token to a badge colour class. */
export function statusTone(status: string): string {
  switch (status) {
    case 'active':
    case 'published':
    case 'resolved':
    case 'HEALTHY':
      return 'badge-green';
    case 'suspended':
    case 'archived':
    case 'OFFLINE':
    case 'urgent':
      return 'badge-red';
    case 'invited':
    case 'scheduled':
    case 'in_progress':
    case 'waiting_for_user':
    case 'high':
    case 'DEGRADED':
      return 'badge-amber';
    case 'draft':
    case 'closed':
    case 'low':
    case 'UNKNOWN':
      return 'badge-slate';
    default:
      return 'badge-blue';
  }
}
