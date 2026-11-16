import { useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Filter,
  History,
  Lock,
  Radio,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import type { SignalFeedItem } from '../../types/signals';
import { formatCandleTime, formatPrice } from '../../utils/derivParser';
import { EmptyState } from '../ui/primitives';

const SOURCE_LABEL: Record<SignalFeedItem['source'], string> = {
  'CO-ANALYSIS': 'Validated · both engines',
  SCANNER: 'Scanner',
  ANALYSER: 'Chart Analyser',
  TRENDLINE: 'Trendline Scanner',
};

/**
 * The prominent BEST SIGNAL panel. It ranks the genuine, confirmed feed items (never
 * a fabricated one), shows every actionable level, and lets the user filter by market
 * and jump straight to the exact chart that produced the setup.
 */
export function BestSignalPanel() {
  const ws = useWorkspace();
  const [marketFilter, setMarketFilter] = useState<string>('ALL');
  const [showHistory, setShowHistory] = useState(false);

  const markets = useMemo(() => {
    const set = new Map<string, string>();
    for (const item of ws.signalFeed) set.set(item.symbol, item.displayName);
    return [...set.entries()].map(([symbol, name]) => ({ symbol, name }));
  }, [ws.signalFeed]);

  const filtered = useMemo(
    () =>
      marketFilter === 'ALL'
        ? ws.signalFeed
        : ws.signalFeed.filter((i) => i.symbol === marketFilter),
    [ws.signalFeed, marketFilter]
  );

  const best = useMemo(() => {
    if (filtered.length === 0) return null;
    return [...filtered].sort((a, b) => {
      if (a.validated !== b.validated) return a.validated ? -1 : 1;
      return b.confidence - a.confidence;
    })[0];
  }, [filtered]);

  const managed = best ? ws.getManagedSignal(best.id) : null;

  return (
    <section
      aria-label="Best signal"
      className="gradient-surface relative overflow-hidden bg-surface border border-line rounded-xl"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line-soft">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-accent/15 text-accent border border-accent/30">
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-extrabold tracking-tight text-ink">Best signal</h3>
          <p className="text-[11px] text-muted">Highest-ranked confirmed setup right now</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {markets.length > 0 && (
            <label className="inline-flex items-center gap-1 text-[11px] text-muted">
              <Filter className="w-3 h-3" aria-hidden="true" />
              <select
                value={marketFilter}
                onChange={(e) => setMarketFilter(e.target.value)}
                aria-label="Filter signals by market"
                className="bg-panel border border-line rounded-md px-1.5 py-1 text-[11px] font-semibold text-ink cursor-pointer"
              >
                <option value="ALL">All markets</option>
                {markets.map((m) => (
                  <option key={m.symbol} value={m.symbol}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-pressed={showHistory}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[11px] font-bold transition-colors cursor-pointer ${
              showHistory
                ? 'bg-accent/12 text-accent border-accent/30'
                : 'bg-panel text-muted border-line hover:text-ink'
            }`}
          >
            <History className="w-3 h-3" aria-hidden="true" />
            History
          </button>
        </div>
      </div>

      <div className="p-4">
        {!best ? (
          <EmptyState
            icon={<Radio className="w-5 h-5" />}
            title="No confirmed signal yet"
            description="Only genuine validated setups appear here. Run the Chart Analyser or the Market Scanner and a confirmed setup will surface automatically."
          />
        ) : (
          <div key={best.id} className="animate-slide-up">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-extrabold ${
                      best.direction === 'RISE'
                        ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
                        : 'bg-red-500/12 text-bear border-red-500/30'
                    }`}
                  >
                    {best.direction === 'RISE' ? (
                      <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    {best.direction}
                  </span>
                  {best.validated && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/12 text-emerald-400 text-[11px] font-bold uppercase tracking-wide">
                      <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                      Validated
                    </span>
                  )}
                  {managed && (
                    <span className="px-2 py-0.5 rounded-md border border-accent/30 bg-accent/12 text-accent text-[11px] font-bold uppercase tracking-wide">
                      {managed.status.replace('_', ' ')}
                    </span>
                  )}
                </div>
                <h4 className="text-lg font-extrabold tracking-tight text-ink mt-1.5 truncate">
                  {best.displayName}
                </h4>
                <div className="text-[12px] text-muted font-mono mt-0.5">
                  {best.symbol} · {best.timeframe} · {SOURCE_LABEL[best.source]}
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                  Quality
                </div>
                <div className="font-mono text-2xl font-extrabold text-accent tabular-nums">
                  {best.confidence}
                </div>
                <div className="text-[10px] text-faint">/ 100</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-3">
              <LevelBox
                label="Entry"
                value={managed?.entry ?? best.entryPrice}
                icon={<Lock className="w-2.5 h-2.5" />}
                tone="text-accent"
                locked
              />
              <LevelBox
                label="Stop-loss"
                value={managed?.stopLoss ?? best.stopLoss}
                icon={<Lock className="w-2.5 h-2.5" />}
                tone="text-bear"
                locked
              />
              <LevelBox
                label={managed ? `TP (${managed.tpHistory.length - 1} adj)` : 'Take-profit'}
                value={managed?.takeProfit ?? best.takeProfit1}
                icon={<Target className="w-2.5 h-2.5" />}
                tone="text-emerald-400"
              />
            </div>

            <div className="mt-3 space-y-1.5">
              {best.modelLabel && (
                <p className="text-[12px] text-ink">
                  <span className="text-faint">Entry model · </span>
                  {best.modelLabel}
                </p>
              )}
              <p className="text-[12px] text-muted leading-relaxed">
                <span className="text-faint">Confirmation · </span>
                {best.snapshot?.confirmationExplanation ??
                  best.coAnalysis?.notes.join(' ') ??
                  'Confirmed by the analysis engine.'}
              </p>
              {best.createdAt && (
                <p className="text-[11px] text-faint font-mono">
                  Confirmed {formatCandleTime(best.createdAt / 1000)}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => ws.openChart(best.symbol, best.timeframe, best.snapshot)}
              className="mt-3 w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-accent text-app text-xs font-extrabold hover:bg-accent-soft transition-colors cursor-pointer"
            >
              <ArrowUpRight className="w-4 h-4" aria-hidden="true" />
              OPEN THIS CHART
            </button>
          </div>
        )}

        {showHistory && (
          <div className="mt-4 pt-3 border-t border-line-soft animate-slide-up">
            <div className="text-[11px] font-bold uppercase tracking-widest text-faint mb-2">
              Signal history · {filtered.length}
            </div>
            {filtered.length === 0 ? (
              <p className="text-[12px] text-faint">No signals for this market yet.</p>
            ) : (
              <ul className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {filtered.map((item) => {
                  const m = ws.getManagedSignal(item.id);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => ws.openChart(item.symbol, item.timeframe, item.snapshot)}
                        className="w-full flex items-center gap-2 text-left bg-panel border border-line-soft rounded-lg px-2.5 py-2 hover:border-accent/40 transition-colors cursor-pointer"
                      >
                        {item.direction === 'RISE' ? (
                          <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                        ) : (
                          <ArrowDownRight className="w-3.5 h-3.5 text-bear shrink-0" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-semibold text-ink truncate">
                            {item.displayName}
                          </span>
                          <span className="block text-[11px] text-faint font-mono truncate">
                            {item.direction} · {item.timeframe} · {item.confidence}/100
                            {m ? ` · ${m.status.replace('_', ' ')}` : ''}
                          </span>
                        </span>
                        <span className="text-[11px] font-mono text-muted shrink-0">
                          {item.entryPrice !== null ? formatPrice(item.entryPrice, 5) : '—'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function LevelBox({
  label,
  value,
  icon,
  tone,
  locked,
}: {
  label: string;
  value: number | null;
  icon: React.ReactNode;
  tone: string;
  locked?: boolean;
}) {
  return (
    <div className="bg-panel border border-line-soft rounded-lg px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
        {icon}
        <span className="truncate">{label}</span>
        {locked && <Lock className="w-2.5 h-2.5 ml-auto text-faint" aria-hidden="true" />}
      </div>
      <div className={`text-[13px] font-mono font-bold tabular-nums mt-0.5 ${tone}`}>
        {value === null || value === undefined ? '—' : formatPrice(value, 5)}
      </div>
    </div>
  );
}
