import { AlertCircle, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import type { ConnectionStatus } from '../types/market';

interface ConnectionBadgeProps {
  status: ConnectionStatus;
  onReconnect: () => void;
}

const STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; textClass: string; dotClass: string }
> = {
  connected: {
    label: 'CONNECTED',
    textClass: 'text-emerald-400',
    dotClass: 'bg-emerald-400',
  },
  connecting: {
    label: 'CONNECTING',
    textClass: 'text-warn',
    dotClass: 'bg-amber-400 animate-pulse',
  },
  reconnecting: {
    label: 'RECONNECTING',
    textClass: 'text-warn',
    dotClass: 'bg-amber-400 animate-pulse',
  },
  disconnected: {
    label: 'DISCONNECTED',
    textClass: 'text-muted',
    dotClass: 'bg-faint',
  },
  error: {
    label: 'DISCONNECTED · ERROR',
    textClass: 'text-bear',
    dotClass: 'bg-red-500',
  },
};

export function ConnectionBadge({ status, onReconnect }: ConnectionBadgeProps) {
  const cfg = STATUS_CONFIG[status];
  const showReconnect = status === 'disconnected' || status === 'error';

  return (
    <div className="flex items-center gap-3 shrink-0" data-testid="connection-status">
      <div
        className={`flex items-center gap-2 text-xs font-medium whitespace-nowrap ${cfg.textClass}`}
        role="status"
        aria-live="polite"
      >
        {status === 'connected' ? (
          <Wifi className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : status === 'error' ? (
          <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : status === 'disconnected' ? (
          <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden="true" />
        )}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dotClass}`} aria-hidden="true" />
        <span>Deriv Feed · {cfg.label}</span>
      </div>

      {showReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" />
          <span>Reconnect</span>
        </button>
      )}
    </div>
  );
}
