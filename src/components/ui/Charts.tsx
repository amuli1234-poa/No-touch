import React from 'react';
import { TONE_HEX, Tone } from './format';

/* Lightweight dependency-free SVG charts. Kept intentionally small — these are
   presentation primitives fed by real scanner/calibration data. */

interface SparklineProps {
  data: number[];
  tone?: Tone;
  height?: number;
  className?: string;
  max?: number;
  min?: number;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data,
  tone = 'accent',
  height = 40,
  className = '',
  max,
  min
}) => {
  if (data.length === 0) return <div className={`skeleton rounded-[6px] ${className}`} style={{ height }} />;

  const w = 100;
  const h = 100;
  const lo = min ?? Math.min(...data);
  const hi = max ?? Math.max(...data);
  const span = hi - lo || 1;
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data.map((v, i) => `${i * step},${h - ((v - lo) / span) * h}`);
  const line = `M ${points.join(' L ')}`;
  const area = `${line} L ${w},${h} L 0,${h} Z`;
  const color = TONE_HEX[tone];

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: '100%' }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`spark-${tone}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${tone})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

interface BarChartProps {
  data: { label: string; value: number; tone?: Tone }[];
  height?: number;
  valueSuffix?: string;
  className?: string;
}

export const BarChart: React.FC<BarChartProps> = ({
  data,
  height = 160,
  valueSuffix = '',
  className = ''
}) => {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={className} style={{ height }}>
      <div className="flex h-full items-end gap-2">
        {data.map((d) => {
          const pct = (d.value / max) * 100;
          return (
            <div key={d.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
              <span className="tabular text-[10.5px] font-semibold text-slate-300">
                {d.value}
                {valueSuffix}
              </span>
              <div
                className="w-full rounded-t-[5px] transition-[height] duration-500"
                style={{
                  height: `${Math.max(pct, d.value > 0 ? 3 : 0)}%`,
                  backgroundColor: TONE_HEX[d.tone ?? 'accent']
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        {data.map((d) => (
          <div
            key={d.label}
            className="min-w-0 flex-1 truncate text-center text-[10px] text-slate-500"
            title={d.label}
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
};

interface DonutProps {
  segments: { value: number; tone: Tone; label: string }[];
  size?: number;
  centerLabel?: string;
  centerValue?: string;
}

export const Donut: React.FC<DonutProps> = ({ segments, size = 132, centerLabel, centerValue }) => {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox="0 0 132 132" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="66" cy="66" r={radius} fill="none" stroke="#0b1220" strokeWidth="12" />
        {total > 0 &&
          segments.map((s, i) => {
            const length = (s.value / total) * circumference;
            const el = (
              <circle
                key={i}
                cx="66"
                cy="66"
                r={radius}
                fill="none"
                stroke={TONE_HEX[s.tone]}
                strokeWidth="12"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += length;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {centerValue && (
          <span className="tabular text-[20px] font-bold leading-none text-white">{centerValue}</span>
        )}
        {centerLabel && (
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            {centerLabel}
          </span>
        )}
      </div>
    </div>
  );
};

interface AreaSeriesProps {
  points: { label: string; value: number }[];
  tone?: Tone;
  height?: number;
  suffix?: string;
}

export const AreaSeries: React.FC<AreaSeriesProps> = ({
  points,
  tone = 'accent',
  height = 170,
  suffix = ''
}) => {
  if (points.length === 0)
    return <div className="skeleton rounded-[8px]" style={{ height }} />;

  const w = 320;
  const h = 120;
  const pad = 8;
  const values = points.map((p) => p.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const span = hi - lo || 1;
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const xy = points.map((p, i) => {
    const x = pad + i * step;
    const y = h - pad - ((p.value - lo) / span) * (h - pad * 2);
    return [x, y] as const;
  });
  const line = `M ${xy.map(([x, y]) => `${x},${y}`).join(' L ')}`;
  const area = `${line} L ${xy[xy.length - 1][0]},${h} L ${xy[0][0]},${h} Z`;
  const color = TONE_HEX[tone];

  return (
    <div style={{ height }} className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id={`area-${tone}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line
            key={g}
            x1={pad}
            x2={w - pad}
            y1={h - pad - g * (h - pad * 2)}
            y2={h - pad - g * (h - pad * 2)}
            stroke="#162133"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        <path d={area} fill={`url(#area-${tone})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {xy.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2.5" fill={color} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mt-1.5 flex justify-between text-[10px] text-slate-500">
        {points.map((p) => (
          <span key={p.label} className="truncate">
            {p.label}
            {suffix && <span className="ml-1 text-slate-600">{suffix}</span>}
          </span>
        ))}
      </div>
    </div>
  );
};
