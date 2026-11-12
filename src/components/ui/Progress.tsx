import React from 'react';
import { TONE_HEX, Tone } from './format';

interface ProgressBarProps {
  value: number;
  max?: number;
  tone?: Tone;
  className?: string;
  height?: number;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  tone = 'accent',
  className = '',
  height = 6
}) => {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-[#0C1424] ${className}`}
      style={{ height }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%`, backgroundColor: TONE_HEX[tone] }}
      />
    </div>
  );
};

interface SegmentedBarProps {
  segments: { value: number; tone: Tone; label: string }[];
  height?: number;
  className?: string;
}

export const SegmentedBar: React.FC<SegmentedBarProps> = ({
  segments,
  height = 8,
  className = ''
}) => (
  <div
    className={`flex w-full overflow-hidden rounded-full bg-[#0C1424] ${className}`}
    style={{ height }}
  >
    {segments.map((s, i) => (
      <div
        key={i}
        title={s.label}
        style={{
          width: `${Math.max(0, Math.min(100, s.value))}%`,
          backgroundColor: TONE_HEX[s.tone]
        }}
      />
    ))}
  </div>
);
