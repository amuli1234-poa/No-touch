import React from 'react';
import { Card } from './Card';
import { TONE_HEX, Tone } from './format';

/* --------------------------------------------------------------------------
   StatCard — KPI tile used across scanner / performance dashboards
   -------------------------------------------------------------------------- */

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: Tone;
  icon?: React.ReactNode;
  trend?: { value: string; tone: Tone };
}

export const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  trend
}) => (
  <Card className="relative overflow-hidden p-3.5">
    <div
      className="absolute inset-x-0 top-0 h-px"
      style={{ background: `linear-gradient(90deg, transparent, ${TONE_HEX[tone]}, transparent)` }}
    />
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-slate-500">
        {label}
      </span>
      {icon && (
        <span className="text-slate-500" style={{ color: TONE_HEX[tone] }}>
          {icon}
        </span>
      )}
    </div>
    <div className="mt-2 flex items-end gap-2">
      <span
        className="tabular text-[26px] font-bold leading-none tracking-tight"
        style={{ color: tone === 'neutral' ? '#F8FAFC' : TONE_HEX[tone] }}
      >
        {value}
      </span>
      {trend && (
        <span className="mb-0.5 text-[11px] font-semibold" style={{ color: TONE_HEX[trend.tone] }}>
          {trend.value}
        </span>
      )}
    </div>
    {hint && <div className="mt-1.5 truncate text-[11px] text-slate-500">{hint}</div>}
  </Card>
);

/* --------------------------------------------------------------------------
   EmptyState
   -------------------------------------------------------------------------- */

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: Tone;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  className = ''
}) => (
  <div className={`flex flex-col items-center justify-center gap-2 px-6 py-12 text-center ${className}`}>
    {icon && (
      <span
        className="flex h-11 w-11 items-center justify-center rounded-full border border-[#273449] bg-[#172238]"
        style={{ color: TONE_HEX[tone] }}
      >
        {icon}
      </span>
    )}
    <div className="text-[13px] font-semibold text-slate-200">{title}</div>
    {description && <div className="max-w-sm text-[12px] leading-relaxed text-slate-500">{description}</div>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);

/* --------------------------------------------------------------------------
   Skeleton rows for loading states
   -------------------------------------------------------------------------- */

export const SkeletonRows: React.FC<{ rows?: number; className?: string }> = ({
  rows = 6,
  className = ''
}) => (
  <div className={`space-y-2 p-3 ${className}`}>
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="skeleton h-9 rounded-[8px]" />
    ))}
  </div>
);

/* --------------------------------------------------------------------------
   SectionTitle — consistent page section heading
   -------------------------------------------------------------------------- */

interface SectionTitleProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export const SectionTitle: React.FC<SectionTitleProps> = ({
  eyebrow,
  title,
  description,
  actions
}) => (
  <div className="flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0">
      {eyebrow && (
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#8B85FF]">
          {eyebrow}
        </div>
      )}
      <h1 className="mt-1 text-[19px] font-bold tracking-tight text-white">{title}</h1>
      {description && <p className="mt-1 text-[12.5px] text-slate-400">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>
);
