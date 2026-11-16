import { useState } from 'react';
import { AlertTriangle, Award, BarChart3, Download, Filter, GraduationCap, Target, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import type { AiJournalHookValue } from '../../hooks/useAiJournal';
import type { SegmentedPerformance, StrategyRating } from '../../analysis/aiPerformance';
import { Card, EmptyState, SectionCard, StatTile } from '../ui/primitives';

interface PerformanceViewProps {
  journal: AiJournalHookValue;
}

const RATING_STYLE: Record<StrategyRating, string> = {
  EXCELLENT: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  GOOD: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  DEVELOPING: 'bg-elevated text-muted border-line',
  WEAK: 'bg-amber-500/12 text-warn border-amber-500/30',
  UNRELIABLE: 'bg-red-500/12 text-bear border-red-500/30',
};

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v}%`;
}

function SegmentTable({ rows, emptyLabel }: { rows: SegmentedPerformance[]; emptyLabel: string }) {
  if (rows.length === 0) return <div className="text-[11px] text-faint py-4 text-center">{emptyLabel}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-faint text-left">
            <th className="py-1.5 pr-2 font-semibold">Label</th>
            <th className="py-1.5 pr-2 font-semibold text-right">n</th>
            <th className="py-1.5 pr-2 font-semibold text-right">Win %</th>
            <th className="py-1.5 pr-2 font-semibold text-right">R:R</th>
            <th className="py-1.5 pr-2 font-semibold text-right">TP1</th>
            <th className="py-1.5 pr-2 font-semibold">Rating</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-line-soft">
              <td className="py-1.5 pr-2 text-ink font-semibold truncate max-w-[180px]">{r.label}</td>
              <td className="py-1.5 pr-2 text-right font-mono text-muted">{r.sampleSize}</td>
              <td className="py-1.5 pr-2 text-right font-mono text-muted">{fmtPct(r.winRatePercent)}</td>
              <td className="py-1.5 pr-2 text-right font-mono text-muted">{r.avgRiskReward ?? '—'}</td>
              <td className="py-1.5 pr-2 text-right font-mono text-muted">{fmtPct(r.tp1Rate)}</td>
              <td className="py-1.5 pr-2">
                <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${RATING_STYLE[r.rating]}`}>
                  {r.rating}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * TRADE PERFORMANCE & LEARNING AI — dashboard. Every percentage carries its sample size,
 * small samples are labelled, and only verified outcomes drive the ratings.
 */
