import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Brain,
  Clock,
  Gauge,
  Loader2,
  Radio,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Square,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { TIMEFRAMES } from '../config/deriv';
import type { SignalSnapshot } from '../types/analysis';
import type { TimeframeKey } from '../types/market';
import type { EngineScanSummary } from '../types/engine';
import type { InstrumentMonitorReading, MonitorScanSummary } from '../types/scanner';
import { formatCandleTime, formatPrice } from '../utils/derivParser';
import { snapshotFromEngineSignal } from '../utils/signalFeed';
import { isOneSecondSymbol } from '../utils/eligibleMarkets';

interface VolatilityScannerViewProps {
  isScanning: boolean;
  scanProgress: number;
  progressMessage: string;
  monitorSummary: MonitorScanSummary | null;
  scannerSummary: EngineScanSummary | null;
  timeframe: TimeframeKey;
  include1Sec: boolean;
  autoRefresh: boolean;
  lastScannedAt: number | null;
  onTimeframeChange: (tf: TimeframeKey) => void;
  onToggle1Sec: (include: boolean) => void;
  onToggleAutoRefresh: (enabled: boolean) => void;
  onScanNow: () => void;
  onCancelScan: () => void;
  onOpenAnalyser: (
    symbol: string,
    tf: TimeframeKey,
    snapshot?: SignalSnapshot | null
  ) => void;
  onOpenChartOnly: (
    symbol: string,
    tf: TimeframeKey,
    snapshot?: SignalSnapshot | null
  ) => void;
}

const ACTIVITY_STYLE: Record<
  InstrumentMonitorReading['activityLabel'],
  string
> = {
  Active: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  Quiet: 'bg-panel text-muted border-line',
  Stale: 'bg-amber-500/12 text-warn border-amber-500/30',
  Closed: 'bg-panel text-faint border-line',
  Unavailable: 'bg-red-500/12 text-bear border-red-500/30',
};

function ToggleChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center h-8 px-2.5 rounded-md border text-xs font-semibold transition-colors cursor-pointer ${
        active
          ? 'bg-accent/12 text-accent border-accent/30'
          : 'bg-elevated text-muted border-line hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}

export function VolatilityScannerView({
  isScanning,
  scanProgress,
  progressMessage,
  monitorSummary,
  scannerSummary,
  timeframe,
  include1Sec,
  autoRefresh,
  lastScannedAt,
  onTimeframeChange,
  onToggle1Sec,
  onToggleAutoRefresh,
  onScanNow,
  onCancelScan,
  onOpenAnalyser,
  onOpenChartOnly,
}: VolatilityScannerViewProps) {
  const [familyFilter, setFamilyFilter] = useState<'ALL' | 'STANDARD' | 'ONE_SECOND'>('ALL');

  const readings = useMemo(() => {
    const list = monitorSummary?.readings ?? [];
    if (familyFilter === 'ALL') return list;
    return list.filter((r) =>
      familyFilter === 'ONE_SECOND' ? isOneSecondSymbol(r.symbol) : !isOneSecondSymbol(r.symbol)
    );
  }, [monitorSummary, familyFilter]);

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-3 bg-surface border border-line rounded-xl p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="inline-flex items-center gap-2 text-base font-extrabold tracking-tight text-ink">
              <Radio className="w-4 h-4 text-accent" aria-hidden="true" />
              Market Scanner
            </h1>
            <p className="text-xs text-muted mt-0.5">
              Intelligent breadth engine. It monitors every index, surfaces its single best
              setup, and hands off to the Chart Analyser for dual-engine co-analysis and
              shared validation.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isScanning ? (
              <button
                type="button"
                onClick={onCancelScan}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 transition-colors cursor-pointer"
              >
                <Square className="w-3 h-3 fill-current" aria-hidden="true" />
                STOP
              </button>
            ) : (
              <button
                type="button"
                data-testid="scanner-scan-btn"
                onClick={onScanNow}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                MONITOR MARKETS
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex items-center gap-0.5 p-0.5 bg-elevated border border-line rounded-lg"
            role="group"
            aria-label="Scanner timeframe"
          >
            {TIMEFRAMES.map((tf) => {
              const active = tf.key === timeframe;
              return (
                <button
                  key={tf.key}
                  type="button"
                  onClick={() => onTimeframeChange(tf.key)}
                  aria-pressed={active}
                  className={`min-h-[30px] min-w-[36px] px-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    active ? 'bg-accent text-app' : 'text-muted hover:text-ink hover:bg-panel'
                  }`}
                >
                  {tf.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            <ToggleChip
              label="All eligible markets"
              active
              onClick={() => {}}
            />
            <ToggleChip
              label="1s variants"
              active={include1Sec}
              onClick={() => onToggle1Sec(!include1Sec)}
            />
            <ToggleChip
              label="Auto refresh"
              active={autoRefresh}
              onClick={() => onToggleAutoRefresh(!autoRefresh)}
            />
          </div>

          <span className="text-[11px] text-faint ml-auto">
            Structure-validated analysis
            {lastScannedAt ? ` · updated ${formatCandleTime(lastScannedAt / 1000)}` : ''}
          </span>
        </div>

        {isScanning && (
          <div className="space-y-1.5">
            <div className="h-1 rounded-full bg-line overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted">
              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
              {progressMessage}
            </div>
          </div>
        )}
        {!isScanning && (
          <p className="text-[11px] text-muted">{progressMessage}</p>
        )}
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            Monitored
          </div>
          <div className="text-lg font-bold font-mono text-ink">
            {monitorSummary?.monitoredCount ?? 0}
          </div>
        </div>
        <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            Active movement
          </div>
          <div className="text-lg font-bold font-mono text-emerald-400">
            {monitorSummary?.activeCount ?? 0}
          </div>
        </div>
        <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            Stale / unavailable
          </div>
          <div className="text-lg font-bold font-mono text-warn">
            {monitorSummary?.staleCount ?? 0}
          </div>
        </div>
        <div className="bg-surface border border-line rounded-xl px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            Timeframe
          </div>
          <div className="text-lg font-bold font-mono text-ink">{timeframe}</div>
        </div>
      </div>

      {/* Scanner's single best setup — the breadth engine's own conclusion */}
      {scannerSummary && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-line-soft">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-accent" aria-hidden="true" />
              <h3 className="text-[13px] font-bold text-ink">Scanner best setup</h3>
              <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-line bg-panel text-faint">
                Breadth engine
              </span>
            </div>
            <span className="text-[11px] text-faint">
              {scannerSummary.scannedCount} analysed · {scannerSummary.confirmedCount} confirmed ·{' '}
              {scannerSummary.developingCount} developing
            </span>
          </div>

          {scannerSummary.winner ? (
            (() => {
              const w = scannerSummary.winner;
              const isRise = w.direction === 'RISE';
              const dirStyle = isRise
                ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
                : 'bg-red-500/12 text-bear border-red-500/30';
              return (
                <div className="p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border ${dirStyle}`}>
                        {isRise ? (
                          <TrendingUp className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <TrendingDown className="w-4 h-4" aria-hidden="true" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink truncate">{w.displayName}</span>
                          <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${dirStyle}`}>
                            {w.direction}
                          </span>
                          <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-line bg-panel text-faint">
                            {w.state.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted font-mono">
                          {w.symbol} · {w.modelLabel} · {w.condition.replace(/_/g, ' ')}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        onOpenAnalyser(
                          w.symbol,
                          w.analysisTimeframe,
                          snapshotFromEngineSignal(w)
                        )
                      }
                      data-testid="scanner-coanalyse-btn"
                      className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer"
                    >
                      <ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />
                      CO-ANALYSE IN CHART ANALYSER
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {[
                      { label: 'Entry', value: w.entryPrice },
                      { label: 'Invalidation', value: w.invalidationPrice },
                      { label: 'Target 1', value: w.target1 },
                      { label: 'Quality', value: null as number | null },
                    ].map((cell) => (
                      <div key={cell.label} className="bg-panel border border-line-soft rounded-lg px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
                          {cell.label}
                        </div>
                        <div className="text-sm font-bold font-mono text-ink tabular-nums">
                          {cell.label === 'Quality'
                            ? `${w.quality.total}/100`
                            : cell.value !== null && cell.value !== undefined
                              ? formatPrice(cell.value, w.precision)
                              : '—'}
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="text-[11px] text-muted leading-relaxed">
                    {w.reasons[0] ?? w.confirmationExplanation}
                  </p>

                  {(() => {
                    const intel = scannerSummary.winnerAnalysis?.intelligence ?? null;
                    if (!intel) return null;
                    const topObjective = intel.report.liquidityObjectives.find((p) => !p.swept) ?? null;
                    return (
                      <div
                        data-testid="scanner-intelligence"
                        className="rounded-lg border border-line-soft bg-panel px-3 py-2.5 space-y-1"
                      >
                        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-faint">
                          <Brain className="w-3 h-3 text-accent" aria-hidden="true" />
                          Market intelligence · {intel.timeframe}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide">
                          <span
                            className={
                              intel.bias === 'bullish'
                                ? 'text-emerald-400'
                                : intel.bias === 'bearish'
                                  ? 'text-bear'
                                  : 'text-muted'
                            }
                          >
                            {intel.bias} bias
                          </span>
                          <span className="text-faint">·</span>
                          <span className="text-muted">{intel.condition}</span>
                        </div>
                        <p className="text-[11px] text-muted leading-snug">
                          {intel.conditionExplanation}
                        </p>
                        {topObjective && (
                          <div className="text-[10px] font-mono text-faint">
                            Next liquidity objective:{' '}
                            <span className="text-ink">
                              {formatPrice(topObjective.price, w.precision)}
                            </span>{' '}
                            ({topObjective.side === 'above' ? 'buy-side' : 'sell-side'},{' '}
                            {topObjective.distanceAtr.toFixed(1)}× ATR)
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {(() => {
                    const analysis = scannerSummary.winnerAnalysis;
                    const reach = analysis?.reachability ?? null;
                    const falseSignal = analysis?.falseSignal ?? null;
                    if (!reach && !falseSignal) return null;
                    return (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {reach && (
                          <div
                            data-testid="scanner-reachability"
                            className={`rounded-lg border px-3 py-2 ${
                              reach.tp1Reachable
                                ? 'border-emerald-500/25 bg-emerald-500/6'
                                : 'border-amber-500/30 bg-amber-500/8'
                            }`}
                          >
                            <div className="text-[10px] font-bold uppercase tracking-wide text-faint">
                              Target reachability
                            </div>
                            <div
                              className={`text-[11px] font-bold uppercase ${
                                reach.tp1Reachable ? 'text-emerald-400' : 'text-warn'
                              }`}
                            >
                              TP1 {reach.tp1Reachable ? 'reachable' : 'not reachable'}
                            </div>
                            <div className="text-[10px] font-mono text-faint">
                              {reach.roomToTp1Atr.toFixed(1)}× ATR room · needs{' '}
                              {reach.requiredRoomAtr.toFixed(1)}×
                            </div>
                          </div>
                        )}
                        {falseSignal && (
                          <div
                            data-testid="scanner-false-signal"
                            className={`rounded-lg border px-3 py-2 ${
                              falseSignal.flagged
                                ? 'border-red-500/30 bg-red-500/8'
                                : 'border-emerald-500/25 bg-emerald-500/6'
                            }`}
                          >
                            <div className="text-[10px] font-bold uppercase tracking-wide text-faint">
                              False-signal guard
                            </div>
                            <div
                              className={`text-[11px] font-bold uppercase ${
                                falseSignal.flagged ? 'text-bear' : 'text-emerald-400'
                              }`}
                            >
                              {falseSignal.flagged
                                ? `${falseSignal.traps.length} trap(s) flagged`
                                : 'Clean'}
                            </div>
                            <div className="text-[10px] text-muted leading-snug line-clamp-2">
                              {falseSignal.traps[0] ?? 'No trap patterns detected.'}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {(() => {
                    const structure = scannerSummary.winnerAnalysis?.structure ?? null;
                    const zones = (structure?.watchZones ?? [])
                      .slice()
                      .sort((a, b) => a.distanceAtr - b.distanceAtr)
                      .slice(0, 3);
                    if (zones.length === 0) return null;
                    return (
                      <div className="rounded-lg border border-line-soft bg-panel px-3 py-2.5 space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-faint">
                          <Sparkles className="w-3 h-3 text-accent" aria-hidden="true" />
                          Future reaction zones
                        </div>
                        {zones.map((zone) => (
                          <div
                            key={zone.id}
                            className="flex items-center gap-2 text-[11px]"
                            data-testid="scanner-structure-zone"
                          >
                            <span
                              className={`font-bold ${
                                zone.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'
                              }`}
                            >
                              WATCH {zone.direction}
                            </span>
                            <span className="font-mono tabular-nums text-muted">
                              {formatPrice(zone.lowerPrice, w.precision)}–
                              {formatPrice(zone.upperPrice, w.precision)}
                            </span>
                            <span className="ml-auto text-faint uppercase tracking-wide text-[10px]">
                              {zone.stage.replace(/_/g, ' ')}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              );
            })()
          ) : (
            <div className="px-4 py-6 text-center">
              <div className="text-sm font-bold text-warn uppercase tracking-wide">
                No high-quality setup — waiting for confirmation
              </div>
              <p className="text-xs text-muted mt-1 max-w-md mx-auto">
                {scannerSummary.statusBanner}{' '}
                {scannerSummary.topRejectionReasons[0] ?? 'Re-scan when activity changes.'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Instrument table */}
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-line-soft">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-accent" aria-hidden="true" />
            <h3 className="text-[13px] font-bold text-ink">Live instrument monitor</h3>
          </div>
          <div className="flex items-center gap-1.5">
            <ToggleChip
              label="All"
              active={familyFilter === 'ALL'}
              onClick={() => setFamilyFilter('ALL')}
            />
            <ToggleChip
              label="Volatility"
              active={familyFilter === 'STANDARD'}
              onClick={() => setFamilyFilter('STANDARD')}
            />
            <ToggleChip
              label="1-second"
              active={familyFilter === 'ONE_SECOND'}
              onClick={() => setFamilyFilter('ONE_SECOND')}
            />
          </div>
        </div>

        {readings.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-3 py-14 px-6">
            <div className="p-3.5 rounded-full bg-panel text-accent border border-line">
              <Activity className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="max-w-md space-y-1">
              <h3 className="text-base font-bold text-ink">No monitor data yet</h3>
              <p className="text-xs text-muted leading-relaxed">
                Press MONITOR MARKETS to read live prices and activity across every eligible
                Volatility Index (standard + 1-second). Then pick one to analyse in the Chart Analyser.
              </p>
            </div>
            <button
              type="button"
              onClick={onScanNow}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              MONITOR MARKETS
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs min-w-[760px]">
              <thead className="bg-panel text-faint font-semibold text-[10px] uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2.5">Instrument</th>
                  <th className="px-3 py-2.5 text-right">Price</th>
                  <th className="px-3 py-2.5 text-right">Last bar</th>
                  <th className="px-3 py-2.5 text-right">Range %</th>
                  <th className="px-3 py-2.5">Activity</th>
                  <th className="px-3 py-2.5">Data</th>
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {readings.map((r) => (
                  <tr key={r.symbol} className="hover:bg-elevated/40 transition-colors">
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-ink truncate max-w-[200px]">
                        {r.displayName}
                      </div>
                      <div className="text-[10px] font-mono text-faint">{r.symbol}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">
                      {r.price > 0 ? formatPrice(r.price, r.precision) : '—'}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                        r.lastCandleChangePercent === null
                          ? 'text-faint'
                          : r.lastCandleChangePercent >= 0
                            ? 'text-emerald-400'
                            : 'text-bear'
                      }`}
                    >
                      {r.lastCandleChangePercent === null
                        ? '—'
                        : `${r.lastCandleChangePercent >= 0 ? '+' : ''}${r.lastCandleChangePercent.toFixed(3)}%`}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted">
                      {r.volatilityPercent === null ? '—' : `${r.volatilityPercent.toFixed(2)}%`}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide ${ACTIVITY_STYLE[r.activityLabel]}`}
                      >
                        {r.activityLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted">
                        <Clock className="w-3 h-3" aria-hidden="true" />
                        {r.candlesCount} bars
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenAnalyser(r.symbol, timeframe)}
                          data-testid={`scanner-open-analyser-${r.symbol}`}
                          className="inline-flex items-center gap-1 h-7 px-2 text-[11px] font-bold text-accent bg-accent/12 border border-accent/30 rounded-md hover:bg-accent/20 transition-colors cursor-pointer"
                        >
                          <ScanSearch className="w-3 h-3" aria-hidden="true" />
                          Analyse
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenChartOnly(r.symbol, timeframe)}
                          className="inline-flex items-center gap-1 h-7 px-2 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 transition-colors cursor-pointer"
                        >
                          Chart
                          <ArrowRight className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
