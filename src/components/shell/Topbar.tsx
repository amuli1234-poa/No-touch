import React from 'react';
import { RefreshCw, Bell, User, PanelLeft } from 'lucide-react';
import { Button, IconButton, StatusDot, ThemeToggle, Tone } from '../ui';
import { formatClock, formatRelative } from '../ui/format';

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

      <button
        className="hidden items-center gap-2 rounded-[10px] border border-line-soft bg-surface px-2 py-1.5 transition-colors hover:border-line-strong lg:flex"
        title="Local operator profile"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-accent-soft">
          <User className="h-3.5 w-3.5" />
        </span>
        <span className="text-left leading-tight">
          <span className="block text-[11.5px] font-semibold text-fg-2">Operator</span>
          <span className="block text-[9.5px] text-fg-5">
            {lastScanTimestamp ? `Active ${formatRelative(lastScanTimestamp)}` : 'Local session'}
          </span>
        </span>
      </button>
    </div>
  </header>
);
