import {
  Activity,
  Award,
  BarChart3,
  CircleStop,
  Database,
  GraduationCap,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Card, EquitySparkline, MeterBar, SectionCard, StatTile } from '../ui/primitives';
import { collectTrades, rankModelsByOutOfSample, segmentTrades } from '../../analysis/training';
import type { BacktestStats, TrainingSegment } from '../../types/training';
import { formatPrice } from '../../utils/derivParser';
import { eligibleMarkets } from '../../utils/eligibleMarkets';

type SegmentTab = 'model' | 'market' | 'timeframe';
type SampleTab = 'outOfSample' | 'inSample' | 'overall';

function pct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}
function r(value: number | null): string {
  return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
}

function StatsGrid({ stats }: { stats: BacktestStats }) {
  const winTone =
    stats.winRatePercent === null
      ? 'text-ink'
      : stats.winRatePercent >= 50
        ? 'text-emerald-400'
        : 'text-warn';
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
      <StatTile label="Setups Found" value={stats.totalSetups} hint={`${stats.filledTrades} filled`} />
      <StatTile
        label="Win Rate"
        value={<span className={winTone}>{pct(stats.winRatePercent)}</span>}
        hint={`${stats.wins}W / ${stats.losses}L settled`}
      />
      <StatTile label="Avg Reward:Risk" value={r(stats.averageRr)} hint="Realized per filled trade" />
      <StatTile
        label="Max Drawdown"
        value={`${stats.maxDrawdownR.toFixed(2)}R`}
        hint={`${stats.maxConsecutiveLosses} max consecutive losses`}
      />
      <StatTile
        label="Avg MFE"
        value={stats.avgFavourablePct === null ? '—' : `${stats.avgFavourablePct.toFixed(2)}%`}
        hint="Max favourable excursion"
      />
      <StatTile
        label="Avg MAE"
        value={stats.avgAdversePct === null ? '—' : `${stats.avgAdversePct.toFixed(2)}%`}
        hint="Max adverse excursion"
      />
      <StatTile
        label="Missed / Invalid"
        value={`${stats.missed} / ${stats.invalidated}`}
        hint="Never chased"
      />
      <StatTile
        label="Profit Factor"
        value={stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}
        hint="Gross win ÷ gross loss"
      />
    </div>
  );
}

