import React, { useEffect, useState } from 'react';
import { IndexedDbStorage, HistoryAnalyticsSummary } from '../../services/IndexedDbStorage';
import { SignalHistoryEntry } from '../../types/scanner';
import { Award, Trash2, RefreshCw, BarChart2, ShieldCheck, TrendingUp, Clock } from 'lucide-react';

interface PerformanceDashboardProps {
  storage: IndexedDbStorage;
}

export const PerformanceDashboard: React.FC<PerformanceDashboardProps> = ({ storage }) => {
  const [analytics, setAnalytics] = useState<HistoryAnalyticsSummary | null>(null);
  const [records, setRecords] = useState<SignalHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [summary, list] = await Promise.all([
        storage.computeHistoryAnalytics(),
        storage.getSignalHistory()
      ]);
      setAnalytics(summary);
      setRecords(list);
    } catch (e) {
      console.error('Failed to load signal history:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [storage]);

  const handleClearHistory = async () => {
    await storage.clearAll();
    loadData();
  };

  if (isLoading || !analytics) {
    return (
      <div className="p-8 text-center text-fg-4 font-mono text-sm">
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-accent-soft" />
        Loading performance analytics...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-surface border border-line/90 shadow-lg">
        <div>
          <h2 className="text-sm font-bold text-fg-1 flex items-center gap-2">
            <Award className="w-4 h-4 text-accent-soft" />
            <span>Advanced Rise & Fall Performance Analytics & Backtest Ledger</span>
          </h2>
          <p className="text-xs text-fg-4 mt-1 max-w-2xl">
            Verified performance statistics for Supply & Demand, Chart Patterns, Trendline Bounces, Trendline Breakouts, and Combined Confluence setups without look-ahead bias.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-raised hover:bg-surface-elevated text-xs font-semibold text-fg-2 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleClearHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-danger/15 hover:bg-danger/25 text-danger text-xs font-semibold border border-danger/50 transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear History</span>
          </button>
        </div>
      </div>

      {/* Summary KPI Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums font-mono">
        <div className="p-4 rounded-xl bg-surface border border-line/90">
          <div className="text-[11px] text-fg-4 uppercase flex items-center gap-1.5">
            <BarChart2 className="w-3.5 h-3.5 text-accent-soft" />
            <span>Total Signals</span>
          </div>
          <div className="text-2xl font-bold text-fg-1 mt-1">{analytics.totalSignals}</div>
          <div className="text-[10px] text-fg-5 mt-1">
            Plain: {analytics.plainCount} · 1s: {analytics.oneSecCount}
          </div>
        </div>

        <div className="p-4 rounded-xl bg-surface border border-line/90">
          <div className="text-[11px] text-success uppercase flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-success" />
            <span>Win Rate ({analytics.winRate}%)</span>
          </div>
          <div className="text-2xl font-bold text-success mt-1">
            {analytics.winningTrades}W / {analytics.losingTrades}L
          </div>
          <div className="text-[10px] text-fg-5 mt-1">{analytics.activeCount} currently active</div>
        </div>

        <div className="p-4 rounded-xl bg-surface border border-line/90">
          <div className="text-[11px] text-warning uppercase flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-warning" />
            <span>Missed / Delay</span>
          </div>
          <div className="text-2xl font-bold text-warning mt-1">{analytics.missedSignals}</div>
          <div className="text-[10px] text-fg-5 mt-1">Avg entry delay: {analytics.avgEntryDelaySec}s</div>
        </div>

        <div className="p-4 rounded-xl bg-surface border border-line/90">
          <div className="text-[11px] text-accent-soft uppercase flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-accent-soft" />
            <span>Avg Confluence</span>
          </div>
          <div className="text-2xl font-bold text-accent-soft mt-1">
            {analytics.avgConfluence > 0 ? `${analytics.avgConfluence.toFixed(1)}%` : '—'}
          </div>
          <div className="text-[10px] text-fg-5 mt-1">Strict multi-factor filter</div>
        </div>
      </div>

      {/* Strategy Performance Breakdown Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-line/90 bg-surface p-4 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-2 font-mono flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-accent-soft" />
            <span>Performance by Entry Strategy Model</span>
          </h3>
          <div className="space-y-2">
            {analytics.byStrategy.length > 0 ? (
              analytics.byStrategy.map((s) => (
                <div key={s.strategy} className="p-3 rounded-lg bg-surface-deep/60 border border-line/70 flex items-center justify-between font-mono text-xs">
                  <div>
                    <div className="font-bold text-fg-1">{s.strategy}</div>
                    <div className="text-[10px] text-fg-4 mt-0.5">
                      Signals: {s.count} · TP Hits: {s.tpHits} · Invalidated: {s.invalidated}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-bold ${s.winRatePct >= 55 ? 'text-success' : 'text-fg-3'}`}>
                      {s.winRatePct}% Win Rate
                    </div>
                    <div className="text-[10px] text-accent-soft mt-0.5">
                      Avg Score: {s.avgScore.toFixed(0)}%
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-6 text-center text-xs text-fg-5 font-sans">
                No strategy breakdown records available yet.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-line/90 bg-surface p-4 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-2 font-mono flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-success" />
            <span>Performance by Market & Timeframe</span>
          </h3>
          <div className="space-y-2">
            {analytics.byMarket.length > 0 ? (
              analytics.byMarket.map((m) => (
                <div key={m.symbol} className="p-3 rounded-lg bg-surface-deep/60 border border-line/70 flex items-center justify-between font-mono text-xs">
                  <div>
                    <div className="font-bold text-fg-1">{m.displayName}</div>
                    <div className="text-[10px] text-fg-4 mt-0.5">Total Signals: {m.count}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-success">TP Hits: {m.tpHits}</div>
                    <div className="text-[10px] text-accent-soft mt-0.5">Avg Score: {m.avgScore.toFixed(0)}%</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-6 text-center text-xs text-fg-5 font-sans">
                No market performance records available yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Signal History Ledger Table */}
      <div className="rounded-xl border border-line/90 bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-line/80 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-3 font-mono">
            Recorded Signal Ledger ({records.length})
          </h3>
        </div>

        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-left text-xs font-mono border-collapse tabular-nums">
            <thead className="bg-surface-deepest text-[10px] uppercase text-fg-4 sticky top-0 border-b border-line">
              <tr>
                <th className="p-3">Time</th>
                <th className="p-3">Market</th>
                <th className="p-3">Signal / Strategy</th>
                <th className="p-3">Confluence</th>
                <th className="p-3">Entry</th>
                <th className="p-3">Take Profit</th>
                <th className="p-3">Stop Loss</th>
                <th className="p-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50 text-fg-3">
              {records.length > 0 ? (
                records.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-deep/50">
                    <td className="p-3 text-[11px] text-fg-4">
                      {new Date(r.detectedEpoch * 1000).toLocaleString()}
                    </td>
                    <td className="p-3 font-sans font-medium text-fg-1">
                      {r.displayName}{' '}
                      <span className="text-[10px] font-mono text-fg-4">
                        ({r.is1s ? '1s' : 'Plain'})
                      </span>
                    </td>
                    <td className="p-3">
                      <span className={r.direction === 'BULLISH' ? 'text-success font-bold' : 'text-danger font-bold'}>
                        {r.riseFallLabel || r.direction}
                      </span>{' '}
                      <span className="text-fg-4 text-[10px]">
                        · {r.selectedStrategy ? `${r.selectedStrategy} · ` : ''}
                        {r.marketCondition}
                      </span>
                    </td>
                    <td className="p-3 font-bold text-accent-cyan">{r.confluenceScore}%</td>
                    <td className="p-3 text-accent-cyan">{r.entryPrice?.toFixed(2) ?? '—'}</td>
                    <td className="p-3 text-success">{r.takeProfit?.toFixed(2) ?? '—'}</td>
                    <td className="p-3 text-danger">{r.invalidationLevel?.toFixed(2) ?? '—'}</td>
                    <td className="p-3 text-right">
                      <span
                        className={`font-bold text-[11px] ${
                          r.outcomeStatus === 'TP_HIT'
                            ? 'text-success'
                            : r.outcomeStatus === 'INVALIDATED'
                            ? 'text-danger'
                            : 'text-warning'
                        }`}
                      >
                        {r.outcomeStatus}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-fg-5 font-sans">
                    No confirmed signals logged yet. Signals passing all mandatory price-action, structure, and momentum gates (≥75% confluence) are automatically archived here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
