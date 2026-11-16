import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-surface border border-line rounded-xl ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionCard({
  title,
  subtitle,
  right,
  icon,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-line-soft">
        <div className="flex items-start gap-2 min-w-0">
          {icon && <span className="text-accent shrink-0 mt-0.5">{icon}</span>}
          <div className="min-w-0">
            <h3 className="text-[13px] font-bold text-ink tracking-tight">
              {title}
            </h3>
            {subtitle && (
              <p className="text-[12px] text-muted leading-snug">{subtitle}</p>
            )}
          </div>
        </div>
        {right && <div className="shrink-0 max-w-full">{right}</div>}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

export function StatTile({
  label,
  value,
  valueClass = 'text-ink',
  hint,
}: {
  label: string;
  value: ReactNode;
  valueClass?: string;
  hint?: string;
}) {
  return (
    <div className="bg-panel border border-line rounded-lg px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
        {label}
      </div>
      <div className={`text-sm font-bold font-mono tabular-nums mt-0.5 ${valueClass}`}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-faint mt-0.5">{hint}</div>}
    </div>
  );
}

export function StatusPill({
  label,
  className = '',
  dotClass,
}: {
  label: string;
  className?: string;
  dotClass?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border ${className}`}
    >
      {dotClass && <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />}
      {label}
    </span>
  );
}

/** Inline horizontal bar for percentages (0–100). Pure, no dependencies. */
export function MeterBar({
  value,
  max = 100,
  className = 'bg-accent',
  trackClass = 'bg-elevated',
  height = 'h-2',
}: {
  value: number;
  max?: number;
  className?: string;
  trackClass?: string;
  height?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`w-full ${height} rounded-full overflow-hidden ${trackClass}`}>
      <div
        className={`h-full rounded-full transition-all ${className}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Minimal responsive SVG line chart for an equity curve (R multiples). */
export function EquitySparkline({
  points,
  width = 640,
  height = 140,
  strokeClass = 'stroke-accent',
}: {
  points: number[];
  width?: number;
  height?: number;
  strokeClass?: string;
}) {
  if (points.length < 2) {
    return (
      <div className="text-[12px] text-faint py-6 text-center">
        Not enough settled trades to plot an equity curve yet.
      </div>
    );
  }
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const toY = (v: number) => height - ((v - min) / span) * (height - 8) - 4;
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * stepX).toFixed(2)} ${toY(v).toFixed(2)}`)
    .join(' ');
  const zeroY = toY(0);
  const areaPath = `${path} L ${width} ${zeroY.toFixed(2)} L 0 ${zeroY.toFixed(2)} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-32"
      role="img"
      aria-label="Equity curve in R multiples"
    >
      <line
        x1={0}
        y1={zeroY}
        x2={width}
        y2={zeroY}
        className="stroke-line-soft"
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <path d={areaPath} className="fill-accent/10" />
      <path
        d={path}
        className={`fill-none ${strokeClass}`}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-12 px-6">
      {icon && (
        <div className="p-3.5 rounded-full bg-panel text-accent border border-line">
          {icon}
        </div>
      )}
      <div className="max-w-md space-y-1">
        <h3 className="text-base font-bold text-ink">{title}</h3>
        <p className="text-xs sm:text-sm text-muted leading-relaxed">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function CheckRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-line-soft last:border-0">
      <span
        className={`mt-0.5 w-4 h-4 rounded-full shrink-0 inline-flex items-center justify-center text-[11px] font-bold ${
          ok
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-panel text-faint'
        }`}
        aria-hidden="true"
      >
        {ok ? '✓' : '·'}
      </span>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-ink">{label}</div>
        {detail && <div className="text-[12px] text-muted leading-snug">{detail}</div>}
      </div>
    </div>
  );
}
