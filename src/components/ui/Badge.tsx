import React from 'react';
import { TONE_BG, TONE_HEX, Tone } from './format';

interface BadgeProps {
  children: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  className?: string;
  dot?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  tone = 'neutral',
  icon,
  className = '',
  dot = false
}) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[10.5px] font-semibold uppercase tracking-wide ${TONE_BG[tone]} ${className}`}
  >
    {dot && (
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TONE_HEX[tone] }} />
    )}
    {icon}
    {children}
  </span>
);

interface StatusDotProps {
  tone: Tone;
  pulse?: boolean;
  size?: 'sm' | 'md';
  label?: string;
}

export const StatusDot: React.FC<StatusDotProps> = ({
  tone,
  pulse = false,
  size = 'sm',
  label
}) => (
  <span className="inline-flex items-center gap-2">
    <span
      className={`rounded-full ${size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5'} ${
        pulse ? 'pulse-live' : ''
      }`}
      style={{ backgroundColor: TONE_HEX[tone] }}
    />
    {label && <span className="text-[11px] font-medium text-slate-300">{label}</span>}
  </span>
);
