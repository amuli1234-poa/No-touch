import React from 'react';
import { RefreshCw, Bell, User, PanelLeft, LogOut, ShieldCheck } from 'lucide-react';
import { Button, IconButton, StatusDot, ThemeToggle, Tone } from '../ui';
import { formatClock, formatRelative } from '../ui/format';
import { useAuth, logout } from '../../lib/auth';
import { navigate } from '../../lib/router';

interface TopbarProps {
  title: string;
  description?: string;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  lastScanTimestamp: number;
  isScanning: boolean;
  onScanAll: () => void;
  onOpenMobileNav: () => void;
  scanDisabled?: boolean;
}

const CONNECTION_TONE: Record<TopbarProps['connectionState'], Tone> = {
  CONNECTED: 'success',
  RECONNECTING: 'warning',
  DISCONNECTED: 'danger'
};

const CONNECTION_LABEL: Record<TopbarProps['connectionState'], string> = {
  CONNECTED: 'Feed connected',
  RECONNECTING: 'Reconnecting',
  DISCONNECTED: 'Feed offline'
};

export const Topbar: React.FC<TopbarProps> = ({
  title,
  description,
  connectionState,
  lastScanTimestamp,
  isScanning,
  onScanAll,
  onOpenMobileNav,
  scanDisabled
}) => (
  <header className="sticky top-0 z-30 border-b border-line-soft bg-app/85 backdrop-blur-xl">
    <div className="flex h-[60px] items-center gap-3 px-3 sm:px-5">
      <IconButton
        label="Open navigation"
        onClick={onOpenMobileNav}
        className="lg:hidden"
      >
        <PanelLeft className="h-4 w-4" />
      </IconButton>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[14.5px] font-bold tracking-tight text-fg-1">{title}</h1>
        {description && (
          <p className="hidden truncate text-[11.5px] text-fg-5 sm:block">{description}</p>
        )}
      </div>

      {/* Live status cluster */}
      <div className="hidden items-center gap-3 rounded-[10px] border border-line-soft bg-surface px-3 py-1.5 md:flex">
        <StatusDot
          tone={CONNECTION_TONE[connectionState]}
          pulse={connectionState === 'CONNECTED'}
          label={CONNECTION_LABEL[connectionState]}
        />
        <span className="h-4 w-px bg-surface-elevated" />
        <div className="flex flex-col leading-tight">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-fg-6">
            Last scan
          </span>
          <span className="tabular text-[11px] font-medium text-fg-3">
            {lastScanTimestamp ? formatClock(lastScanTimestamp) : 'Not scanned'}
          </span>
        </div>
      </div>

      <Button
        variant="primary"
        size="md"
        onClick={onScanAll}
        disabled={isScanning || scanDisabled}
        icon={<RefreshCw className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`} />}
        className="hidden sm:inline-flex"
      >
        {isScanning ? 'Scanning…' : 'Scan All'}
      </Button>
      <IconButton
        label={isScanning ? 'Scanning markets' : 'Scan all markets'}
        onClick={onScanAll}
        disabled={isScanning || scanDisabled}
        className="sm:hidden"
      >
        <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
      </IconButton>

      <span className="hidden h-6 w-px bg-surface-elevated lg:block" />

      <ThemeToggle />

      <IconButton label="Alerts" className="hidden lg:inline-flex">
        <Bell className="h-4 w-4" />
      </IconButton>

      <UserMenu lastScanTimestamp={lastScanTimestamp} />
    </div>
  </header>
);

/**
 * Operator menu — shows the authenticated Deriv-linked profile and offers
 * logout. Falls back to a neutral label when the session is unavailable.
 */
const UserMenu: React.FC<{ lastScanTimestamp: number }> = ({ lastScanTimestamp }) => {
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

  const name =
    auth.status === 'authenticated'
      ? auth.user.loginId || 'Deriv account'
      : 'Operator';
  const subtitle =
    auth.status === 'authenticated'
      ? `${auth.user.demoAccounts} demo · ${auth.user.realAccounts} real`
      : lastScanTimestamp
        ? `Active ${formatRelative(lastScanTimestamp)}`
        : 'Local session';

  const handleLogout = async () => {
    setBusy(true);
    await logout();
    setBusy(false);
    navigate('/login');
  };

  return (
    <div className="relative hidden lg:block" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-[10px] border border-line-soft bg-surface px-2 py-1.5 transition-colors hover:border-line-strong"
        title="Account"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-accent-soft">
          <User className="h-3.5 w-3.5" />
        </span>
        <span className="max-w-[130px] text-left leading-tight">
          <span className="block truncate text-[11.5px] font-semibold text-fg-2">{name}</span>
          <span className="block truncate text-[9.5px] text-fg-5">{subtitle}</span>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-40 w-56 overflow-hidden rounded-[12px] border border-line-soft bg-surface shadow-[var(--shadow-modal)]"
        >
          <div className="border-b border-line-soft px-3.5 py-3">
            <p className="text-[11px] font-semibold text-fg-2">
              {auth.status === 'authenticated' ? name : 'Not signed in'}
            </p>
            <p className="mt-0.5 text-[10.5px] text-fg-5">
              {auth.status === 'authenticated' ? 'Authenticated with Deriv' : 'Public preview session'}
            </p>
          </div>
          {auth.status === 'authenticated' && (
            <div className="px-3.5 py-2.5 text-[10.5px] text-fg-5">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-tint-teal" />
                Session active
              </span>
            </div>
          )}
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
