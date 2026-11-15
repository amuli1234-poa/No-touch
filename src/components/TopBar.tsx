import { Moon, ScanSearch, Settings as SettingsIcon, Sun } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { ConnectionBadge } from './ConnectionBadge';
import { SIGNAL_STATUS_STYLE } from '../utils/signalStatus';

export function TopBar() {
  const ws = useWorkspace();
  const lifecycle = ws.lifecycle;
  const style = lifecycle ? SIGNAL_STATUS_STYLE[lifecycle.status] : null;
  const isDark = ws.settings.theme === 'dark';

  return (
    <header className="h-14 shrink-0 border-b border-line bg-nav px-3 sm:px-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="lg:hidden w-8 h-8 rounded-lg bg-accent/15 text-accent border border-accent/30 flex items-center justify-center shrink-0">
          <ScanSearch className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-extrabold tracking-tight text-ink leading-none">
            DERIV AI SCANNER
          </h1>
          <div className="flex items-center gap-2 mt-0.5 min-w-0">
            <span className="text-[11px] font-medium text-muted truncate">
              {ws.marketName}
            </span>
            <span className="hidden sm:inline text-line" aria-hidden="true">
              ·
            </span>
            <span className="hidden sm:inline text-[11px] font-mono text-muted">
              {ws.timeframe}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
        {lifecycle && style && (
          <span
            className={`hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border ${style.bg} ${style.text} ${style.border}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
            {lifecycle.label}
          </span>
        )}

        <div className="hidden sm:block">
          <ConnectionBadge status={ws.connectionStatus} onReconnect={ws.reconnect} />
        </div>

        <button
          type="button"
          onClick={ws.toggleTheme}
          data-testid="theme-toggle"
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={isDark ? 'Light theme' : 'Dark theme'}
          className="inline-flex items-center justify-center w-9 h-9 text-muted bg-elevated border border-line rounded-lg hover:text-accent hover:border-accent/50 transition-colors cursor-pointer"
        >
          {isDark ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
        </button>

        <button
          type="button"
          onClick={() => ws.navigate('settings')}
          aria-label="Open settings"
          title="Settings"
          className="inline-flex items-center justify-center w-9 h-9 text-muted bg-elevated border border-line rounded-lg hover:text-ink hover:border-accent/50 transition-colors cursor-pointer"
        >
          <SettingsIcon className="w-[18px] h-[18px]" />
        </button>
      </div>
    </header>
  );
}
