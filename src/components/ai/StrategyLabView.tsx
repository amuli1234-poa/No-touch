import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Download,
  Gauge,
  Layers,
  Play,
  Radar,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import type { StrategyLabHookValue } from '../../hooks/useStrategyLab';
import {
  ANOMALY_SEVERITY_LABELS,
  type AnomalyReport,
  type AnomalySeverity,
  type RegimeKind,
} from '../../analysis/marketAnomaly';
import {
  STRATEGY_RATING_ORDER,
  type StrategyEvaluation,
  type StrategyRating,
} from '../../analysis/strategyOptimizer';
import { formatPrice } from '../../utils/derivParser';
import { eligibleMarkets } from '../../utils/eligibleMarkets';
import { Card, EmptyState, MeterBar, SectionCard, StatTile, StatusPill } from '../ui/primitives';

interface StrategyLabViewProps {
  lab: StrategyLabHookValue;
}

const RATING_STYLE: Record<StrategyRating, string> = {
  EXCELLENT: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  GOOD: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  DEVELOPING: 'bg-elevated text-muted border-line',
  WEAK: 'bg-amber-500/12 text-warn border-amber-500/30',
  UNRELIABLE: 'bg-red-500/12 text-bear border-red-500/30',
};

const SEVERITY_STYLE: Record<AnomalySeverity, string> = {
  NORMAL: 'bg-elevated text-muted border-line',
  LOW: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  MODERATE: 'bg-amber-500/12 text-warn border-amber-500/30',
  HIGH: 'bg-red-500/15 text-bear border-red-500/40',
  CRITICAL_DATA: 'bg-red-500/20 text-bear border-red-500/50',
};

const REGIME_LABEL: Record<RegimeKind, string> = {
  STRONG_BULLISH: 'Strong bullish',
  STRONG_BEARISH: 'Strong bearish',
  WEAK_TREND: 'Weak trend',
  SIDEWAYS: 'Sideways',
  CONSOLIDATION: 'Consolidation',
  VOLATILITY_COMPRESSION: 'Volatility compression',
  VOLATILITY_EXPANSION: 'Volatility expansion',
  POTENTIAL_REVERSAL: 'Potential reversal',
  TRANSITIONAL: 'Transitional',
};

function fmtPct(v: number | null): string {
  return v === null ? 'n/a' : `${v}%`;
}
function fmtNum(v: number | null, digits = 2): string {
  return v === null ? 'n/a' : v.toFixed(digits);
}