function SegmentTable({ segments, title }: { segments: TrainingSegment[]; title: string }) {
  if (segments.length === 0) {
    return <p className="text-xs text-muted">No {title.toLowerCase()} data yet.</p>;
  }
  const ranked = [...segments].sort(
    (a, b) => (b.winRatePercent ?? -1) - (a.winRatePercent ?? -1)
  );
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-left border-collapse min-w-[560px]">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-faint border-b border-line">
            <th className="py-2 px-2 font-bold">{title}</th>
            <th className="py-2 px-2 font-bold text-right">Sample</th>
            <th className="py-2 px-2 font-bold text-right">Win Rate</th>
            <th className="py-2 px-2 font-bold text-right">Avg R:R</th>
            <th className="py-2 px-2 font-bold text-right">Max DD</th>
            <th className="py-2 px-2 font-bold text-right">MFE / MAE</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {ranked.map((s) => (
            <tr key={s.key} className="text-xs">
              <td className="py-2 px-2 text-ink font-semibold">{s.label}</td>
              <td className="py-2 px-2 text-right font-mono text-muted">{s.sampleCount}</td>
              <td className="py-2 px-2 text-right font-mono">
                {s.winRatePercent === null ? (
                  <span className="text-faint" title="Sample too small to report a rate">
                    n/a
                  </span>
                ) : (
                  <span
                    className={s.winRatePercent >= 50 ? 'text-emerald-400' : 'text-warn'}
                  >
                    {s.winRatePercent.toFixed(1)}%
                  </span>
                )}
              </td>
              <td className="py-2 px-2 text-right font-mono text-ink">{r(s.averageRr)}</td>
              <td className="py-2 px-2 text-right font-mono text-muted">
                {s.maxDrawdownR === null ? '—' : `${s.maxDrawdownR.toFixed(2)}R`}
              </td>
              <td className="py-2 px-2 text-right font-mono text-faint">
                {s.avgFavourablePct === null ? '—' : `${s.avgFavourablePct.toFixed(2)}%`} /{' '}
                {s.avgAdversePct === null ? '—' : `${s.avgAdversePct.toFixed(2)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TrainingView() {
  const ws = useWorkspace();
  const { result, progress, progressPercent, selection } = ws.training;
  const [segmentTab, setSegmentTab] = useState<SegmentTab>('model');
  const [sampleTab, setSampleTab] = useState<SampleTab>('outOfSample');

  const scope = sampleTab === 'overall' ? 'overall' : sampleTab;
  const scopedTrades = useMemo(
    () => (result ? collectTrades(result.reports, scope) : []),
    [result, scope]
  );
  const segments = useMemo(() => segmentTrades(scopedTrades, segmentTab), [scopedTrades, segmentTab]);
  const rankings = useMemo(
    () => (result ? rankModelsByOutOfSample(result.reports) : []),
    [result]
  );
  const equityPoints = useMemo(
    () => (result ? result.reports.flatMap((rep) => rep.equityCurve.map((p) => p.equityR)) : []),
    [result]
  );

  // Aggregate stats for the selected sample scope (computed directly, never fabricated).
  const aggregate = useMemo(() => {
    if (!result) return null;
    const trades = collectTrades(result.reports, scope);
    const filled = trades.filter((t) => t.status === 'TARGET_HIT' || t.status === 'STOP_HIT');
    const wins = filled.filter((t) => t.status === 'TARGET_HIT').length;
    const losses = filled.filter((t) => t.status === 'STOP_HIT').length;
    const settled = wins + losses;
    const rrs = filled.map((t) => t.realizedRr).filter((x): x is number => x !== null);
    let equity = 0;
    let peak = 0;
    let dd = 0;
    for (const t of trades) {
      if (t.realizedRr === null) continue;
      equity += t.realizedRr;
      peak = Math.max(peak, equity);
      dd = Math.max(dd, peak - equity);
    }
    let streak = 0;
    let maxStreak = 0;
    for (const t of trades) {
      if (t.status === 'STOP_HIT') {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else if (t.status === 'TARGET_HIT') streak = 0;
    }
    const mfes = filled.map((t) => t.maxFavourableExcursionPct);
    const maes = filled.map((t) => t.maxAdverseExcursionPct);
    const grossWin = filled
      .filter((t) => t.status === 'TARGET_HIT')
      .reduce((a, t) => a + (t.realizedRr ?? 0), 0);
    const grossLoss = filled
      .filter((t) => t.status === 'STOP_HIT')
      .reduce((a, t) => a + Math.abs(t.realizedRr ?? 0), 0);
    return {
      stats: {
        totalSetups: trades.length,
        filledTrades: filled.length,
        wins,
        losses,
        missed: trades.filter((t) => t.status === 'MISSED').length,
        invalidated: trades.filter((t) => t.status === 'INVALIDATED').length,
        winRatePercent: settled > 0 ? Number(((wins / settled) * 100).toFixed(1)) : null,
        averageRr:
          rrs.length > 0
            ? Number((rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(3))
            : null,
        maxConsecutiveLosses: maxStreak,
        maxDrawdownR: Number(dd.toFixed(3)),
        avgFavourablePct:
          mfes.length > 0
            ? Number((mfes.reduce((a, b) => a + b, 0) / mfes.length).toFixed(3))
            : null,
        avgAdversePct:
          maes.length > 0
            ? Number((maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(3))
            : null,
        profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : null,
      } satisfies BacktestStats,
      notes: result.reports[0]?.notes ?? [],
    };
  }, [result, scope]);

  const statusTone =
    progress.status === 'RUNNING'
      ? 'text-accent'
      : progress.status === 'PAUSED'
        ? 'text-warn'
        : progress.status === 'COMPLETE'
          ? 'text-emerald-400'
          : progress.status === 'CANCELLED'
            ? 'text-bear'
            : 'text-muted';

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GraduationCap className="w-5 h-5 text-accent" aria-hidden="true" />
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-ink">
                AI Setup Training &amp; Backtesting
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-muted leading-relaxed mt-1.5 max-w-3xl">
              Trains and tests the eight entry models on real Deriv historical candles. Every setup
              is replayed chronologically — decisions use only candles already closed at that bar
              (no look-ahead). Entry and stop-loss are locked at publication; the take-profit
              evolves using the same rules that run live.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            {progress.status !== 'RUNNING' ? (
              <button
                type="button"
                onClick={() => void ws.training.startTraining()}
                disabled={ws.training.eligibleMarkets().length === 0}
                className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-bold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4" aria-hidden="true" />
                {result ? 'RETRAIN' : 'START TRAINING'}
              </button>
            ) : (
              <button
                type="button"
                onClick={ws.training.pauseTraining}
                className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-bold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 transition-colors cursor-pointer"
              >
                <Pause className="w-4 h-4" aria-hidden="true" />
                PAUSE
              </button>
            )}
            {progress.status === 'PAUSED' && (
              <button
                type="button"
                onClick={ws.training.resumeTraining}
                className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-bold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer"
              >
                <Play className="w-4 h-4" aria-hidden="true" />
                RESUME
              </button>
            )}
            {(progress.status === 'RUNNING' || progress.status === 'PAUSED') && (
              <button
                type="button"
                onClick={ws.training.cancelTraining}
                className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-bold text-bear bg-bear/10 border border-bear/30 rounded-md hover:bg-bear/20 transition-colors cursor-pointer"
              >
                <CircleStop className="w-4 h-4" aria-hidden="true" />
                CANCEL
              </button>
            )}
            {result && progress.status !== 'RUNNING' && (
              <button
                type="button"
                onClick={ws.training.clearTraining}
                className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-bold text-muted bg-elevated border border-line rounded-md hover:border-bear/40 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                CLEAR
              </button>
            )}
          </div>
        </div>

        {(progress.status !== 'IDLE' || progress.total > 0) && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-3 mb-1.5">
              <span className={`text-[12px] font-bold uppercase tracking-wide ${statusTone}`}>
                {progress.status}
                {progress.total > 0 ? ` · ${progress.completed}/${progress.total}` : ''}
              </span>
              <span className="text-[12px] font-mono text-faint">{progressPercent}%</span>
            </div>
            <MeterBar value={progressPercent} className="bg-accent" height="h-1.5" />
            <p className="text-[12px] text-muted leading-relaxed mt-2">{progress.message}</p>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard
          title="Training Universe"
          subtitle="Real Deriv indices the engine will learn from"
          icon={<Database className="w-4 h-4" />}
        >
          <div className="space-y-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-faint mb-1.5">
                Markets (auto-selects every eligible Volatility Index when none chosen)
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                {eligibleMarkets(ws.markets, { requireOpen: false })
                  .map((m) => {
                    const active = selection.symbols.includes(m.symbol);
                    return (
                      <button
                        key={m.symbol}
                        type="button"
                        onClick={() => ws.training.toggleSymbol(m.symbol)}
                        className={`text-[11px] font-mono font-bold px-2 py-1 rounded border transition-colors cursor-pointer ${
                          active
                            ? 'bg-accent/15 text-accent border-accent/40'
                            : 'bg-panel text-muted border-line hover:border-accent/30'
                        }`}
                      >
                        {m.symbol}
                      </button>
                    );
                  })}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-faint mb-1.5">
                Timeframes
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ws.training.allTimeframes.map((tf) => {
                  const active = selection.timeframes.includes(tf.key);
                  return (
                    <button
                      key={tf.key}
                      type="button"
                      onClick={() =>
                        ws.training.setTimeframes(
                          active
                            ? selection.timeframes.filter((t) => t !== tf.key)
                            : [...selection.timeframes, tf.key]
                        )
                      }
                      className={`text-[12px] font-bold px-2.5 py-1 rounded border transition-colors cursor-pointer ${
                        active
                          ? 'bg-accent/15 text-accent border-accent/40'
                          : 'bg-panel text-muted border-line hover:border-accent/30'
                      }`}
                    >
                      {tf.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-[11px] text-faint leading-relaxed">
              {ws.training.eligibleMarkets().length} market(s) × {selection.timeframes.length}{' '}
              timeframe(s) will be replayed. Large runs pause between instruments so the UI stays
              responsive.
            </p>
          </div>
        </SectionCard>

        <SectionCard
          title="Entry Models"
          subtitle="Each model is trained and tested independently"
          icon={<Activity className="w-4 h-4" />}
        >
          <div className="space-y-1.5">
            {ws.training.allModels.map((m) => {
              const active = selection.models.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => ws.training.toggleModel(m.id)}
                  className={`w-full flex items-center gap-2 text-left text-[12px] font-semibold px-2.5 py-2 rounded border transition-colors cursor-pointer ${
                    active
                      ? 'bg-accent/10 text-ink border-accent/30'
                      : 'bg-panel text-muted border-line hover:border-accent/30'
                  }`}
                >
                  <span
                    className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
                      active ? 'bg-accent border-accent' : 'border-line'
                    }`}
                    aria-hidden="true"
                  >
                    {active && <span className="w-1.5 h-1.5 bg-app rounded-sm" />}
                  </span>
                  {m.label}
                </button>
              );
            })}
          </div>
        </SectionCard>

        <SectionCard
          title="Run Summary"
          subtitle="Provenance and coverage of the last completed pass"
          icon={<BarChart3 className="w-4 h-4" />}
        >
          {result ? (
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile label="Reports" value={result.reports.length} hint="Instrument × model" />
              <StatTile label="Real Candles" value={result.totalBarsAnalyzed} hint="Replayed chronologically" />
              <StatTile label="Markets" value={result.marketCount} />
              <StatTile label="Models" value={result.modelCount} />
              <StatTile
                label="Generated"
                value={
                  <span className="text-xs">
                    {new Date(result.generatedAt).toLocaleString()}
                  </span>
                }
                hint="Local time"
              />
              <StatTile
                label="Settled Trades"
                value={aggregate?.stats.filledTrades ?? 0}
                hint={`of ${aggregate?.stats.totalSetups ?? 0} setups`}
              />
            </div>
          ) : (
            <p className="text-xs text-muted leading-relaxed">
              No training run stored yet. Choose your universe and press Start Training. Results are
              saved locally so they survive a reload.
            </p>
          )}
        </SectionCard>
      </div>

      {result && aggregate && (
        <>
          <SectionCard
            title="Performance — In-Sample vs Out-of-Sample"
            subtitle="Out-of-sample is the honest forward test: data the models never learned from"
            icon={<TrendingUp className="w-4 h-4" />}
            right={
              <div className="ws-vsubnav flex gap-1">
                {(['outOfSample', 'inSample', 'overall'] as SampleTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSampleTab(tab)}
                    className={`text-[11px] font-bold px-2.5 py-1 rounded border transition-colors cursor-pointer ${
                      sampleTab === tab
                        ? 'bg-accent/15 text-accent border-accent/40'
                        : 'bg-panel text-muted border-line hover:border-accent/30'
                    }`}
                  >
                    {tab === 'outOfSample' ? 'OUT-OF-SAMPLE' : tab === 'inSample' ? 'IN-SAMPLE' : 'ALL'}
                  </button>
                ))}
              </div>
            }
          >
            <StatsGrid stats={aggregate.stats} />
            <div className="mt-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-faint mb-1">
                Equity Curve (cumulative R)
              </div>
              <EquitySparkline points={equityPoints} />
            </div>
            <ul className="mt-3 space-y-1">
              {aggregate.notes.map((note, i) => (
                <li key={i} className="text-[12px] text-faint leading-relaxed flex gap-1.5">
                  <span className="text-accent mt-0.5">•</span>
                  {note}
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            title="Best-Performing Models"
            subtitle="Ranked by out-of-sample win rate; models with too few settled trades are flagged"
            icon={<Award className="w-4 h-4" />}
          >
            {rankings.length === 0 ? (
              <p className="text-xs text-muted">No model produced setups in this run.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {rankings.map((rank, idx) => (
                  <li key={rank.model} className="py-2.5 flex items-center gap-3">
                    <span className="text-[12px] font-mono font-bold text-faint w-5 shrink-0">
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-ink truncate">
                          {rank.modelLabel}
                        </span>
                        {!rank.reportable && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-warn"
                            title="Out-of-sample sample too small to trust"
                          >
                            <ShieldAlert className="w-3 h-3" aria-hidden="true" />
                            low sample
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-faint font-mono mt-0.5">
                        {rank.stats.wins}W / {rank.stats.losses}L · avg {r(rank.stats.averageRr)} · DD{' '}
                        {rank.stats.maxDrawdownR.toFixed(2)}R
                      </div>
                    </div>
                    <div className="w-24 shrink-0 text-right">
                      <div
                        className={`text-sm font-mono font-bold ${
                          rank.reportable && (rank.stats.winRatePercent ?? 0) >= 50
                            ? 'text-emerald-400'
                            : rank.reportable
                              ? 'text-warn'
                              : 'text-faint'
                        }`}
                      >
                        {rank.reportable ? pct(rank.stats.winRatePercent) : 'n/a'}
                      </div>
                      <div className="text-[10px] text-faint uppercase tracking-wide">win rate</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Segmented Performance"
            subtitle="Never blended across models, markets or timeframes — inspect each segment honestly"
            icon={<BarChart3 className="w-4 h-4" />}
            right={
              <div className="ws-vsubnav flex gap-1">
                {(['model', 'market', 'timeframe'] as SegmentTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSegmentTab(tab)}
                    className={`text-[11px] font-bold px-2.5 py-1 rounded border transition-colors cursor-pointer ${
                      segmentTab === tab
                        ? 'bg-accent/15 text-accent border-accent/40'
                        : 'bg-panel text-muted border-line hover:border-accent/30'
                    }`}
                  >
                    BY {tab.toUpperCase()}
                  </button>
                ))}
              </div>
            }
          >
            <SegmentTable segments={segments} title={segmentTab === 'model' ? 'Model' : segmentTab === 'market' ? 'Market' : 'Timeframe'} />
          </SectionCard>

          <SectionCard
            title="Strategy Comparison"
            subtitle="Recent setups with locked entry/stop, dynamic take-profit and realized outcome"
            icon={<TrendingDown className="w-4 h-4" />}
          >
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-left border-collapse min-w-[720px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-faint border-b border-line">
                    <th className="py-2 px-2 font-bold">Market</th>
                    <th className="py-2 px-2 font-bold">Model</th>
                    <th className="py-2 px-2 font-bold text-right">Dir</th>
                    <th className="py-2 px-2 font-bold text-right">Entry</th>
                    <th className="py-2 px-2 font-bold text-right">Stop</th>
                    <th className="py-2 px-2 font-bold text-right">TP</th>
                    <th className="py-2 px-2 font-bold text-right">TP Adj.</th>
                    <th className="py-2 px-2 font-bold text-right">Outcome</th>
                    <th className="py-2 px-2 font-bold text-right">R</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {scopedTrades
                    .slice()
                    .sort((a, b) => b.confirmedBarTime - a.confirmedBarTime)
                    .slice(0, 40)
                    .map((t) => (
                      <tr key={t.id} className="text-[12px]">
                        <td className="py-2 px-2 text-ink font-semibold whitespace-nowrap">
                          {t.symbol} <span className="text-faint font-mono">{t.timeframe}</span>
                        </td>
                        <td className="py-2 px-2 text-muted max-w-[180px] truncate" title={t.modelLabel}>
                          {t.modelLabel}
                        </td>
                        <td className="py-2 px-2 text-right">
                          <span
                            className={t.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'}
                          >
                            {t.direction}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-ink">
                          {formatPrice(t.entry, 2)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-bear">
                          {formatPrice(t.stopLoss, 2)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-accent">
                          {formatPrice(t.finalTakeProfit, 2)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-muted">
                          {t.tpAdjustments.length}
                        </td>
                        <td className="py-2 px-2 text-right">
                          <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                              t.status === 'TARGET_HIT'
                                ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
                                : t.status === 'STOP_HIT'
                                  ? 'bg-red-500/12 text-bear border-red-500/30'
                                  : t.status === 'MISSED'
                                    ? 'bg-warn/12 text-warn border-warn/30'
                                    : 'bg-panel text-muted border-line'
                            }`}
                          >
                            {t.status}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right font-mono font-bold text-ink">
                          {t.realizedRr === null ? '—' : r(t.realizedRr)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {scopedTrades.length === 0 && (
              <p className="text-xs text-muted mt-2">
                No trades in this sample scope. Try the ALL tab or train on more markets.
              </p>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
