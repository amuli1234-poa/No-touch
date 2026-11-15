import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Clock,
  Crosshair,
  Gauge,
  Layers,
  LineChart,
  Loader2,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Square,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { TIMEFRAMES } from '../config/deriv';
import { useWorkspace } from '../context/WorkspaceContext';
import type { TrendlineScannerValue } from '../hooks/useTrendlineScanner';
import type { TimeframeKey } from '../types/market';
import type {
  TrendlineAlignment,
  TrendlineEntryModelId,
  TrendlineInstrumentAnalysis,
  TrendlineSetupZone,
  TrendlineSignal,
} from '../types/trendline';
import {
  TRENDLINE_MODEL_IDS,
  TRENDLINE_MODEL_LABELS,
  TRENDLINE_MODEL_SHORT,
  TRENDLINE_SETUP_TYPE,
  TRENDLINE_STATUS_LABELS,
} from '../types/trendline';
import { formatPrice } from '../utils/derivParser';
import { ModuleChartSlot } from './chart/ModuleChartSlot';
import type { TrendlineChartOverlay } from './chart/TrendlineChartPrimitive';
import { Card, MeterBar, SectionCard, StatTile, StatusPill } from './ui/primitives';

interface TrendlineScannerViewProps {
  scanner: TrendlineScannerValue;
}

const CONDITION_STYLE: Record<TrendlineInstrumentAnalysis['condition'], string> = {
  UPTREND: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  DOWNTREND: 'bg-red-500/12 text-bear border-red-500/30',
  SIDEWAYS: 'bg-amber-500/12 text-warn border-amber-500/30',
  RANGE_EXTREME: 'bg-violet-500/12 text-violet-300 border-violet-500/30',
  CHOPPY: 'bg-panel text-muted border-line',
};

const MODEL_ICON: Record<TrendlineEntryModelId, typeof TrendingUp> = {
  TRENDLINE_REJECTION: TrendingUp,
  TRENDLINE_BREAKOUT: ArrowUpRight,
  TRENDLINE_BREAKOUT_RETEST: RefreshCw,
  TRENDLINE_LIQUIDITY_SWEEP_RECLAIM: Crosshair,
};

function scoreColor(score: number): string {
  if (score >= 92) return 'text-emerald-400';
  if (score >= 85) return 'text-accent';
  if (score >= 70) return 'text-warn';
  return 'text-muted';
}