function EvaluationRow({ e }: { e: StrategyEvaluation }) {
  const [open, setOpen] = useState(false);
  const s = e.outOfSample;
  return (
    <>
      <tr className="border-t border-line-soft hover:bg-elevated/40 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <td className="py-1.5 pr-2 text-ink font-semibold truncate max-w-[150px]">{e.displayName}</td>
        <td className="py-1.5 pr-2 font-mono text-muted">{e.timeframe}</td>
        <td className="py-1.5 pr-2 text-ink truncate max-w-[170px]">{e.modelLabel}</td>
        <td className="py-1.5 pr-2 text-right font-mono text-muted">{s.filledTrades}</td>
        <td className="py-1.5 pr-2 text-right font-mono text-muted">{fmtPct(s.winRatePercent)}</td>
        <td className="py-1.5 pr-2 text-right font-mono text-muted">{fmtNum(s.expectancyR)}</td>
        <td className="py-1.5 pr-2 text-right font-mono text-muted">{fmtNum(s.profitFactor)}</td>
        <td className="py-1.5 pr-2 text-right font-mono text-muted">{fmtNum(s.maxDrawdownR, 1)}</td>
        <td className="py-1.5 pr-2">
          <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${RATING_STYLE[e.rating]}`}>
            {e.rating}
          </span>
        </td>
        <td className="py-1.5 pr-2 text-right">
          {e.validated ? (
            <span className="text-emerald-400 text-[11px] font-bold">✓</span>
          ) : (
            <span className="text-faint text-[11px]" title="Out-of-sample sample too small">—</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-panel">
          <td colSpan={10} className="px-3 py-2.5">
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 mb-2">
              <StatTile label="In-sample n" value={e.inSample.filledTrades} />
              <StatTile label="In-sample exp" value={fmtNum(e.inSample.expectancyR)} />
              <StatTile label="OOS TP1" value={fmtPct(s.tp1Rate)} valueClass="text-emerald-400" />
              <StatTile label="OOS TP2" value={fmtPct(s.tp2Rate)} valueClass="text-emerald-400" />
              <StatTile label="OOS TP3" value={fmtPct(s.tp3Rate)} valueClass="text-emerald-400" />
              <StatTile label="Stop rate" value={fmtPct(s.stopRate)} valueClass="text-bear" />
              <StatTile label="Avg R:R" value={fmtNum(s.averageRr)} />
              <StatTile label="Exp after cost" value={fmtNum(s.expectancyAfterCostR)} />
              <StatTile label="Avg win" value={fmtNum(s.averageWinR)} />
              <StatTile label="Avg loss" value={fmtNum(s.averageLossR)} />
              <StatTile label="Avg bars held" value={fmtNum(s.averageBarsHeld, 1)} />
              <StatTile label="Ambiguous" value={s.ambiguous} hint="stop+TP in one candle" />
            </div>
            <ul className="space-y-1">
              {e.notes.map((n, i) => (
                <li key={i} className="text-[10px] text-faint">{n}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

function AnomalyCard({ report, precision, onOpen }: { report: AnomalyReport; precision: number; onOpen: (symbol: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <div className="px-3 py-2.5 flex items-center gap-2.5">
        <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${SEVERITY_STYLE[report.severity]}`}>
          {ANOMALY_SEVERITY_LABELS[report.severity]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-ink truncate">
            {report.displayName}{' '}
            <span className="text-[11px] font-normal text-muted">{REGIME_LABEL[report.regime.regime]}</span>
          </div>
          <div className="text-[11px] text-muted truncate">
            {formatPrice(report.price, precision)} · {report.timeframe} · {report.findings.length} finding(s)
            {report.earlyWarnings.length > 0 && ` · ${report.earlyWarnings.length} early warning(s)`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 h-7 px-2 text-[11px] font-semibold text-muted bg-elevated border border-line rounded-md hover:text-ink cursor-pointer"
        >
          {open ? 'Hide' : 'Details'}
        </button>
        <button
          type="button"
          onClick={() => onOpen(report.symbol)}
          className="shrink-0 h-7 px-2 text-[11px] font-bold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer"
        >
          Open chart
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3 border-t border-line-soft pt-2.5 space-y-2">
          <p className="text-[11px] text-muted">{report.regime.detail}</p>
          <div className="flex flex-wrap gap-1.5">
            <StatusPill label={`Data ${report.dataHealth.healthy ? 'healthy' : 'issue'}`} className={report.dataHealth.healthy ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30' : SEVERITY_STYLE.CRITICAL_DATA} />
            <StatusPill label={`ATR ${fmtNum(report.baseline.atr, 5)}`} className="bg-elevated text-muted border-line" />
            <StatusPill label={`Range med ${fmtNum(report.baseline.rangeMedianAtr)}×ATR`} className="bg-elevated text-muted border-line" />
          </div>
          {report.findings.length > 0 && (
            <div className="space-y-1.5">
              {report.findings.map((f) => (
                <div key={f.id} className="rounded-lg border border-line bg-panel px-2.5 py-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${SEVERITY_STYLE[f.severity]}`}>
                      {f.class}
                    </span>
                    <span className="text-[11px] font-bold text-ink">{f.kind.replace(/_/g, ' ')}</span>
                  </div>
                  <p className="text-[11px] text-muted mt-1">{f.evidence}</p>
                  <p className="text-[10px] text-faint mt-0.5">Impact: {f.impact}</p>
                  <p className="text-[10px] text-accent mt-0.5">Action: {f.action}</p>
                </div>
              ))}
            </div>
          )}
          {report.earlyWarnings.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1">
                Early warnings (not confirmed events)
              </div>
              <ul className="space-y-1">
                {report.earlyWarnings.map((w) => (
                  <li key={w.id} className="text-[11px] text-warn flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{w.evidence}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1">
              Strategy suitability
            </div>
            <ul className="space-y-1">
              {report.suitability.map((s) => (
                <li key={s.module} className="text-[11px] flex items-start gap-1.5">
                  <span
                    className={`shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                      s.verdict === 'SUITABLE'
                        ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
                        : s.verdict === 'CAUTION'
                          ? 'bg-amber-500/12 text-warn border-amber-500/30'
                          : 'bg-red-500/12 text-bear border-red-500/30'
                    }`}
                  >
                    {s.verdict}
                  </span>
                  <span className="text-muted">
                    <span className="text-ink font-semibold">{s.module}:</span> {s.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * AI STRATEGY OPTIMIZATION & MARKET INTELLIGENCE — one tab, two connected engines plus a
 * shared decision-support dashboard. Every control is wired to real functionality.
 */
export function StrategyLabView({ lab }: StrategyLabViewProps) {
  const ws = useWorkspace();
  const [modelFilter, setModelFilter] = useState<string>('ALL');
  const [ratingFilter, setRatingFilter] = useState<StrategyRating | 'ALL'>('ALL');

  const evaluations = useMemo(() => {
    const list = lab.report?.evaluations ?? [];
    return list
      .filter((e) => (modelFilter === 'ALL' ? true : e.model === modelFilter))
      .filter((e) => (ratingFilter === 'ALL' ? true : e.rating === ratingFilter))
      .sort((a, b) => {
        const ra = STRATEGY_RATING_ORDER.indexOf(a.rating);
        const rb = STRATEGY_RATING_ORDER.indexOf(b.rating);
        if (ra !== rb) return ra - rb;
        return (b.outOfSample.expectancyR ?? -99) - (a.outOfSample.expectancyR ?? -99);
      });
  }, [lab.report, modelFilter, ratingFilter]);

  const best = useMemo(() => evaluations.filter((e) => e.rating === 'EXCELLENT' || e.rating === 'GOOD').slice(0, 3), [evaluations]);
  const openSymbol = (symbol: string) => {
    ws.openAnalyser(symbol, lab.selection.timeframes[0] ?? 'M5');
  };

  const downloadResults = () => {
    const csv = lab.exportResults();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `strategy-lab-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const markets = useMemo(() => eligibleMarkets(ws.markets), [ws.markets]);

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-accent">
          <Layers className="w-3.5 h-3.5" aria-hidden="true" />
          AI Strategy Optimization &amp; Market Intelligence
        </span>
        <span className="text-[11px] text-faint">
          Verified measurements only — no guarantees, no fabricated data, no automatic strategy changes.
        </span>
      </div>

      <SectionCard
        title="Controls"
        subtitle="Backtest, validation and live monitoring over real Deriv history."
        icon={<Gauge className="w-4 h-4" aria-hidden="true" />}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {lab.progress.status === 'RUNNING' ? (
              <button
                type="button"
                onClick={lab.stopBacktest}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-bold text-bear bg-red-500/12 border border-red-500/40 rounded-md cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" aria-hidden="true" /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void lab.startBacktest()}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-bold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" aria-hidden="true" /> Start backtest
              </button>
            )}
            <button
              type="button"
              onClick={() => void lab.runValidation()}
              disabled={lab.progress.status === 'RUNNING'}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Run validation
            </button>
            {lab.monitoring ? (
              <button
                type="button"
                onClick={lab.pauseMonitoring}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-warn bg-amber-500/12 border border-amber-500/35 rounded-md cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" aria-hidden="true" /> Pause monitor
              </button>
            ) : (
              <button
                type="button"
                onClick={lab.startMonitoring}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer"
              >
                <Radar className="w-3.5 h-3.5" aria-hidden="true" /> Start monitoring
              </button>
            )}
            <button
              type="button"
              onClick={downloadResults}
              disabled={!lab.report}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-muted bg-panel border border-line rounded-md hover:text-ink disabled:opacity-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" /> Export
            </button>
            <button
              type="button"
              onClick={lab.clearResults}
              disabled={!lab.report && lab.anomalyReports.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-muted bg-panel border border-line rounded-md hover:text-ink disabled:opacity-50 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Clear
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-faint">Historical period</span>
              <select
                value={lab.selection.historyBars}
                onChange={(e) => lab.setHistoryBars(Number(e.target.value))}
                className="w-full bg-elevated border border-line rounded-md px-2 py-1.5 text-[12px] text-ink"
              >
                {lab.historyOptions.map((h) => (
                  <option key={h} value={h}>
                    {h} candles
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-faint">Anomaly sensitivity</span>
              <select
                value={lab.sensitivity}
                onChange={(e) => lab.setSensitivity(e.target.value as never)}
                className="w-full bg-elevated border border-line rounded-md px-2 py-1.5 text-[12px] text-ink"
              >
                <option value="LOW">Low (fewer alerts)</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High (most sensitive)</option>
              </select>
            </label>
            <div className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-faint">Timeframes</span>
              <div className="flex flex-wrap gap-1.5">
                {lab.allTimeframes.map((tf) => {
                  const active = lab.selection.timeframes.includes(tf.key);
                  return (
                    <button
                      key={tf.key}
                      type="button"
                      onClick={() =>
                        lab.setTimeframes(
                          active
                            ? lab.selection.timeframes.filter((t) => t !== tf.key)
                            : [...lab.selection.timeframes, tf.key]
                        )
                      }
                      className={`h-7 px-2.5 rounded-md border text-[11px] font-semibold cursor-pointer ${
                        active ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-faint border-line'
                      }`}
                    >
                      {tf.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1.5">
              Indices (none selected = all eligible Volatility Indices)
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {markets.map((m) => {
                const active = lab.selection.symbols.includes(m.symbol);
                return (
                  <button
                    key={m.symbol}
                    type="button"
                    onClick={() => lab.toggleSymbol(m.symbol)}
                    className={`h-7 px-2.5 rounded-md border text-[11px] font-semibold cursor-pointer ${
                      active ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-faint border-line'
                    }`}
                  >
                    {m.displayName}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1.5">
              Entry models ({lab.selection.models.length} selected)
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {lab.allModels.map((m) => {
                const active = lab.selection.models.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => lab.toggleModel(m.id)}
                    className={`h-7 px-2.5 rounded-md border text-[11px] font-semibold cursor-pointer ${
                      active ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-faint border-line'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {lab.progress.status !== 'IDLE' && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>{lab.progress.message}</span>
                <span className="font-mono">{lab.progressPercent}%</span>
              </div>
              <MeterBar value={lab.progressPercent} />
            </div>
          )}
        </div>
      </SectionCard>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="Evaluations" value={lab.report?.evaluations.length ?? 0} />
        <StatTile label="Validated" value={evaluations.filter((e) => e.validated).length} />
        <StatTile label="Best rating" value={best[0]?.rating ?? 'n/a'} valueClass="text-emerald-400" />
        <StatTile label="Monitored indices" value={lab.anomalyReports.length} hint={lab.monitoring ? 'live' : 'paused'} />
      </div>

      <SectionCard
        title="Strategy performance"
        subtitle="Out-of-sample measurements from the no-look-ahead replay. Click a row for full detail."
        icon={<TrendingUp className="w-4 h-4" aria-hidden="true" />}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select
              value={ratingFilter}
              onChange={(e) => setRatingFilter(e.target.value as never)}
              className="bg-elevated border border-line rounded-md px-2 py-1 text-[11px] text-ink"
              aria-label="Filter by rating"
            >
              <option value="ALL">All ratings</option>
              {STRATEGY_RATING_ORDER.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              className="bg-elevated border border-line rounded-md px-2 py-1 text-[11px] text-ink"
              aria-label="Filter by model"
            >
              <option value="ALL">All models</option>
              {lab.allModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {evaluations.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="w-6 h-6" aria-hidden="true" />}
            title="No backtest results yet"
            description="Choose your indices, timeframes and models, then press Start backtest. Every measurement comes from real Deriv candles replayed without look-ahead."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-faint text-left">
                  <th className="py-1.5 pr-2 font-semibold">Index</th>
                  <th className="py-1.5 pr-2 font-semibold">TF</th>
                  <th className="py-1.5 pr-2 font-semibold">Model</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">n</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Win %</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Exp (R)</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">PF</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">MaxDD</th>
                  <th className="py-1.5 pr-2 font-semibold">Rating</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Valid</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((e) => (
                  <EvaluationRow key={`${e.symbol}-${e.timeframe}-${e.model}`} e={e} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {lab.walkForward.length > 0 && (
        <SectionCard
          title="Walk-forward validation"
          subtitle="Each test window is trained only on data that came before it."
          icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
        >
          <div className="space-y-2">
            {lab.walkForward.slice(0, 8).map((w) => (
              <div key={w.model} className="rounded-lg border border-line bg-panel px-2.5 py-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[12px] font-bold text-ink">{w.modelLabel}</span>
                  <span className="text-[11px] text-muted">
                    Consistency {fmtPct(w.consistencyPercent)} · Aggregate OOS expectancy{' '}
                    {fmtNum(w.aggregateOutOfSampleExpectancyR)}R
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {w.windows.map((win) => (
                    <StatusPill
                      key={win.index}
                      label={`W${win.index + 1} ${win.outOfSampleExpectancyR === null ? 'n/a' : `${win.outOfSampleExpectancyR.toFixed(2)}R`}`}
                      className={win.consistent ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30' : 'bg-elevated text-muted border-line'}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Market intelligence & anomalies"
        subtitle="Live per-index reads. Data issues are never confused with unusual market behaviour."
        icon={<Radar className="w-4 h-4" aria-hidden="true" />}
        right={
          lab.lastMonitoredAt ? (
            <span className="text-[10px] text-faint">
              updated {new Date(lab.lastMonitoredAt).toLocaleTimeString()}
            </span>
          ) : undefined
        }
      >
        {lab.anomalyReports.length === 0 ? (
          <EmptyState
            icon={<Radar className="w-6 h-6" aria-hidden="true" />}
            title="Monitoring is paused"
            description="Press Start monitoring to read every selected index continuously for anomalies and regime changes."
          />
        ) : (
          <div className="grid lg:grid-cols-2 gap-2">
            {[...lab.anomalyReports]
              .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
              .map((r) => (
                <AnomalyCard key={r.symbol} report={r} precision={ws.precision} onOpen={openSymbol} />
              ))}
          </div>
        )}
      </SectionCard>

      {lab.regimeChanges.length > 0 && (
        <SectionCard
          title="Regime changes"
          subtitle="Confirmed regime transitions observed while monitoring."
          icon={<AlertTriangle className="w-4 h-4" aria-hidden="true" />}
        >
          <ul className="space-y-1">
            {lab.regimeChanges.slice(0, 12).map((c, i) => (
              <li key={i} className="text-[11px] text-muted">
                <span className="text-ink font-semibold">{c.displayName}</span> · {REGIME_LABEL[c.from]} →{' '}
                <span className="text-warn">{REGIME_LABEL[c.to]}</span> ·{' '}
                {new Date(c.at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title="Recommendations"
        subtitle="Evidence-based only. Applying any change requires your explicit approval."
        icon={<ShieldAlert className="w-4 h-4" aria-hidden="true" />}
      >
        {!lab.report || lab.report.recommendations.length === 0 ? (
          <div className="text-[11px] text-faint py-3 text-center">
            Run a backtest to generate evidence-based recommendations.
          </div>
        ) : (
          <ul className="space-y-2">
            {lab.report.recommendations.map((r) => (
              <li key={r.id} className="rounded-lg border border-line bg-panel px-2.5 py-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                      r.severity === 'ACTION'
                        ? 'bg-red-500/12 text-bear border-red-500/30'
                        : r.severity === 'WATCH'
                          ? 'bg-amber-500/12 text-warn border-amber-500/30'
                          : 'bg-blue-500/12 text-blue-400 border-blue-500/30'
                    }`}
                  >
                    {r.severity}
                  </span>
                  <span className="text-[12px] font-bold text-ink">{r.title}</span>
                </div>
                <p className="text-[11px] text-muted mt-1">{r.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function severityRank(s: AnomalySeverity): number {
  return { NORMAL: 0, LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL_DATA: 4 }[s];
}