export function PerformanceView({ journal }: PerformanceViewProps) {
  const [showFilters, setShowFilters] = useState(false);
  const ws = useWorkspace();
  const s = journal.summary;
  const entryModelPerformance = ws.entryModelAI.performance;
  const settledModelSetups = entryModelPerformance.reduce((n, p) => n + p.sampleSize, 0);

  const downloadCsv = () => {
    const csv = journal.exportCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-performance-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-accent/15 text-accent border border-accent/30 flex items-center justify-center">
          <GraduationCap className="w-4 h-4" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-base font-extrabold tracking-tight text-ink leading-none">Trade Performance &amp; Learning AI</h1>
          <p className="text-[11px] text-muted leading-none mt-0.5">
            Independently verified outcomes across every AI module · sample sizes always shown
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className="h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer inline-flex items-center gap-1.5"
          >
            <Filter className="w-3.5 h-3.5" aria-hidden="true" />
            Filters
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            className="h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={journal.clear}
            className="h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-bear/50 cursor-pointer inline-flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            Clear
          </button>
        </div>
      </div>

      {showFilters && (
        <SectionCard title="Filters" subtitle="All performance views respect these filters" icon={<Filter className="w-3.5 h-3.5" aria-hidden="true" />}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {(['symbol', 'module', 'model', 'direction', 'condition'] as const).map((field) => {
              const options = Array.from(new Set(journal.records.map((r) => String(r[field === 'model' ? 'modelId' : field]))));
              return (
                <label key={field} className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{field}</span>
                  <select
                    value={journal.filters[field]}
                    onChange={(e) => journal.setFilters({ [field]: e.target.value } as never)}
                    className="h-8 px-2 text-[11px] bg-elevated border border-line rounded-md text-ink cursor-pointer"
                  >
                    <option value="ALL">All</option>
                    {options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
          <button
            type="button"
            onClick={journal.resetFilters}
            className="mt-3 text-[11px] font-semibold text-accent hover:underline cursor-pointer"
          >
            Reset filters
          </button>
        </SectionCard>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <StatTile label="Total signals" value={s.total} />
        <StatTile label="Settled" value={s.settled} />
        <StatTile label="Pending" value={s.pending} />
        <StatTile label="Wins" value={s.wins} valueClass="text-emerald-400" />
        <StatTile label="Losses" value={s.losses} valueClass="text-bear" />
        <StatTile label="Ambiguous" value={s.ambiguous} />
        <StatTile label="Win rate" value={fmtPct(s.winRatePercent)} hint={s.settled < 5 ? 'sample too small' : `n=${s.settled}`} />
        <StatTile label="Loss rate" value={fmtPct(s.lossRatePercent)} />
        <StatTile label="Avg R:R" value={s.avgRiskReward ?? '—'} />
        <StatTile label="Profit factor" value={s.profitFactor ?? '—'} hint={s.profitFactor === null ? 'n<10' : undefined} />
        <StatTile label="Max win streak" value={s.maxConsecutiveWins} valueClass="text-emerald-400" />
        <StatTile label="Max loss streak" value={s.maxConsecutiveLosses} valueClass="text-bear" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="TP1 rate" value={fmtPct(s.tp1Rate)} hint={`n=${s.total}`} />
        <StatTile label="TP2 rate" value={fmtPct(s.tp2Rate)} />
        <StatTile label="TP3 rate" value={fmtPct(s.tp3Rate)} />
        <StatTile label="Stop-loss frequency" value={fmtPct(s.stopLossFrequency)} />
      </div>

      {/* Alerts */}
      {journal.alerts.length > 0 && (
        <SectionCard title="Performance Alerts" subtitle="Derived only from verified evidence" icon={<AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />}>
          <div className="flex flex-col gap-2">
            {journal.alerts.map((a, i) => (
              <div
                key={i}
                className={`rounded-lg border px-3 py-2 ${
                  a.severity === 'critical'
                    ? 'border-red-500/40 bg-red-500/[0.06]'
                    : a.severity === 'warn'
                      ? 'border-amber-500/40 bg-amber-500/[0.06]'
                      : 'border-line bg-panel'
                }`}
              >
                <div className="text-xs font-bold text-ink">{a.title}</div>
                <div className="text-[11px] text-muted leading-snug mt-0.5">{a.evidence}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Segmented performance */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <SectionCard title="By AI Module" subtitle="Independent module reliability" icon={<BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />}>
          <SegmentTable rows={journal.byModule} emptyLabel="No recorded signals yet." />
        </SectionCard>
        <SectionCard title="By Deriv Index" subtitle="Each index is analysed independently" icon={<BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />}>
          <SegmentTable rows={journal.bySymbol} emptyLabel="No recorded signals yet." />
        </SectionCard>
        <SectionCard title="Entry-Model Rankings" subtitle="Which models actually perform" icon={<Award className="w-3.5 h-3.5" aria-hidden="true" />}>
          <SegmentTable rows={journal.byModel} emptyLabel="No recorded signals yet." />
        </SectionCard>
        <SectionCard title="By Market Condition" subtitle="Regime-specific performance" icon={<BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />}>
          <SegmentTable rows={journal.byCondition} emptyLabel="No recorded signals yet." />
        </SectionCard>
      </div>

      <SectionCard
        title="Entry-Model AI Performance"
        subtitle={`Universal entry-model ledger · ${settledModelSetups} settled setup${settledModelSetups === 1 ? '' : 's'} · win rates withheld until the sample is meaningful`}
        icon={<Target className="w-3.5 h-3.5" aria-hidden="true" />}
      >
        {entryModelPerformance.length === 0 ? (
          <EmptyState
            title="No settled entry-model setups yet"
            description="As ranked setups reach TP or SL, the Entry Model AI records the outcome against the model it selected."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-faint text-left">
                  <th className="py-1.5 pr-2 font-semibold">Entry model</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Settled</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Wins</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Losses</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Missed</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Win rate</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Avg R:R</th>
                </tr>
              </thead>
              <tbody>
                {entryModelPerformance.map((p) => (
                  <tr key={p.model} className="border-t border-line-soft">
                    <td className="py-1.5 pr-2 text-ink font-semibold truncate max-w-[200px]">{p.label}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">{p.sampleSize}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-emerald-400">{p.wins}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-bear">{p.losses}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">{p.missed}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">
                      {p.winRatePercent === null ? '—' : `${p.winRatePercent}%`}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">
                      {p.avgRiskReward === null ? '—' : `1:${p.avgRiskReward.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Recent journal */}
      <SectionCard title="Signal Journal" subtitle={`${journal.filtered.length} records · history is preserved across strategy updates`}>
        {journal.filtered.length === 0 ? (
          <EmptyState title="No signals recorded" description="Run any AI module scan — published signals are journaled here automatically." />
        ) : (
          <div className="overflow-x-auto max-h-[420px]">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-faint text-left">
                  <th className="py-1.5 pr-2 font-semibold">Index</th>
                  <th className="py-1.5 pr-2 font-semibold">Module</th>
                  <th className="py-1.5 pr-2 font-semibold">Model</th>
                  <th className="py-1.5 pr-2 font-semibold">Dir</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Entry</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">SL</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">TP1</th>
                  <th className="py-1.5 pr-2 font-semibold">Outcome</th>
                  <th className="py-1.5 pr-2 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {journal.filtered.slice(0, 120).map((r) => (
                  <tr key={r.id} className="border-t border-line-soft">
                    <td className="py-1.5 pr-2 text-ink font-semibold truncate max-w-[140px]">{r.displayName}</td>
                    <td className="py-1.5 pr-2 text-muted truncate max-w-[140px]">{r.module}</td>
                    <td className="py-1.5 pr-2 text-muted truncate max-w-[160px]">{r.modelLabel}</td>
                    <td className={`py-1.5 pr-2 font-bold ${r.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'}`}>{r.direction}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">{r.entryPrice.toFixed(2)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">{r.stopLoss.toFixed(2)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">{r.takeProfit1.toFixed(2)}</td>
                    <td className="py-1.5 pr-2">
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                          r.outcome === 'WIN'
                            ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
                            : r.outcome === 'LOSS'
                              ? 'bg-red-500/12 text-bear border-red-500/30'
                              : 'bg-elevated text-muted border-line'
                        }`}
                      >
                        {r.outcome.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-muted">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <Card className="px-4 py-3">
        <p className="text-[11px] text-muted leading-snug">
          Proposed improvements are presented for review only — no module is modified automatically. Historical records are
          preserved when strategies change so versions can be compared fairly.
        </p>
      </Card>
    </div>
  );
}
