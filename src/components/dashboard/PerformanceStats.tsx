import { useMemo } from 'react';
import { Award, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { MeterBar, StatTile } from '../ui/primitives';

/**
 * Signal accuracy statistics derived ONLY from verified, settled records. Unsettled
 * setups are reported separately so the win rate never inflates with open trades.
 */
export function PerformanceStats() {
  const ws = useWorkspace();
  const records = ws.performanceRecords;

  const stats = useMemo(() => {
    const settled = records.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
    const wins = settled.filter((r) => r.outcome === 'WIN').length;
    const losses = settled.filter((r) => r.outcome === 'LOSS').length;
    const open = records.length - settled.length;
    const winRate = settled.length > 0 ? (wins / settled.length) * 100 : null;

    const byModel = new Map<string, { label: string; wins: number; total: number }>();
    for (const r of settled) {
      const entry = byModel.get(r.model) ?? { label: r.modelLabel, wins: 0, total: 0 };
      entry.total += 1;
      if (r.outcome === 'WIN') entry.wins += 1;
      byModel.set(r.model, entry);
    }
    const ranked = [...byModel.values()]
      .filter((m) => m.total >= 1)
      .sort((a, b) => b.wins / b.total - a.wins / a.total)
      .slice(0, 5);

    return { settled: settled.length, wins, losses, open, winRate, ranked };
  }, [records]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatTile
          label="Verified setups"
          value={stats.settled}
          hint="Settled with a recorded outcome"
        />
        <StatTile
          label="Win rate"
          value={
            stats.winRate === null ? (
              <span className="text-faint">n/a</span>
            ) : (
              `${stats.winRate.toFixed(1)}%`
            )
          }
          valueClass={stats.winRate === null ? 'text-faint' : 'text-emerald-400'}
          hint={stats.settled >= 10 ? 'Verified record' : 'Low sample — indicative only'}
        />
        <StatTile
          label="Wins / Losses"
          value={
            <span>
              <span className="text-emerald-400">{stats.wins}</span>
              <span className="text-faint"> / </span>
              <span className="text-bear">{stats.losses}</span>
            </span>
          }
          hint="From verified outcomes"
        />
        <StatTile label="Open / pending" value={stats.open} hint="Not yet settled" />
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-faint mb-2">
          <Award className="w-3 h-3" aria-hidden="true" />
          Best-performing entry models
        </div>
        {stats.ranked.length === 0 ? (
          <p className="text-[11px] text-faint">
            Model performance appears once setups have settled.
          </p>
        ) : (
          <ul className="space-y-2">
            {stats.ranked.map((m) => {
              const rate = (m.wins / m.total) * 100;
              return (
                <li key={m.label}>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink truncate">{m.label}</span>
                    <span className="font-mono text-muted shrink-0">
                      {m.wins}/{m.total} · {rate.toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-1">
                    <MeterBar
                      value={rate}
                      className={rate >= 50 ? 'bg-emerald-500' : 'bg-bear'}
                      height="h-1.5"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-3 text-[10px] text-faint">
        <span className="inline-flex items-center gap-1">
          <TrendingUp className="w-3 h-3 text-emerald-400" aria-hidden="true" /> Rise setups
        </span>
        <span className="inline-flex items-center gap-1">
          <TrendingDown className="w-3 h-3 text-bear" aria-hidden="true" /> Fall setups
        </span>
        <span className="inline-flex items-center gap-1 ml-auto">
          <Target className="w-3 h-3" aria-hidden="true" />
          {records.length} total recorded
        </span>
      </div>
    </div>
  );
}
