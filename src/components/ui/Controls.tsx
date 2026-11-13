import React from 'react';

/* --------------------------------------------------------------------------
   Button
   -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent border-accent hover:bg-accent-strong hover:border-accent-strong shadow-[var(--shadow-accent)]',
  secondary:
    'bg-surface-raised text-fg-2 border-line hover:bg-surface-elevated hover:border-line-strong',
  ghost: 'bg-transparent text-fg-4 border-transparent hover:bg-surface-raised hover:text-fg-1',
  danger:
    'bg-danger/10 text-danger border-danger/30 hover:bg-danger/20'
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[12px] gap-1.5',
  md: 'h-9 px-3.5 text-[13px] gap-2'
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  block?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  block = false,
  className = '',
  children,
  ...rest
}) => (
  <button
    {...rest}
    className={`inline-flex items-center justify-center rounded-[10px] border font-semibold tracking-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
      BUTTON_VARIANT[variant]
    } ${BUTTON_SIZE[size]} ${block ? 'w-full' : ''} ${className}`}
  >
    {icon}
    {children}
  </button>
);

/* --------------------------------------------------------------------------
   IconButton
   -------------------------------------------------------------------------- */

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const IconButton: React.FC<IconButtonProps> = ({
  label,
  active = false,
  className = '',
  children,
  ...rest
}) => (
  <button
    {...rest}
    aria-label={label}
    title={label}
    className={`inline-flex h-8 w-8 items-center justify-center rounded-[9px] border transition-colors disabled:opacity-40 ${
      active
        ? 'border-accent/40 bg-accent/15 text-accent-soft'
        : 'border-line bg-surface-raised text-fg-4 hover:border-line-strong hover:text-fg-1'
    } ${className}`}
  >
    {children}
  </button>
);

/* --------------------------------------------------------------------------
   SegmentedControl
   -------------------------------------------------------------------------- */

interface SegmentedControlProps<T extends string> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  labels?: Partial<Record<T, string>>;
  size?: 'sm' | 'md';
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labels,
  size = 'sm',
  className = ''
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-surface-deepest p-0.5 ${className}`}
    >
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            aria-pressed={active}
            className={`rounded-[8px] font-semibold tracking-tight transition-colors ${
              size === 'sm' ? 'px-2.5 py-1 text-[11.5px]' : 'px-3 py-1.5 text-[12.5px]'
            } ${
              active
                ? 'bg-accent text-on-accent shadow-[var(--shadow-control)]'
                : 'text-fg-4 hover:bg-surface-raised hover:text-fg-1'
            }`}
          >
            {labels?.[opt] ?? opt}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Toggle
   -------------------------------------------------------------------------- */

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
      checked ? 'border-accent bg-accent' : 'border-line bg-surface-raised'
    }`}
  >
    <span
      className={`absolute top-0.5 rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
      }`}
      style={{ height: 18, width: 18 }}
    />
  </button>
);

/* --------------------------------------------------------------------------
   Select
   -------------------------------------------------------------------------- */

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string }[];
}

export const Select: React.FC<SelectProps> = ({ options, className = '', ...rest }) => (
  <select
    {...rest}
    className={`h-9 w-full appearance-none rounded-[10px] border border-line bg-surface-deepest px-3 text-[13px] text-fg-1 transition-colors hover:border-line-strong focus:border-accent focus:outline-none ${className}`}
  >
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

/* --------------------------------------------------------------------------
   Field — labelled form row
   -------------------------------------------------------------------------- */

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}

export const Field: React.FC<FieldProps> = ({ label, hint, children, className = '' }) => (
  <div className={className}>
    <label className="mb-1.5 block text-[12px] font-medium text-fg-3">{label}</label>
    {children}
    {hint && <p className="mt-1 text-[11px] text-fg-5">{hint}</p>}
  </div>
);
