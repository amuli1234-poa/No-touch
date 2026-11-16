import {
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  Gauge,
  GraduationCap,
  Minus,
  Maximize2,
  Radio,
  ScanSearch,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { ManagedSignalsPanel } from '../ManagedSignalsPanel';
import { SignalFeedList } from '../SignalFeed';
import { Card, SectionCard, StatTile, StatusPill } from '../ui/primitives';
import { AiLiveStatus } from '../dashboard/AiLiveStatus';
import { BestSignalPanel } from '../dashboard/BestSignalPanel';
import { LiveFeedDiagnostics } from '../dashboard/LiveFeedDiagnostics';
import { MarketCard } from '../dashboard/MarketCard';
import { PerformanceStats } from '../dashboard/PerformanceStats';
import { formatCandleTime, formatPrice } from '../../utils/derivParser';
import { SIGNAL_STATUS_STYLE } from '../../utils/signalStatus';
import { eligibleMarkets } from '../../utils/eligibleMarkets';

/**
 * PLATFORM STATUS STRIP — the Overview's at-a-glance system read: Deriv connection,
 * eligible-market count (with Jump/Step families), automatic background scanning status
 * and the active-setup summary. Counts are always derived from live state, never faked.
 */
function PlatformStatusStrip() {
  const ws = useWorkspace();
  const eligible = eligibleMarkets(ws.markets, { requireOpen: false });
  const jump = eligible.filter((m) => m.family === 'JUMP').length;
  const step = eligible.filter((m) => m.family === 'STEP').length;
  const monitored = ws.monitorSummary?.monitoredCount ?? 0;
  const scanning = ws.isScanning || monitored > 0;

  return (
    <div
      data-testid="platform-status"
      className="grid grid-cols-2 lg:grid-cols-4 gap-3"
    >
      <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          Deriv connection
        </div>
        <div
          className={`text-sm font-bold mt-0.5 ${
            ws.connectionStatus === 'connected' ? 'text-emerald-400' : 'text-warn'
          }`}
        >
          {ws.connectionStatus === 'connected' ? 'Connected' : ws.connectionStatus}
        </div>
      </div>
      <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          Eligible markets
        </div>
        <div className="text-sm font-bold font-mono text-ink mt-0.5">
          {eligible.length}
          <span className="text-[11px] font-normal text-faint ml-1">
            ({jump} Jump · {step} Step)
          </span>
        </div>
      </div>
      <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          Automatic scanning
        </div>
        <div
          className={`text-sm font-bold mt-0.5 ${scanning ? 'text-emerald-400' : 'text-muted'}`}
        >
          {scanning ? `Running · ${monitored} monitored` : 'Standby'}
        </div>
      </div>
      <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          Active setups
        </div>
        <div className="text-sm font-bold font-mono text-ink mt-0.5">
          {ws.monitorSummary?.activeCount ?? 0}
        </div>
      </div>
    </div>
  );
}

function directionMeta(dir: string) {
  if (dir === 'BULLISH')
    return { label: 'Bullish', cls: 'text-emerald-400', Icon: TrendingUp };
  if (dir === 'BEARISH')
    return { label: 'Bearish', cls: 'text-bear', Icon: TrendingDown };
  return { label: 'Ranging', cls: 'text-muted', Icon: Minus };
}

export function DashboardView() {
  const ws = useWorkspace();
  const latest = ws.candles.length > 0 ? ws.candles[ws.candles.length - 1] : null;
  const dir = ws.report?.overallDirection ?? 'NEUTRAL';
  const meta = directionMeta(dir);
  const DirIcon = meta.Icon;

  const lastCandleChange =
    latest && latest.open !== 0
      ? ((latest.close - latest.open) / latest.open) * 100
      : null;

  const lifecycle = ws.lifecycle;
  const lifecycleStyle = lifecycle ? SIGNAL_STATUS_STYLE[lifecycle.status] : null;

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-faint">
                {ws.marketFamily} · {ws.selectedSymbol}
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-panel border border-line text-muted font-bold">
                {ws.timeframe}
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-ink mt-1 truncate">
              {ws.marketName}
            </h1>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`inline-flex items-center gap-1 text-sm font-bold ${meta.cls}`}>
                <DirIcon className="w-4 h-4" aria-hidden="true" />
                {meta.label}
              </span>
              {lastCandleChange !== null && (
                <span
                  className={`font-mono text-xs font-semibold ${
                    lastCandleChange >= 0 ? 'text-emerald-400' : 'text-bear'
                  }`}
                >
                  {lastCandleChange >= 0 ? '+' : ''}
                  {lastCandleChange.toFixed(3)}% (last bar)
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4 sm:gap-6 shrink-0">
            <div className="text-right">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                Current Price
              </div>
              <div className="font-mono text-2xl sm:text-3xl font-extrabold tabular-nums text-ink">
                {ws.livePrice !== null ? formatPrice(ws.livePrice, ws.precision) : '—'}
              </div>
            </div>
            {lifecycle && lifecycleStyle && (
              <StatusPill
                label={lifecycle.label}
                className={`${lifecycleStyle.bg} ${lifecycleStyle.text} ${lifecycleStyle.border}`}
                dotClass={lifecycleStyle.dot}
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          <button
            type="button"
            onClick={() => ws.navigate('analyser')}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-white bg-accent rounded-lg hover:bg-accent-soft active:scale-[0.98] transition-all duration-150 cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
            Open chart
          </button>
          <button
            type="button"
            onClick={() => ws.navigate('analyser')}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-accent bg-accent/12 border border-accent/30 rounded-md hover:bg-accent/20 transition-colors cursor-pointer"
          >
            <ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />
            OPEN CHART ANALYSER
          </button>
        </div>
      </Card>

      <PlatformStatusStrip />

      <AiLiveStatus />

      <LiveFeedDiagnostics />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4">
        <BestSignalPanel />
        <SectionCard
          title="Live Market Readings"
          subtitle="Monitor-only breadth readings — colour and icon both show direction"
          icon={<Radio className="w-4 h-4" />}
          right={
            <button
              type="button"
              onClick={() => ws.navigate('scanner')}
              className="text-[12px] font-semibold text-accent hover:text-accent-soft cursor-pointer"
            >
              Full scanner
            </button>
          }
        >
          {ws.monitorSummary && ws.monitorSummary.readings.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[...ws.monitorSummary.readings]
                .sort((a, b) => (b.lastCandleChangePercent ?? 0) - (a.lastCandleChangePercent ?? 0))
                .slice(0, 6)
                .map((reading) => (
                  <MarketCard
                    key={reading.symbol}
                    reading={reading}
                    selected={reading.symbol === ws.selectedSymbol}
                    onSelect={() => ws.openChart(reading.symbol, ws.timeframe, null)}
                  />
                ))}
            </div>
          ) : (
            <p className="text-xs text-muted leading-relaxed">
              No live readings yet. Open the Market Scanner and run a sweep to populate
              real-time volatility and activity readings.
            </p>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Trendline Scanner"
        subtitle="Dedicated trendline module — M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1, 4 models"
        icon={<TrendingUp className="w-4 h-4" />}
        right={
          <button
            type="button"
            onClick={() => ws.navigate('trendlines')}
            className="text-[12px] font-semibold text-accent hover:text-accent-soft cursor-pointer"
          >
            Open module
          </button>
        }
      >
        {ws.trendlineScanner.summary?.winner ? (
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-extrabold ${
                ws.trendlineScanner.summary.winner.direction === 'RISE'
                  ? 'text-emerald-400'
                  : 'text-bear'
              }`}
            >
              {ws.trendlineScanner.summary.winner.direction === 'RISE' ? (
                <TrendingUp className="w-4 h-4" aria-hidden="true" />
              ) : (
                <TrendingDown className="w-4 h-4" aria-hidden="true" />
              )}
              {ws.trendlineScanner.summary.winner.direction}
            </span>
            <span className="text-sm font-bold text-ink truncate">
              {ws.trendlineScanner.summary.winner.displayName}
            </span>
            <StatusPill
              label={ws.trendlineScanner.summary.winner.modelLabel}
              className="bg-accent/12 text-accent border-accent/25"
            />
            <span className="text-xs font-mono text-muted">
              {ws.trendlineScanner.summary.winner.score}/100
            </span>
            <span className="text-xs font-mono text-muted">
              Entry {formatPrice(ws.trendlineScanner.summary.winner.entryPrice, ws.precision)}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted leading-relaxed">
            {ws.trendlineScanner.summary
              ? ws.trendlineScanner.summary.statusBanner
              : 'No trendline scan yet. Open the module and scan for validated trendline rejections, breakouts, retests and liquidity sweeps.'}
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Signal Accuracy"
        subtitle="Verified outcomes only — open setups are excluded so the rate stays honest"
        icon={<ShieldCheck className="w-4 h-4" />}
      >
        <PerformanceStats />
      </SectionCard>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Connection"
          value={
            <span
              className={
                ws.connectionStatus === 'connected' && !ws.feedStale
                  ? 'text-emerald-400'
                  : ws.connectionStatus === 'error'
                    ? 'text-bear'
                    : 'text-warn'
              }
            >
              {ws.connectionStatus === 'connected' && ws.feedStale
                ? 'STALE'
                : ws.connectionStatus.toUpperCase()}
            </span>
          }
          hint="Deriv live feed"
        />
        <StatTile
          label="Candles Loaded"
          value={ws.candles.length}
          hint={ws.isLoadingOlder ? 'Loading older history…' : 'Confirmed + live bar'}
        />
        <StatTile
          label="Analysis Status"
          value={<span className="text-ink text-xs">{ws.runState}</span>}
          hint={ws.report ? `Updated ${formatCandleTime(ws.report.analyzedAt / 1000)}` : 'Not run yet'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          title="Market Activity"
          subtitle="Volatility, regime and momentum as measured on live candles"
          icon={<Gauge className="w-4 h-4" />}
        >
          {ws.report ? (
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile label="Market Regime" value={ws.report.currentStructureSummary} />
              <StatTile label="Setup Quality" value={ws.report.setupQuality} />
              <StatTile
                label="Momentum"
                value={<span className="text-ink text-xs">{ws.report.momentum.state}</span>}
                hint={`Efficiency ${ws.report.momentum.directionalEfficiency}`}
              />
              <StatTile
                label="Confluence"
                value={`${ws.report.confluenceScore}/${ws.report.maxConfluenceScore}`}
                hint="Confirmation factors satisfied"
              />
            </div>
          ) : (
            <p className="text-xs text-muted leading-relaxed">
              Open the Chart Analyser to populate live volatility, regime, momentum and
              confluence readings for {ws.marketName}.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Market Monitor"
          subtitle="Intelligent breadth engine — surfaces the single best setup for co-analysis"
          icon={<Radio className="w-4 h-4" />}
        >
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">Status</span>
              <span className="text-xs font-semibold text-ink">
                {ws.isScanning ? 'Monitoring markets…' : ws.monitorSummary ? 'Last sweep complete' : 'Idle'}
              </span>
            </div>
            {ws.monitorSummary && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">Instruments monitored</span>
                <span className="text-xs font-mono font-semibold text-ink">
                  {ws.monitorSummary.monitoredCount}
                </span>
              </div>
            )}
            <p className="text-[12px] text-muted leading-relaxed">{ws.progressMessage}</p>
            <button
              type="button"
              onClick={() => ws.navigate('scanner')}
              className="w-full mt-1 inline-flex items-center justify-center gap-2 h-9 text-xs font-bold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 transition-colors cursor-pointer"
            >
              <Radio className="w-3.5 h-3.5" aria-hidden="true" />
              OPEN MARKET SCANNER
            </button>
          </div>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          title="AI Training & Backtesting"
          subtitle="Eight entry models trained and tested on real Deriv history"
          icon={<GraduationCap className="w-4 h-4" />}
          right={
            <button
              type="button"
              onClick={() => ws.navigate('training')}
              className="text-[12px] font-semibold text-accent hover:text-accent-soft cursor-pointer"
            >
              Open
            </button>
          }
        >
          {ws.training.result ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2.5">
                <StatTile
                  label="Reports"
                  value={ws.training.result.reports.length}
                  hint="Instrument × model"
                />
                <StatTile
                  label="Real Candles"
                  value={ws.training.result.totalBarsAnalyzed}
                  hint="Replayed chronologically"
                />
              </div>
              <p className="text-[12px] text-muted leading-relaxed">
                Out-of-sample results and per-model rankings are in the training dashboard. Entry
                and stop-loss are locked; the take-profit adapts.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted leading-relaxed">
              No training run yet. Open AI Training to replay the eight entry models over real
              Deriv candles with a no-look-ahead, in-sample / out-of-sample split.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Live Trade Management"
          subtitle="Locked entry & stop-loss · dynamic take-profit"
          icon={<ShieldCheck className="w-4 h-4" />}
        >
          <ManagedSignalsPanel limit={3} />
        </SectionCard>
      </div>

      <SectionCard
        title="Live Signals"
        subtitle="Confirmed setups from both engines — click any card to open its exact chart"
        icon={<Radio className="w-4 h-4" />}
      >
        <SignalFeedList limit={4} />
      </SectionCard>

      <SectionCard
        title="Recent Analyser Setups"
        subtitle="Setups recorded by the Chart Analyser — the only signal source"
        icon={<ScanSearch className="w-4 h-4" />}
        right={
          <button
            type="button"
            onClick={() => ws.navigate('history')}
            className="text-[12px] font-semibold text-accent hover:text-accent-soft cursor-pointer"
          >
            View all
          </button>
        }
      >
        {ws.performanceRecords.length === 0 ? (
          <p className="text-xs text-muted">
            No setups recorded yet. Open the Chart Analyser and confirm a setup to begin building history.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {ws.performanceRecords.slice(0, 5).map((rec) => (
              <li key={rec.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {rec.direction === 'RISE' ? (
                      <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <ArrowDownRight className="w-3.5 h-3.5 text-bear shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-ink truncate">
                      {rec.displayName}
                    </span>
                  </div>
                  <div className="text-[12px] text-muted font-mono">
                    {rec.modelLabel} · {rec.timeframe} ·{' '}
                    <Clock className="inline w-3 h-3 -mt-0.5" />{' '}
                    {formatCandleTime(rec.createdAt / 1000)}
                  </div>
                </div>
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded shrink-0 border ${
                    rec.outcome === 'WIN'
                      ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
                      : rec.outcome === 'LOSS'
                        ? 'bg-red-500/12 text-bear border-red-500/30'
                        : 'bg-panel text-muted border-line'
                  }`}
                >
                  {rec.outcome}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