function SignalCard({
  signal,
  precision,
  onFocus,
}: {
  signal: TrendlineSignal;
  precision: number;
  onFocus?: () => void;
}) {
  const isRise = signal.direction === 'RISE';
  return (
    <div
      className={`rounded-lg border p-3 ${
        isRise ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-red-500/40 bg-red-500/[0.06]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isRise ? (
            <TrendingUp className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          ) : (
            <TrendingDown className="w-4 h-4 text-bear shrink-0" aria-hidden="true" />
          )}
          <span
            className={`text-sm font-extrabold tracking-tight ${isRise ? 'text-emerald-400' : 'text-bear'}`}
          >
            {signal.direction}
          </span>
          <span className="text-[11px] text-muted truncate">{signal.displayName}</span>
        </div>
        <span className={`text-sm font-bold font-mono ${scoreColor(signal.score)}`}>
          {signal.score}/100
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusPill
          label={TRENDLINE_SETUP_TYPE[signal.model]}
          className="bg-elevated text-muted border-line"
        />
        <StatusPill
          label={TRENDLINE_STATUS_LABELS[signal.status]}
          className={
            signal.status === 'INVALIDATED'
              ? 'bg-red-500/12 text-bear border-red-500/30'
              : signal.status === 'COMPLETED'
                ? 'bg-elevated text-muted border-line'
                : 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
          }
        />
        <StatusPill label={signal.condition.replace(/_/g, ' ')} className={CONDITION_STYLE[signal.condition]} />
        <StatusPill
          label={`R:R ${signal.riskRewardRatio.toFixed(2)}`}
          className="bg-elevated text-muted border-line"
        />
        <StatusPill
          label={`${signal.structureTimeframe}→${signal.entryTimeframe}`}
          className="bg-elevated text-muted border-line"
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTile label="Entry" value={formatPrice(signal.entryPrice, precision)} />
        <StatTile label="Stop" value={formatPrice(signal.stopLoss, precision)} valueClass="text-bear" />
        <StatTile
          label="Target"
          value={formatPrice(signal.takeProfit, precision)}
          valueClass="text-emerald-400"
        />
      </div>

      <div className="mt-2 text-[10px] text-faint leading-snug">
        <span className="text-accent font-semibold">M1 entry:</span> {signal.m1Confirmation}
      </div>

      <div className="mt-3 space-y-1">
        {signal.reasons.slice(0, 3).map((r, i) => (
          <div key={i} className="text-[11px] text-muted leading-snug flex gap-1.5">
            <span className="text-accent shrink-0">•</span>
            <span>{r}</span>
          </div>
        ))}
      </div>

      {onFocus && (
        <button
          type="button"
          onClick={onFocus}
          className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer"
        >
          <LineChart className="w-3.5 h-3.5" aria-hidden="true" />
          View on chart
        </button>
      )}
    </div>
  );
}

function AnalysisRow({
  analysis,
  precision,
  active,
  onSelect,
}: {
  analysis: TrendlineInstrumentAnalysis;
  precision: number;
  active: boolean;
  onSelect: () => void;
}) {
  const signal = analysis.signal;
  const candidate = analysis.bestCandidate;
  const direction = signal?.direction ?? candidate?.direction ?? null;
  const setupType = candidate ? TRENDLINE_SETUP_TYPE[candidate.model] : null;
  const statusLabel = signal ? TRENDLINE_STATUS_LABELS[signal.status] : 'WAITING';
  const statusTone =
    statusLabel === 'INVALIDATED'
      ? 'bg-red-500/12 text-bear border-red-500/30'
      : statusLabel === 'CONFIRMED'
        ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
        : 'bg-amber-500/12 text-warn border-amber-500/30';
  const score = signal?.score ?? candidate?.scores.total ?? null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
        active ? 'border-accent/60 bg-accent/[0.06]' : 'border-line bg-panel hover:border-accent/40'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink truncate">{analysis.displayName}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {direction && (
            <span
              className={`text-[11px] font-bold ${direction === 'RISE' ? 'text-emerald-400' : 'text-bear'}`}
            >
              {direction}
            </span>
          )}
          <span className={`text-[11px] font-bold font-mono ${score !== null ? scoreColor(score) : 'text-faint'}`}>
            {score !== null ? `${score}/100` : '—'}
          </span>
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${statusTone}`}>
          {statusLabel}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${CONDITION_STYLE[analysis.condition]}`}>
          {analysis.condition.replace(/_/g, ' ')}
        </span>
        {setupType && <span className="text-[10px] text-muted truncate">{setupType}</span>}
      </div>

      {candidate && (
        <div className="mt-1.5 grid grid-cols-3 gap-1.5 text-[10px] font-mono">
          <span className="text-faint">
            Entry <span className="text-ink">{formatPrice(candidate.entryPrice, precision)}</span>
          </span>
          <span className="text-faint">
            SL <span className="text-bear">{formatPrice(candidate.stopLoss, precision)}</span>
          </span>
          <span className="text-faint">
            TP <span className="text-emerald-400">{formatPrice(candidate.takeProfit, precision)}</span>
          </span>
        </div>
      )}

      {!candidate && (
        <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-faint">
          <span className="font-mono">{formatPrice(analysis.price, precision)}</span>
          <span>
            {analysis.trendlines.filter((l) => l.valid).length} valid line
            {analysis.trendlines.filter((l) => l.valid).length === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </button>
  );
}

function AlignmentBanner({ alignment }: { alignment: TrendlineAlignment }) {
  const wait = alignment.tradableDirection === null;
  const tone = wait
    ? 'border-amber-500/40 bg-amber-500/[0.06] text-warn'
    : alignment.tradableDirection === 'RISE'
      ? 'border-blue-500/40 bg-blue-500/[0.06] text-blue-400'
      : 'border-red-500/40 bg-red-500/[0.06] text-bear';
  const headline = wait
    ? 'WAIT — no dominant trend'
    : `Trend-aligned: ${alignment.tradableDirection} continuations only`;
  return (
    <Card className={`px-4 py-3 border ${tone}`}>
      <div className="flex items-start gap-2.5">
        <Crosshair className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-extrabold uppercase tracking-wide">{headline}</span>
            <StatusPill
              label={`${alignment.dominantTrend} · ${alignment.structureLabel}`}
              className="bg-elevated text-muted border-line"
            />
            {alignment.trendConfirmed && (
              <StatusPill
                label="trend confirmed"
                className="bg-emerald-500/12 text-emerald-400 border-emerald-500/30"
              />
            )}
            {alignment.reversalConfirmed && (
              <StatusPill
                label="reversal confirmed"
                className="bg-violet-500/12 text-violet-300 border-violet-500/30"
              />
            )}
          </div>
          <p className="text-[11px] text-muted leading-snug mt-1.5">{alignment.reason}</p>
          {alignment.continuationBos && (
            <p className="text-[11px] text-emerald-400 leading-snug mt-1">
              Continuation BOS: {alignment.continuationBos}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function SetupZoneRow({ zone, precision }: { zone: TrendlineSetupZone; precision: number }) {
  const isRise = zone.direction === 'RISE';
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isRise ? 'border-blue-500/40 bg-blue-500/[0.05]' : 'border-red-500/40 bg-red-500/[0.05]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-bold ${isRise ? 'text-blue-400' : 'text-bear'}`}>
          {isRise ? 'WATCH RISE' : 'WATCH FALL'} · {zone.label}
        </span>
        <span className="text-[10px] font-mono text-faint">
          {zone.distanceAtr.toFixed(1)}× ATR
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-faint">
        <span className="font-mono">
          {formatPrice(zone.lowerPrice, precision)} – {formatPrice(zone.upperPrice, precision)}
        </span>
        <span>·</span>
        <span
          className={
            zone.freshness === 'FRESH'
              ? 'text-emerald-400'
              : zone.freshness === 'TESTED'
                ? 'text-warn'
                : 'text-faint'
          }
        >
          {zone.freshness}
        </span>
        <span>·</span>
        <span className="capitalize">{zone.source.replace(/-/g, ' ')}</span>
      </div>
      <p className="text-[11px] text-muted leading-snug mt-1">{zone.reason}</p>
    </div>
  );
}

