import { useState } from 'react';
import { Moon, RefreshCw, Settings as SettingsIcon, Sun } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { AccountBalanceChip } from './AccountBalanceChip';
import { AutoTradeToggle } from './AutoTradeToggle';
import { ConnectionBadge } from './ConnectionBadge';
import { ModeToggle } from './ModeToggle';
import { BrandLogo } from './brand/WickSentinelBrand';
import { refreshBalances } from '../lib/balances';
import { SIGNAL_STATUS_STYLE } from '../utils/signalStatus';

export function TopBar() {
  const ws = useWorkspace();
  const lifecycle = ws.lifecycle;
  const style = lifecycle ? SIGNAL_STATUS_STYLE[lifecycle.status] : null;
  const isDark = ws.settings.theme === 'dark';
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshBalances({ force: true });
    } finally {
      setRefreshing(false);
    }
  };

  const iconButton =
    'inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-[var(--ws-hairline)] bg-surface text-fg-2 transition-colors hover:bg-surface-raised hover:text-fg-1 cursor-pointer';

  return (
    <header className="relative z-40 h-16 shrink-0 border-b border-[var(--ws-hairline)] bg-app/85 backdrop-blur-xl pl-5 pr-2 sm:pl-8 sm:pr-4 flex items-center justify-between gap-2 sm:gap-4">
      {/* Left: brand. */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <BrandLogo markClassName="h-8 w-8" onClick={() => ws.navigate('dashboard')} />
      </div>

      {/* Center: Deriv feed, refresh, manual/auto, theme and settings. */}
      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
        {lifecycle && style && (
          <span
            className={`hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border ${style.bg} ${style.text} ${style.border}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
            {lifecycle.label}
          </span>
        )}

        <div className="hidden lg:block">
          <ConnectionBadge status={ws.connectionStatus} onReconnect={ws.reconnect} />
        </div>
        <div className="lg:hidden">
          <ConnectionBadge status={ws.connectionStatus} onReconnect={ws.reconnect} compact />
        </div>

        <div className="hidden sm:block">
          <AutoTradeToggle />
        </div>
        <div className="sm:hidden">
          <AutoTradeToggle mobileLabel="Automatic trading" />
        </div>

        <button
          type="button"
          onClick={ws.toggleTheme}
          data-testid="theme-toggle"
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={isDark ? 'Light theme' : 'Dark theme'}
          className={`${iconButton} hidden sm:inline-flex`}
        >
          {isDark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>

        <button
          type="button"
          onClick={() => ws.navigate('settings')}
          aria-label="Open settings"
          title="Settings"
          className={iconButton}
        >
          <SettingsIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* Right: refresh, account mode and balances. */}
      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 shrink-0">
        <div className="hidden sm:block">
          <ModeToggle />
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          aria-label="Refresh balances"
          title="Refresh balances"
          className={`${iconButton} hidden sm:inline-flex disabled:opacity-60`}
        >
          <RefreshCw className={`h-[18px] w-[18px] ${refreshing ? 'animate-spin' : ''}`} />
        </button>
        <AccountBalanceChip />
      </div>
    </header>
  );
}