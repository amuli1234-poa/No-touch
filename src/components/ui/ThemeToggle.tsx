import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../lib/theme';

interface ThemeToggleProps {
  className?: string;
  /** `icon` renders a single round button; `switch` renders a labelled pill. */
  variant?: 'icon' | 'switch';
}

/**
 * Switches the whole product between the dark and light palettes. The choice
 * is persisted (see lib/theme) and applied to <html data-theme>.
 */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({ className = '', variant = 'icon' }) => {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  const next = isDark ? 'light' : 'dark';

  if (variant === 'switch') {
    return (
      <button
        type="button"
        onClick={toggle}
        role="switch"
        aria-checked={isDark}
        aria-label={`Switch to ${next} theme`}
        title={`Switch to ${next} theme`}
        className={`inline-flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 text-[13px] font-semibold text-fg-4 transition-colors hover:border-line-strong hover:text-fg-1 ${className}`}
      >
        {isDark ? <Moon className="h-3.5 w-3.5 text-accent-soft" /> : <Sun className="h-3.5 w-3.5 text-accent-soft" />}
        {isDark ? 'Dark' : 'Light'}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={`inline-flex h-9 w-9 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-[10px] border border-line bg-surface-raised text-fg-3 transition-colors hover:border-line-strong hover:text-fg-1 ${className}`}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
};
