import { Activity, AlertTriangle, RadioTower, RefreshCw, Wifi } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Card } from '../ui/primitives';

function relativeTime(epochMs: number | null): string {
  if (epochMs === null) return 'never';
  const deltaSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (deltaSec < 1) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ${deltaSec % 60}s ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

/**
 * Live-feed diagnostics. Reports the true state of the Deriv WebSocket: whether real
 * market data has arrived, when the last tick landed, and why a connection failed.
 * It never fabricates a healthy reading — an idle feed is shown as idle.
 */
export function LiveFeedDiagnostics() {
  const ws = useWorkspace();
  const diag = ws.diagnostics;

  const connected = ws.connectionStatus === 'connected';
  const healthy = connected && !ws.feedStale;

  const tone = healthy
    ? 'text-emerald-400'
    : connected
      ? 'text-warn'
      : 'text-bear';

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border ${
            healthy
              ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
              : 'bg-warn/12 text-warn border-warn/30'
          }`}>
            {healthy ? (
              <Wifi className="w-4 h-4" aria-hidden="true" />
            ) : (
              <AlertTriangle className="w-4 h-4" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-widest text-faint">
              Live Deriv feed
            </div>
            <div className={`text-sm font-extrabold tracking-tight ${tone}`}>
              {healthy
                ? 'LIVE — RECEIVING TICKS'
                : connected
                  ? 'CONNECTED — AWAITING TICKS'
                  : ws.connectionStatus.toUpperCase()}
            </div>
          </div>
        </div>

        {(ws.connectionStatus === 'disconnected' || ws.connectionStatus === 'error') && (
          <button
            type="button"
            onClick={ws.reconnect}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-bold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Reconnect
          </button>
        )}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Last tick
          </dt>
          <dd className="text-xs font-mono font-semibold text-ink mt-0.5">
            {relativeTime(ws.lastTickAt)}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Last message
          </dt>
          <dd className="text-xs font-mono font-semibold text-ink mt-0.5">
            {relativeTime(diag.lastMessageAt)}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Reconnects
          </dt>
          <dd className="text-xs font-mono font-semibold text-ink mt-0.5">
            {diag.reconnectAttempt} / {diag.maxReconnectAttempts}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Subscriptions
          </dt>
          <dd className="text-xs font-mono font-semibold text-ink mt-0.5">
            {diag.activeSubscriptions}
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-2 mt-3 text-[12px] text-muted">
        <RadioTower className="w-3.5 h-3.5 text-faint shrink-0" aria-hidden="true" />
        <span className="font-mono truncate">{diag.url}</span>
      </div>

      {diag.lastError && !healthy && (
        <p className="mt-2 text-[12px] text-bear leading-relaxed break-words">
          {diag.lastError.code ? `[${diag.lastError.code}] ` : ''}
          {diag.lastError.message}
        </p>
      )}

      {healthy && (
        <p className="mt-2 text-[12px] text-muted leading-relaxed inline-flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
          Real Deriv market data — no simulated or cached prices are ever displayed.
        </p>
      )}
    </Card>
  );
}
