import { ArrowUpRight, Lock, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import type { SignalSnapshot } from '../types/analysis';
import type { SignalFeedItem } from '../types/signals';
import type { ManagedSignalStatus } from '../types/training';
import { formatPrice } from '../utils/derivParser';

const SOURCE_LABEL: Record<SignalFeedItem['source'], string> = {
  'CO-ANALYSIS': 'Co-analysis',
  SCANNER: 'Scanner',
  ANALYSER: 'Analyser',
  TRENDLINE: 'Trendline',
};

const MANAGED_STATUS_STYLE: Record<ManagedSignalStatus, string> = {
  PENDING: 'bg-panel text-muted border-line',
  ACTIVE: 'bg-accent/12 text-accent border-accent/30',
  MISSED: 'bg-warn/12 text-warn border-warn/30',
  TARGET_HIT: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  STOP_HIT: 'bg-red-500/12 text-bear border-red-500/30',
  INVALIDATED: 'bg-panel text-faint border-line',
};

export function SignalFeedCard({
  item,
  onOpen,
}: {
  item: SignalFeedItem;
  onOpen?: (
    symbol: string,
    tf: SignalFeedItem['timeframe'],
    snapshot?: SignalSnapshot | null
  ) => void;
}) {
  const ws = useWorkspace();
  const isRise = item.direction === 'RISE';
  const dirStyle = isRise
    ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
    : 'bg-red-500/12 text-bear border-red-500/30';

  const managed = ws.getManagedSignal(item.id);
  const entry = managed?.entry ?? item.entryPrice;
  const stopLoss = managed?.stopLoss ?? item.stopLoss;
  const takeProfit = managed?.takeProfit ?? item.takeProfit1;
  const statusStyle = managed ? MANAGED_STATUS_STYLE[managed.status] : null;

  return (
    <button
      type="button"
      onClick={() => onOpen?.(item.symbol, item.timeframe, item.snapshot)}
      data-testid={`signal-feed-item-${item.symbol}`}
      className="w-full text-left bg-surface border border-line rounded-xl px-3.5 py-3 hover:border-accent/50 hover:bg-elevated/40 transition-colors cursor-pointer"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg border ${dirStyle}`}>
            {isRise ? (
              <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-ink truncate">{item.displayName}</span>
              {item.validated && (
                <span
                  className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/12 text-emerald-400"
                  title="Validated by both engines"
                >
                  <ShieldCheck className="w-2.5 h-2.5" aria-hidden="true" />
                  Validated
                </span>
              )}
              {managed && statusStyle && (
                <span
                  className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${statusStyle}`}
                  title="Live trade management status"
                >
                  {managed.status.replace('_', ' ')}
                </span>
              )}
            </div>
            <div className="text-[10px] font-mono text-faint">
              {item.symbol} · {item.timeframe} · {item.modelLabel ?? 'Setup'} · {SOURCE_LABEL[item.source]}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${dirStyle}`}>
            {item.direction}
          </span>
          <span className="text-[11px] font-mono text-muted">{item.confidence}/100</span>
          <ArrowUpRight className="w-3.5 h-3.5 text-faint" aria-hidden="true" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-2.5">
        {[
          { label: 'Entry', value: entry, locked: true },
          { label: 'Stop-loss', value: stopLoss, locked: true },
          { label: managed ? `Take-profit (${managed.tpHistory.length - 1} adj)` : 'Take-profit', value: takeProfit, locked: false },
        ].map((cell) => (
          <div key={cell.label} className="bg-panel border border-line-soft rounded-md px-2 py-1">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-faint flex items-center gap-1">
              {cell.locked && <Lock className="w-2.5 h-2.5" aria-hidden="true" />}
              {cell.label}
            </div>
            <div className="text-[11px] font-mono text-ink tabular-nums">
              {cell.value === null || cell.value === undefined ? '—' : formatPrice(cell.value, 5)}
            </div>
          </div>
        ))}
      </div>

      {managed && (
        <div className="text-[10px] text-faint mt-1.5">
          {managed.status === 'PENDING' && 'Waiting for the entry zone to be filled — never chased.'}
          {managed.status === 'ACTIVE' && `In play · MFE ${managed.maxFavourableExcursionPct.toFixed(2)}% / MAE ${managed.maxAdverseExcursionPct.toFixed(2)}%`}
          {managed.status === 'MISSED' && 'Entry never filled; the move ran away without us.'}
          {managed.status === 'TARGET_HIT' && 'Take-profit reached.'}
          {managed.status === 'STOP_HIT' && 'Locked stop-loss hit.'}
          {managed.status === 'INVALIDATED' && 'Structure invalidated before entry.'}
        </div>
      )}

      {item.modelLabel && (
        <div className="text-[10px] text-muted mt-1 truncate">{item.modelLabel}</div>
      )}
    </button>
  );
}

/**
 * The unified, clickable signal feed. Every entry deep-links to the dedicated full-screen
 * Chart tab for the exact market/timeframe that produced it (via openChart).
 */
export function SignalFeedList({ limit }: { limit?: number }) {
  const ws = useWorkspace();
  const items = limit ? ws.signalFeed.slice(0, limit) : ws.signalFeed;

  if (items.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-xs text-muted max-w-md mx-auto">
          No signals yet. Run the Market Scanner or the Chart Analyser — confirmed setups
          from either engine appear here as clickable cards that open their exact chart.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {items.map((item) => (
        <SignalFeedCard key={item.id} item={item} onOpen={ws.openChart} />
      ))}
    </div>
  );
}
