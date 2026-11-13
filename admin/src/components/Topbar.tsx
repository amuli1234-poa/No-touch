import { Menu, Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/hooks';

/**
 * Top bar: contextual page title, a live "environment" marker, the theme
 * toggle and the mobile menu trigger.
 */
export function Topbar({
  title,
  subtitle,
  onOpenMobile,
  envLabel
}: {
  title: string;
  subtitle?: string;
  onOpenMobile: () => void;
  envLabel: string;
}) {
  const { theme, toggle } = useTheme();
  return (
    <header className="topbar">
      <button className="icon-btn mobile-only" onClick={onOpenMobile} aria-label="Open navigation">
        <Menu size={18} />
      </button>
      <div className="grow truncate">
        <div className="topbar-title truncate">{title}</div>
        {subtitle && <div className="topbar-sub truncate">{subtitle}</div>}
      </div>
      <span className="badge badge-slate desktop-only" title="Deployment environment">
        {envLabel}
      </span>
      <button className="icon-btn" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
    </header>
  );
}
