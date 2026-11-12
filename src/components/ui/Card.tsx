import React from 'react';

const CARD_VARIANT = {
  default: 'bg-[#101829] border-[#273449]',
  raised: 'bg-[#172238] border-[#273449]',
  elevated: 'bg-[#1B2740] border-[#2E3D57]'
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
    className={`rounded-[14px] border shadow-[0_1px_2px_rgba(0,0,0,0.35)] ${
      CARD_VARIANT[variant]
    } ${interactive ? 'transition-colors hover:border-[#3A4C6B]' : ''} ${className}`}
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
    className={`flex flex-wrap items-center justify-between gap-3 border-b border-[#273449] px-4 py-3 ${className}`}
  >
    <div className="flex min-w-0 items-center gap-2.5">
      {icon && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-[#273449] bg-[#172238] text-[#8B85FF]">
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
