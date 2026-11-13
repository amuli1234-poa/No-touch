import React from 'react';

const CARD_VARIANT = {
  default: 'bg-surface border-line',
  raised: 'bg-surface-raised border-line',
  elevated: 'bg-surface-elevated border-line-strong',
  glass: 'bg-surface/72 border-line-soft backdrop-blur-xl backdrop-saturate-150'
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
    className={`rounded-[16px] border shadow-[var(--shadow-card)] ${
      CARD_VARIANT[variant]
    } ${interactive ? 'transition-colors hover:border-line-strong' : ''} ${className}`}
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
    className={`flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 ${className}`}
  >
    <div className="flex min-w-0 items-center gap-2.5">
      {icon && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-line bg-surface-raised text-accent-strong">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold tracking-tight text-fg-1">
          {title}
        </div>
        {subtitle && <div className="truncate text-[11px] text-fg-5">{subtitle}</div>}
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