export function TrendlineScannerView({ scanner }: TrendlineScannerViewProps) {
  const ws = useWorkspace();
  const [focused, setFocused] = useState<TrendlineInstrumentAnalysis | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const precision = ws.precision;
  const winner = scanner.summary?.winner ?? null;

  // Live trendline read for the chart's currently selected instrument.
  const [liveAnalysis, setLiveAnalysis] = useState<TrendlineInstrumentAnalysis | null>(null);
  useEffect(() => {
    let cancelled = false;
    void scanner.analyzeLive(ws.selectedSymbol).then((analysis) => {
      if (!cancelled) setLiveAnalysis(analysis);
    });
    return () => {
      cancelled = true;
    };
  }, [scanner.analyzeLive, ws.selectedSymbol, ws.dataset.datasetId, scanner.summary]);

  const chartAnalysis = focused ?? liveAnalysis;
  const trendlineOverlay = useMemo<TrendlineChartOverlay | null>(() => {
    if (!chartAnalysis) return null;
    return {
      setupZones: chartAnalysis.setupZones,
      alignment: chartAnalysis.alignment,
      signal: chartAnalysis.signal ?? null,
      precision,
    };
  }, [chartAnalysis, precision]);

  const focusAnalysis = useCallback(
    (analysis: TrendlineInstrumentAnalysis) => {
      setFocused(analysis);
      ws.selectMarket(analysis.symbol);
      ws.selectTimeframe(scanner.settings.chartTimeframe);
    },
    [ws, scanner.settings.chartTimeframe]
  );

  const focusSignal = useCallback(
    (signal: TrendlineSignal) => {
      const found =
        scanner.analyses.find((a) => a.symbol === signal.symbol) ??
        scanner.summary?.winnerAnalysis ??
        null;
      if (found) focusAnalysis(found);
      else {
        ws.selectMarket(signal.symbol);
        ws.selectTimeframe(scanner.settings.chartTimeframe);
      }
    },
    [scanner.analyses, scanner.summary, focusAnalysis, ws, scanner.settings.chartTimeframe]
  );

  const validLines = chartAnalysis?.trendlines.filter((l) => l.valid) ?? [];
  const brokenLines = chartAnalysis?.trendlines.filter((l) => l.broken) ?? [];
  const dark = ws.settings.theme === 'dark';

  return (
    <div className="flex flex-col gap-3 p-3 @sm:p-5 max-w-[1400px] w-full mx-auto">
      {/* Header */}
      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="p-2 rounded-lg bg-accent/12 text-accent border border-accent/25">
            <TrendingUp className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-extrabold tracking-tight text-ink">Trendline AI</h1>
            <p className="text-xs text-faint">
              Complete multi-market trendline intelligence — M15 structure, M5 rejection setup, M1
              precise entry. Four models, mandatory confirmation, minimum 85/100 quality. Every
              Volatility Index scanned independently (Boom &amp; Crash excluded).
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-pressed={showSettings}
            className={`inline-flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-md border transition-colors cursor-pointer ${
              showSettings
                ? 'bg-accent/12 text-accent border-accent/40'
                : 'bg-elevated text-muted border-line hover:text-ink'
            }`}
          >
            <Layers className="w-3.5 h-3.5" aria-hidden="true" />
            Models &amp; Settings
          </button>
          {scanner.isScanning ? (
            <button
              type="button"
              onClick={scanner.cancelScan}
              className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-semibold text-app bg-bear rounded-md hover:opacity-90 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void scanner.scanMarkets()}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-semibold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer"
            >
              <ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />
              Scan trendlines
            </button>
          )}
        </div>
      </Card>

      {/* Status banner */}
      <Card
        className={`px-4 py-3 flex items-center gap-3 ${
          winner ? 'border-emerald-500/40' : 'border-line'
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            scanner.isScanning
              ? 'bg-accent animate-pulse'
              : winner
                ? 'bg-emerald-400'
                : 'bg-faint'
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-ink truncate">
            {scanner.progressMessage}
          </div>
          <div className="text-[10px] text-faint">
            {scanner.targetMarketCount} markets · M15 structure → M5 entries
            {scanner.lastScannedAt
              ? ` · last scan ${new Date(scanner.lastScannedAt).toLocaleTimeString()}`
              : ''}
          </div>
        </div>
        {scanner.isScanning && (
          <span className="text-[11px] font-mono text-accent shrink-0">
            {scanner.scanProgress}%
          </span>
        )}
      </Card>

      {scanner.isScanning && <MeterBar value={scanner.scanProgress} />}

      {/* Trend alignment — dominant direction gate (WAIT when unclear) */}
      {chartAnalysis && <AlignmentBanner alignment={chartAnalysis.alignment} />}

      {/* Settings panel */}
      {showSettings && (
        <SectionCard
          title="Trendline Models & Filters"
          subtitle="Enable entry models, set the score gate and restrict direction"
        >
          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-2">
            {TRENDLINE_MODEL_IDS.map((id) => {
              const Icon = MODEL_ICON[id];
              const enabled = scanner.settings.enabledModels[id];
              return (
                <label
                  key={id}
                  className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                    enabled ? 'border-accent/40 bg-accent/[0.05]' : 'border-line bg-panel'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => scanner.toggleModel(id)}
                    className="mt-0.5 accent-[var(--color-accent)]"
                    aria-label={TRENDLINE_MODEL_LABELS[id]}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-ink">
                      <Icon className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
                      {TRENDLINE_MODEL_LABELS[id]}
                    </span>
                    <span className="block text-[10px] text-faint leading-snug mt-0.5">
                      {id === 'TRENDLINE_REJECTION'
                        ? 'Rejection at a validated trendline (touch + close back).'
                        : id === 'TRENDLINE_BREAKOUT'
                          ? 'Decisive break of a trendline with confirming rejection.'
                          : id === 'TRENDLINE_BREAKOUT_RETEST'
                            ? 'Broken trendline retested from the other side and held.'
                            : 'Liquidity sweep of a swing extreme followed by reclaim.'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div>
              <div className="text-[11px] font-semibold text-ink mb-1.5">
                Minimum score gate: <span className="font-mono text-accent">{scanner.settings.minScore}</span>
              </div>
              <input
                type="range"
                min={60}
                max={100}
                step={1}
                value={scanner.settings.minScore}
                onChange={(e) => scanner.setMinScore(Number(e.target.value))}
                aria-label="Minimum trendline score"
                className="w-52 accent-[var(--color-accent)] cursor-pointer"
              />
            </div>

            <div>
              <div className="text-[11px] font-semibold text-ink mb-1.5">Direction</div>
              <div className="inline-flex items-center gap-0.5 p-0.5 bg-elevated rounded-lg border border-line">
                {(['RISE', 'FALL', 'BOTH'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => scanner.setDirectionPreference(d)}
                    aria-pressed={scanner.settings.directionPreference === d}
                    className={`h-7 px-3 text-[11px] font-bold rounded-md capitalize transition-colors cursor-pointer ${
                      scanner.settings.directionPreference === d
                        ? 'bg-accent text-app'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    {d.toLowerCase()}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-ink mb-1.5">Chart timeframe</div>
              <div className="inline-flex items-center gap-0.5 p-0.5 bg-elevated rounded-lg border border-line">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf.key}
                    type="button"
                    onClick={() => scanner.setChartTimeframe(tf.key)}
                    aria-pressed={scanner.settings.chartTimeframe === tf.key}
                    className={`h-7 px-2.5 text-[11px] font-bold rounded-md transition-colors cursor-pointer ${
                      scanner.settings.chartTimeframe === tf.key
                        ? 'bg-accent text-app'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => scanner.setInclude1Sec(!scanner.settings.include1Sec)}
              aria-pressed={scanner.settings.include1Sec}
              className={`h-8 px-3 text-[11px] font-semibold rounded-md border transition-colors cursor-pointer ${
                scanner.settings.include1Sec
                  ? 'bg-accent/12 text-accent border-accent/40'
                  : 'bg-elevated text-muted border-line hover:text-ink'
              }`}
            >
              1-second indices: {scanner.settings.include1Sec ? 'included' : 'excluded'}
            </button>
            <button
              type="button"
              onClick={() => scanner.setAllModels(true)}
              className="h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer"
            >
              Enable all models
            </button>
            <button
              type="button"
              onClick={() => scanner.setAllModels(false)}
              className="h-8 px-3 text-[11px] font-semibold text-muted bg-elevated border border-line rounded-md hover:text-ink cursor-pointer"
            >
              Disable all
            </button>
            <button
              type="button"
              onClick={scanner.resetSettings}
              className="h-8 px-3 text-[11px] font-semibold text-muted bg-elevated border border-line rounded-md hover:text-ink cursor-pointer"
            >
              Reset module
            </button>
          </div>
        </SectionCard>
      )}

      {/* Main grid: chart + structure / scanner results */}
      <div className="grid grid-cols-1 @3xl:grid-cols-[1.6fr_1fr] gap-3">
        {/* Chart column */}
        <div className="flex flex-col gap-3 min-w-0">
          <ModuleChartSlot trendlineOverlay={trendlineOverlay} />

          {/* Trend-aligned future setup zones */}
          <SectionCard
            title="Trend-Aligned Setup Zones"
            subtitle="Where price must pull back (blue) or retrace (red) for a continuation rejection"
            icon={<Crosshair className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {!chartAnalysis ? (
              <div className="text-[11px] text-faint py-4 text-center">
                Awaiting trendline analysis for this instrument…
              </div>
            ) : chartAnalysis.alignment.tradableDirection === null ? (
              <div className="text-[11px] text-warn py-4 text-center leading-snug">
                WAIT — no dominant trend to align with. Zones appear once M15 structure confirms
                an uptrend (RISE zones below price) or a downtrend (FALL zones above price).
              </div>
            ) : chartAnalysis.setupZones.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center leading-snug">
                No valid trend-side zone within reach — the nearest support / demand / trendline
                is too far from price to watch yet.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {chartAnalysis.setupZones.map((zone) => (
                  <SetupZoneRow key={zone.id} zone={zone} precision={chartAnalysis.precision} />
                ))}
              </div>
            )}
          </SectionCard>

          {/* Trendline structure panel */}
          <SectionCard
            title="Detected Trendline Structure"
            subtitle="Validated M15 trendlines for the charted instrument"
            icon={<Activity className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {!chartAnalysis ? (
              <div className="text-[11px] text-faint py-4 text-center">
                Awaiting trendline analysis for this instrument…
              </div>
            ) : validLines.length === 0 && brokenLines.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center">
                No validated trendlines on the current M15 structure.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {[...validLines, ...brokenLines].map((line) => (
                  <div key={line.id} className="rounded-lg border border-line bg-panel px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-ink capitalize">
                        {line.broken ? 'Broken' : line.trend} {line.kind}
                      </span>
                      <span className="text-[10px] font-mono text-faint">
                        {line.touches} touch{line.touches === 1 ? '' : 'es'}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted leading-snug mt-1">{line.reason}</div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* Right column: best signal + results + history */}
        <div className="flex flex-col gap-3 min-w-0">
          <SectionCard
            title="Best Trendline Signal"
            subtitle="Strongest confirmed setup across the scanned markets"
            icon={<Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {winner ? (
              <SignalCard
                signal={winner}
                precision={precision}
                onFocus={() => focusSignal(winner)}
              />
            ) : (
              <div className="text-center py-6">
                <Gauge className="w-7 h-7 text-faint mx-auto mb-2" aria-hidden="true" />
                <div className="text-xs font-semibold text-ink">No qualifying trendline setup</div>
                <p className="text-[11px] text-faint mt-1 max-w-xs mx-auto leading-snug">
                  {scanner.summary
                    ? scanner.summary.statusBanner
                    : 'Run a trendline scan to search all enabled markets.'}
                </p>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Scanned Markets"
            subtitle={`${scanner.analyses.length} instrument${scanner.analyses.length === 1 ? '' : 's'} analysed${
              scanner.summary ? ` · ${scanner.summary.confirmedCount} confirmed` : ''
            }`}
            icon={<ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {scanner.analyses.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center">
                No scan results yet.
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-0.5">
                {[...scanner.analyses]
                  .sort((a, b) => (b.signal?.score ?? b.bestCandidate?.scores.total ?? 0) - (a.signal?.score ?? a.bestCandidate?.scores.total ?? 0))
                  .map((a) => (
                    <AnalysisRow
                      key={a.symbol}
                      analysis={a}
                      precision={a.precision}
                      active={chartAnalysis?.symbol === a.symbol}
                      onSelect={() => focusAnalysis(a)}
                    />
                  ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Trendline Signal History"
            subtitle={`${scanner.history.length} recorded opportunit${scanner.history.length === 1 ? 'y' : 'ies'}`}
            icon={<Clock className="w-3.5 h-3.5" aria-hidden="true" />}
            right={
              scanner.history.length > 0 ? (
                <button
                  type="button"
                  onClick={scanner.clearHistory}
                  className="text-[11px] font-semibold text-muted hover:text-ink cursor-pointer"
                >
                  Clear
                </button>
              ) : undefined
            }
          >
            {scanner.history.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center">
                Confirmed trendline signals will be logged here.
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-0.5">
                {scanner.history.slice(0, 40).map((sig) => (
                  <div
                    key={sig.id}
                    className="rounded-lg border border-line bg-panel px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-ink truncate">
                        {sig.displayName}
                      </span>
                      <span
                        className={`text-[11px] font-bold font-mono ${
                          sig.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'
                        }`}
                      >
                        {sig.direction} · {sig.score}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-faint">
                      <span>{TRENDLINE_MODEL_SHORT[sig.model]}</span>
                      <span>·</span>
                      <span className="font-mono">
                        {formatPrice(sig.entryPrice, sig.precision)} → {formatPrice(sig.takeProfit, sig.precision)}
                      </span>
                      <span>·</span>
                      <span
                        className={
                          sig.status === 'INVALIDATED'
                            ? 'text-bear'
                            : sig.status === 'COMPLETED'
                              ? 'text-emerald-400'
                              : 'text-muted'
                        }
                      >
                        {sig.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Methodology note */}
      <Card className="p-3 flex items-start gap-2.5">
        <Loader2 className="w-3.5 h-3.5 text-faint mt-0.5 shrink-0" aria-hidden="true" />
        <p className="text-[11px] text-faint leading-snug">
          The Trendline AI runs independently of the price-action engine and reuses the same live
          Deriv feed. Structure, swings and trendlines are built on confirmed M15 candles; the
          rejection setup develops on M5; the precise entry is confirmed on M1 and must agree with
          the higher-timeframe direction. Every Volatility Index is analysed independently on its
          own feed (never just Volatility 75), Boom &amp; Crash are excluded, and a setup is
          published only when it clears the module's score gate with a real confirmation — the
          engine never fabricates or downgrades a signal.
        </p>
      </Card>
    </div>
  );
}
