import React from 'react';
import { Bell, ChevronDown, LogOut, RefreshCw, ShieldCheck, User } from 'lucide-react';
import { IconButton, StatusDot, ThemeToggle, Button, type Tone } from '../ui';
import { NAV_SECTIONS, Route, activeSectionId } from './navigation';
import { useAuth, logout } from '../../lib/auth';
import { AccountBalanceChip } from './AccountBalance';
import { navigate } from '../../lib/router';

/**
 * The single navigation bar for the whole workspace.
 *
 * One compact bar replaces the former sidebar + topbar + mobile tab bar. It
 * carries only what the operator needs to orient themselves: where they are
 * (the five sections), whether the feed is live, which Deriv account mode they
 * are on, and the account menu. Everything else lives inside the workspace.
 */

interface TopNavProps {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  lastTickAt?: number | null;
  isScanning: boolean;
  onScanAll: () => void;
  scanDisabled?: boolean;
  signalBadge?: number;
}

const CONNECTION_TONE: Record<TopNavProps['connectionState'], Tone> = {
  CONNECTED: 'success',
  RECONNECTING: 'warning',
  DISCONNECTED: 'danger'
};

const CONNECTION_LABEL: Record<TopNavProps['connectionState'], string> = {
  CONNECTED: 'Live',
  RECONNECTING: 'Reconnecting',
  DISCONNECTED: 'Offline'
};

