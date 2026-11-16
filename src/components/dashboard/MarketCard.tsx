import { Activity, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { InstrumentMonitorReading } from '../../types/scanner';
import { formatPrice } from '../../utils/derivParser';

/**
 * Animated market card showing live readings for one instrument. Colour and icon
 * both encode direction so bullish/bearish is legible without relying on hue alone.
 */
export function MarketCard({
  reading,
  selected,
  onSelect,
}: {
  reading: InstrumentMonitorReading;
  selected: boolean;
  onSelect: () => void;
}) {
  const change = reading.lastCandleChangePercent;
  const bullish = change !== null && change > 0;
  const bearish = change !== null && change < 0;
  const DirIcon = bullish ? TrendingUp : bearish ? TrendingDown : Minus;
  const tone = bullish ? 'text-emerald-400' : bearish ? 'text-bear' : 'text-muted';
  const ring = bullish
    ? 'border-emerald-500/35'
    : bearish
      ? 'border-red-500/35'
      : 'border-line';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group relative overflow-hidden text-left bg-surface border rounded-xl px-3 py-2.5 transition-all duration-300 cursor-pointer hover:-translate-y-0.5 ${
        selected ? 'border-accent/60 glow-accent' : ring
      }`}
    >
      <span
        className={`pointer-events-none absolute -right-6 -top-6 w-16 h-16 rounded-full blur-2xl opacity-40 transition-opacity group-hover:opacity-70 ${
          bullish ? 'bg-emerald-500/40' : bearish ? 'bg-red-500/40' : 'bg-accent/30'
        }`}
        aria-hidden="true"
      />
      <div className="relative flex items-center justify-between gap-2">
        <span className="text-[12px] font-bold text-ink truncate">{reading.displayName}</span>
        <span className="shrink-0 inline-flex items-center gap-1">
          {reading.activityLabel === 'Active' && (
            <span className="relative flex w-1.5 h-1.5">
              <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 animate-live-ping" />
              <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-400" />
            </span>
          )}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            {reading.activityLabel}
          </span>
        </span>
      </div>

      <div className="relative flex items-end justify-between gap-2 mt-1.5">
        <span className="font-mono text-sm font-bold tabular-nums text-ink">
          {formatPrice(reading.price, reading.precision)}
        </span>
        <span className={`inline-flex items-center gap-1 text-[12px] font-bold font-mono ${tone}`}>
          <DirIcon className="w-3.5 h-3.5" aria-hidden="true" />
          {change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(3)}%`}
        </span>
      </div>

      <div className="relative flex items-center gap-1 mt-1.5 text-[10px] text-faint font-mono">
        <Activity className="w-2.5 h-2.5" aria-hidden="true" />
        {reading.volatilityPercent !== null
          ? `range ${reading.volatilityPercent.toFixed(2)}%`
          : 'range n/a'}
        <span className="ml-auto">{reading.candlesCount} bars</span>
      </div>
    </button>
  );
}
