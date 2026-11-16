import { BarChart3, RefreshCw } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { summarizeModelPerformance } from '../../analysis/modelPerformance';
import { Card, EmptyState, SectionCard } from '../ui/primitives';
import { formatCandleTime, formatPrice } from '../../utils/derivParser';

export function TradeHistoryView() {
  const ws = useWorkspace();
  const records = ws.performanceRecords;
  const settled = records.filter(
    (r) => r.outcome === 'WIN' || r.outcome === 'LOSS' || r.outcome === 'INVALIDATED'
  );
  const wins = settled.filter((r) => r.outcome === 'WIN').length;
  const winRate = settled.length >= 3 ? `${((wins / settled.length) * 100).toFixed(1)}%` : null;

  const segments = [
    { title: 'By Entry Model', rows: summarizeModelPerformance(records, 'model') },
    { title: 'By Instrument', rows: summarizeModelPerformance(records, 'symbol') },
    { title: 'By Direction', rows: summarizeModelPerformance(records, 'direction') },
    { title: 'By Market Condition', rows: summarizeModelPerformance(records, 'condition') },
  ];

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1200px] w-full mx-auto">
      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-extrabold tracking-tight text-ink">Trade History</h1>
          <p className="text-xs text-faint">
            Model-performance ledger for setups recorded by both engines (Scanner + Analyser),
            with entry, invalidation, target, MFE/MAE and outcome. Segments are never combined
            across models or instruments.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[11px] uppercase font-semibold text-faint">Total</div>
            <div className="font-mono font-bold text-ink">{records.length}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase font-semibold text-faint">Settled</div>
            <div className="font-mono font-bold text-ink">{settled.length}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase font-semibold text-faint">Win rate</div>
            <div className="font-mono font-bold text-emerald-400">
              {winRate ?? 'Withheld (<3)'}
            </div>
          </div>
          <button
            type="button"
            onClick={ws.refreshValidationSettlement}
            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-semibold text-muted bg-surface border border-line rounded-md hover:bg-elevated cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Settle
          </button>
        </div>
      </Card>

      {records.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BarChart3 className="w-7 h-7" />}
            title="No trade history yet"
            description="When either engine confirms a setup, it is recorded here with its entry, invalidation and target, then settled structurally against live price action."
          />
        </Card>
      ) : (
        <>
          <SectionCard title="Recorded Signals" subtitle="Most recent first">
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full text-left text-xs">
                <thead className="text-faint border-b border-line">
                  <tr className="text-[11px] uppercase tracking-wide">
                    <th className="py-2 pr-3 font-semibold">Time</th>
                    <th className="py-2 pr-3 font-semibold">Market</th>
                    <th className="py-2 pr-3 font-semibold">Dir</th>
                    <th className="py-2 pr-3 font-semibold">Model</th>
                    <th className="py-2 pr-3 font-semibold">TF</th>
                    <th className="py-2 pr-3 font-semibold text-right">Entry</th>
                    <th className="py-2 pr-3 font-semibold text-right">Exit</th>
                    <th className="py-2 pr-3 font-semibold">Outcome</th>
                    <th className="py-2 font-semibold text-right">Chart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft font-mono tabular-nums">
                  {records.map((rec) => (
                    <tr
                      key={rec.id}
                      onClick={() => ws.openChart(rec.symbol, rec.timeframe)}
                      className="hover:bg-elevated cursor-pointer"
                    >
                      <td className="py-2 pr-3 text-faint whitespace-nowrap">
                        {formatCandleTime(rec.createdAt / 1000)}
                      </td>
                      <td className="py-2 pr-3 font-sans font-semibold text-ink whitespace-nowrap">
                        {rec.displayName}
                      </td>
                      <td
                        className={`py-2 pr-3 font-bold ${
                          rec.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'
                        }`}
                      >
                        {rec.direction}
                      </td>
                      <td className="py-2 pr-3 font-sans text-muted whitespace-nowrap">
                        {rec.modelLabel}
                      </td>
                      <td className="py-2 pr-3 text-muted">{rec.timeframe}</td>
                      <td className="py-2 pr-3 text-right text-muted">
                        {formatPrice(rec.entryPrice, 2)}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted">
                        {rec.exitPrice !== null ? formatPrice(rec.exitPrice, 2) : '—'}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                            rec.outcome === 'WIN'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : rec.outcome === 'LOSS' || rec.outcome === 'INVALIDATED'
                                ? 'bg-red-500/12 text-bear'
                                : 'bg-elevated text-muted'
                          }`}
                        >
                          {rec.outcome}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => ws.openChart(rec.symbol, rec.timeframe)}
                          className="px-2.5 py-1 bg-accent text-app rounded-md hover:bg-accent-soft text-[12px] font-semibold cursor-pointer"
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {segments.map((seg) => (
              <SectionCard key={seg.title} title={seg.title} subtitle="Segments are never combined across instruments">
                {seg.rows.length === 0 ? (
                  <p className="text-[12px] text-faint">No settled samples in this segment.</p>
                ) : (
                  <table className="w-full text-left text-[12px]">
                    <thead className="text-faint border-b border-line">
                      <tr className="text-[11px] uppercase">
                        <th className="py-1.5 pr-2 font-semibold">Segment</th>
                        <th className="py-1.5 pr-2 font-semibold text-right">n</th>
                        <th className="py-1.5 pr-2 font-semibold text-right">W/L</th>
                        <th className="py-1.5 font-semibold text-right">Win%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft font-mono tabular-nums">
                      {seg.rows.map((row: (typeof seg.rows)[number]) => (
                        <tr key={row.key}>
                          <td className="py-1.5 pr-2 font-sans text-ink">{row.label}</td>
                          <td className="py-1.5 pr-2 text-right text-muted">{row.sampleCount}</td>
                          <td className="py-1.5 pr-2 text-right text-muted">
                            {row.wins}/{row.losses}
                          </td>
                          <td className="py-1.5 text-right font-bold text-ink">
                            {row.winRatePercent !== null ? `${row.winRatePercent}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </SectionCard>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