export const TopNav: React.FC<TopNavProps> = ({
  activeRoute,
  onNavigate,
  connectionState,
  lastTickAt,
  isScanning,
  onScanAll,
  scanDisabled,
  signalBadge
}) => {
  const active = activeSectionId(activeRoute);
  const { freshness, freshnessLabel } = useFreshness(connectionState, lastTickAt);

  return (
    <header className="sticky top-0 z-40 border-b border-line-soft bg-app/90 backdrop-blur-xl">
      <div className="mx-auto flex h-[52px] max-w-[1680px] items-center gap-1.5 px-3 sm:gap-2 sm:px-4">
        {/* Brand */}
        <button
          onClick={() => onNavigate('LIVE_CHART')}
          className="flex shrink-0 items-center gap-2 rounded-[8px] px-1.5 py-1 transition-colors hover:bg-surface-raised"
          aria-label="WickSentinel home"
        >
          <span className="relative flex h-6 w-6 items-center justify-center rounded-[7px] bg-accent">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-on-accent" fill="none">
              <path
                d="M3 15.5l4.5-5 3.5 3 4-6 6 7.5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="hidden text-[13px] font-extrabold tracking-tight text-fg-1 sm:block">
            WICKSENTINEL
          </span>
        </button>

        {/* Primary sections */}
        <nav
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          aria-label="Primary"
        >
          {NAV_SECTIONS.map((section) => {
            const isActive = section.id === active;
            return (
              <button
                key={section.id}
                onClick={() => onNavigate(section.primary)}
                aria-current={isActive ? 'page' : undefined}
                className={`shrink-0 rounded-[8px] px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
                  isActive
                    ? 'bg-surface-raised text-fg-1'
                    : 'text-fg-4 hover:bg-surface-raised hover:text-fg-1'
                }`}
              >
                {section.label}
              </button>
            );
          })}
        </nav>

        {/* Status cluster — connection, freshness, account mode */}
        <div className="hidden items-center gap-2.5 rounded-[9px] border border-line-soft bg-surface px-2.5 py-1.5 md:flex">
          <StatusDot
            tone={CONNECTION_TONE[connectionState]}
            pulse={connectionState === 'CONNECTED'}
            label={CONNECTION_LABEL[connectionState]}
          />
          <span className="h-3.5 w-px bg-surface-elevated" />
          <span
            className={`tabular text-[11px] font-medium ${
              freshness === 'stale' ? 'text-warning' : 'text-fg-4'
            }`}
            title="Age of the most recent market tick"
          >
            {freshnessLabel}
          </span>
        </div>

        {/* Selected-account balance — informational; never authorizes a trade. */}
        <AccountBalanceChip />

        <Button
          variant="secondary"
          size="sm"
          onClick={onScanAll}
          disabled={isScanning || scanDisabled}
          icon={<RefreshCw className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`} />}
          className="max-sm:hidden"
        >
          {isScanning ? 'Scanning' : 'Scan'}
        </Button>

        <IconButton label="Alerts" className="relative max-sm:hidden">
          <Bell className="h-4 w-4" />
          {!!signalBadge && signalBadge > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-success px-1 text-[9.5px] font-bold text-on-accent">
              {signalBadge}
            </span>
          )}
        </IconButton>

        <ThemeToggle />

        <AccountMenu onNavigate={onNavigate} />
      </div>
    </header>
  );
};

type Freshness = 'live' | 'stale' | 'offline' | 'unknown';

/**
 * Age of the most recent market tick, independent of socket state. A connected
 * socket that has gone quiet reads as stale rather than live, because the
 * distinction matters to anyone reading a price off the screen.
 */
function useFreshness(
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING',
  lastTickAt?: number | null
): { freshness: Freshness; freshnessLabel: string } {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (connectionState === 'DISCONNECTED') return { freshness: 'offline', freshnessLabel: 'Offline' };
  if (!lastTickAt) return { freshness: 'unknown', freshnessLabel: '—' };

  const ageMs = now - lastTickAt;
  if (ageMs < 3000) return { freshness: 'live', freshnessLabel: 'Live' };
  if (ageMs < 10000) return { freshness: 'live', freshnessLabel: `${(ageMs / 1000).toFixed(1)}s` };
  return { freshness: 'stale', freshnessLabel: `${Math.round(ageMs / 1000)}s` };
}

/** Account menu: Deriv identity, demo/real mode, settings shortcut and logout. */
const AccountMenu: React.FC<{ onNavigate: (route: Route) => void }> = ({ onNavigate }) => {
  const auth = useAuth();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const authed = auth.status === 'authenticated';
  const name = authed ? auth.user.loginId || 'Deriv account' : 'Operator';

  const handleLogout = async () => {
    setBusy(true);
    await logout();
    setBusy(false);
    navigate('/login');
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-[9px] border border-line-soft bg-surface px-2 py-1.5 transition-colors hover:border-line-strong"
        title="Account"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/20 text-accent-soft">
          <User className="h-3 w-3" />
        </span>
        <span className="hidden max-w-[110px] truncate text-[11.5px] font-semibold text-fg-2 lg:block">
          {name}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-fg-5" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-40 w-60 overflow-hidden rounded-[12px] border border-line-soft bg-surface shadow-[var(--shadow-modal)]"
        >
          <div className="border-b border-line-soft px-3.5 py-3">
            <p className="text-[11.5px] font-semibold text-fg-2">{authed ? name : 'Not signed in'}</p>
            <p className="mt-0.5 text-[10.5px] text-fg-5">
              {authed ? 'Authenticated with Deriv' : 'Public preview session'}
            </p>
          </div>

          {authed && (
            <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-6">
                Account mode
              </span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-fg-4">
                <span className="tabular">{auth.user.demoAccounts} demo</span>
                <span className="h-3 w-px bg-line" />
                <span className="tabular">{auth.user.realAccounts} real</span>
              </span>
            </div>
          )}

          {authed && (
            <div className="px-3.5 py-2.5 text-[10.5px] text-fg-5">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-tint-teal" />
                Session active
              </span>
            </div>
          )}

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNavigate('SETTINGS');
            }}
            className="flex w-full items-center gap-2 border-t border-line-soft px-3.5 py-2.5 text-left text-[12px] font-medium text-fg-3 transition-colors hover:bg-surface-raised hover:text-fg-1"
          >
            Settings
          </button>

          <button
            role="menuitem"
            onClick={handleLogout}
            disabled={busy}
            className="flex w-full items-center gap-2 border-t border-line-soft px-3.5 py-2.5 text-left text-[12px] font-medium text-fg-3 transition-colors hover:bg-surface-raised hover:text-fg-1 disabled:opacity-60"
          >
            <LogOut className="h-3.5 w-3.5" />
            {busy ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      )}
    </div>
  );
};
