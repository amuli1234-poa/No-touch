import React from 'react';

export const BRAND = {
  name: 'WickSentinel',
  tagline: 'See Beyond the Candles. Understand the Market.',
  category: 'Independent Market Intelligence Platform'
} as const;

/**
 * WickSentinel mark — a candlestick with a sweeping "sentinel" arc above it,
 * reading as a watchful eye over the wick. Drawn as vectors so it stays crisp
 * at every size and inherits the brand gradient.
 */
export const WickSentinelMark: React.FC<{ className?: string }> = ({ className = 'h-9 w-9' }) => (
  <svg viewBox="0 0 40 40" className={className} role="img" aria-label="WickSentinel">
    <defs>
      <linearGradient id="ws-mark-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#0068B5" />
        <stop offset="100%" stopColor="#38BDF8" />
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="40" height="40" rx="11" fill="url(#ws-mark-grad)" />
    <rect x="0" y="0" width="40" height="40" rx="11" fill="#060b16" opacity="0.14" />
    {/* sentinel arc — the watchful sweep */}
    <path
      d="M8.5 16.5c3.6-5.4 8.5-8 11.5-8s7.9 2.6 11.5 8"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="2.1"
      strokeLinecap="round"
      opacity="0.92"
    />
    <circle cx="20" cy="12.2" r="2.3" fill="#FFFFFF" />
    {/* candle body + wicks */}
    <path d="M13.6 20.5v11" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" opacity="0.85" />
    <path d="M26.4 19v9.5" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" opacity="0.85" />
    <rect x="10.9" y="23" width="5.4" height="6.4" rx="1.4" fill="#FFFFFF" />
    <rect x="23.7" y="21.4" width="5.4" height="6.4" rx="1.4" fill="#FFFFFF" opacity="0.9" />
  </svg>
);

interface BrandLogoProps {
  className?: string;
  markClassName?: string;
  showTagline?: boolean;
  onClick?: () => void;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  className = '',
  markClassName = 'h-9 w-9',
  showTagline = false,
  onClick
}) => {
  const content = (
    <>
      <WickSentinelMark className={markClassName} />
      <span className="min-w-0 text-left">
        <span className="block text-[15.5px] font-extrabold leading-tight tracking-[-0.02em] text-fg-1">
          Wick<span className="text-accent-strong">Sentinel</span>
        </span>
        {showTagline ? (
          <span className="block text-[11px] font-medium tracking-[0.02em] text-fg-5">
            {BRAND.category}
          </span>
        ) : (
          <span className="block text-[10.5px] font-semibold uppercase tracking-[0.18em] text-fg-5">
            Market Intelligence
          </span>
        )}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`flex items-center gap-2.5 rounded-[10px] transition-opacity hover:opacity-90 ${className}`}
        aria-label="WickSentinel home"
      >
        {content}
      </button>
    );
  }

  return <div className={`flex items-center gap-2.5 ${className}`}>{content}</div>;
};
