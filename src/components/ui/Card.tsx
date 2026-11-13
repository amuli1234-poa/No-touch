import React from 'react';

const CARD_VARIANT = {
  default: 'bg-[#0d1420] border-[#1e2b40]',
  raised: 'bg-[#121b2b] border-[#1e2b40]',
  elevated: 'bg-[#162133] border-[#24344c]',
  glass: 'bg-[#0d1420]/72 border-[#ffffff14] backdrop-blur-xl backdrop-saturate-150'
} as const;

interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: keyof typeof CARD_VARIANT;
  interactive?: boolean;
}

export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  variant = 'default',
  interactive = false
}) => (
  <div
    className={`rounded-[16px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_16px_rgba(0,0,0,0.2),0_20px_60px_-24px_rgba(0,0,0,0.55)] ${
      CARD_VARIANT[variant]
    } ${interactive ? 'transition-colors hover:border-[#2f4258]' : ''} ${className}`}
  >
    {children}
  </div>
);

interface CardHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const CardHeader: React.FC<CardHeaderProps> = ({
  title,
  subtitle,
  icon,
  actions,
  className = ''
}) => (
  <div
    className={`flex flex-wrap items-center justify-between gap-3 border-b border-[#1e2b40] px-4 py-3 ${className}`}
  >
    <div className="flex min-w-0 items-center gap-2.5">
      {icon && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-[#1e2b40] bg-[#121b2b] text-[#2E8AD8]">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold tracking-tight text-slate-100">
          {title}
        </div>
        {subtitle && <div className="truncate text-[11px] text-slate-500">{subtitle}</div>}
      </div>
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </div>
);

interface CardBodyProps {
  children: React.ReactNode;
  className?: string;
}

export const CardBody: React.FC<CardBodyProps> = ({ children, className = '' }) => (
  <div className={`p-4 ${className}`}>{children}</div>
);
