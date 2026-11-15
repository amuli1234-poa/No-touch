import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Boxes,
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
  Waves,
  X,
} from 'lucide-react';
import { TIMEFRAMES } from '../config/deriv';
import { useWorkspace } from '../context/WorkspaceContext';
import type { DemandSupplyScannerValue } from '../hooks/useDemandSupplyScanner';
import type {
  DsEntryModelId,
  DsInstrumentAnalysis,
  DsSignal,
  DsSignalStatus,
  DsZone,
} from '../types/demandSupply';
import {
  DS_FORMATION_LABELS,
  DS_MODEL_IDS,
  DS_MODEL_LABELS,
  DS_MODEL_SHORT,
  DS_STATUS_LABELS,
} from '../types/demandSupply';
import { formatPrice } from '../utils/derivParser';
import { ModuleChartSlot } from './chart/ModuleChartSlot';
import type { DsChartOverlay } from './chart/DsChartPrimitive';
import { Card, SectionCard, StatTile, StatusPill } from './ui/primitives';

interface DemandSupplyAIViewProps {
  scanner: DemandSupplyScannerValue;
}

const STATUS_STYLE: Record<DsSignalStatus, string> = {
  ANALYSING: 'bg-elevated text-muted border-line',
  FRESH_DEMAND_FOUND: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  FRESH_SUPPLY_FOUND: 'bg-red-500/12 text-bear border-red-500/30',
  WATCHING_DEMAND: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  WATCHING_SUPPLY: 'bg-red-500/12 text-bear border-red-500/30',
  WAITING_FOR_CONFIRMATION: 'bg-amber-500/12 text-warn border-amber-500/30',
  RISE_CONFIRMED: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  FALL_CONFIRMED: 'bg-red-500/12 text-bear border-red-500/30',
  SETUP_INVALIDATED: 'bg-panel text-faint border-line',
  NO_VALID_SETUP: 'bg-panel text-faint border-line',
};

const MODEL_ICON: Record<DsEntryModelId, typeof TrendingUp> = {
  DS_FRESH_REJECTION: Sparkles,
  DS_RETEST_CONTINUATION: RefreshCw,
  DS_LIQUIDITY_SWEEP_RECLAIM: Crosshair,
  DS_FVG_CONFLUENCE: Layers,
  DS_ORDER_BLOCK_RETEST: Boxes,
  DS_BREAKER_RETEST: ArrowUpRight,
  DS_M1_BOS_CHOCH: TrendingUp,
  DS_ENGULFING_CONFIRMATION: Boxes,
};

const STATE_TONE: Record<DsZone['state'], string> = {
  FRESH: 'text-emerald-400',
  TESTED: 'text-warn',
  PARTIALLY_MITIGATED: 'text-amber-300',
  FULLY_MITIGATED: 'text-faint',
  INVALIDATED: 'text-bear',
};

function scoreColor(score: number): string {
  if (score >= 92) return 'text-emerald-400';
  if (score >= 85) return 'text-accent';
  if (score >= 70) return 'text-warn';
  return 'text-muted';
}

function toneClass(tone: 'bull' | 'bear' | 'warn' | 'neutral'): string {
  if (tone === 'bull') return 'text-emerald-400';
  if (tone === 'bear') return 'text-bear';
  if (tone === 'warn') return 'text-warn';
  return 'text-muted';
}

function ZoneRow({
  zone,
  precision,
  active,
  onSelect,
}: {
  zone: DsZone;
  precision: number;
  active: boolean;
  onSelect?: () => void;
}) {
  const isDemand = zone.type === 'demand';
  const Icon = isDemand ? TrendingUp : TrendingDown;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors cursor-pointer ${
        isDemand ? 'border-blue-500/35 bg-blue-500/[0.05]' : 'border-red-500/35 bg-red-500/[0.05]'
      } ${active ? 'ring-1 ring-accent/60' : 'hover:border-accent/40'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`flex items-center gap-1.5 text-xs font-bold ${isDemand ? 'text-blue-400' : 'text-bear'}`}>
          <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          {isDemand ? 'DEMAND' : 'SUPPLY'} · {zone.formationLabel}
        </span>
        <span className={`text-[11px] font-bold font-mono ${scoreColor(zone.score.total)}`}>
          {zone.score.total}/100
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-faint">
        <span className={`font-semibold ${STATE_TONE[zone.state]}`}>
          {zone.state.replace(/_/g, ' ')}
        </span>
        <span>·</span>
        <span className="font-mono">
          {formatPrice(zone.lowerPrice, precision)} – {formatPrice(zone.upperPrice, precision)}
        </span>
        <span>·</span>
        <span>{zone.distanceAtr.toFixed(1)}× ATR</span>
        {zone.causedBos && <StatusPill label="BOS" className="bg-elevated text-muted border-line" />}
        {zone.hasFvgConfluence && (
          <StatusPill label="FVG" className="bg-elevated text-muted border-line" />
        )}
      </div>
    </button>
  );
}

function SignalCard({
  signal,
  onFocus,
}: {
  signal: DsSignal;
  onFocus?: () => void;
}) {
  const isRise = signal.direction === 'RISE';
  const Icon = MODEL_ICON[signal.model];
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
          <span className={`text-sm font-extrabold tracking-tight ${isRise ? 'text-emerald-400' : 'text-bear'}`}>
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
          label={DS_MODEL_SHORT[signal.model]}
          className="bg-elevated text-muted border-line"
        />
        <StatusPill
          label={`${signal.zone.formationLabel} ${signal.zone.type}`}
          className={isRise ? 'bg-blue-500/12 text-blue-400 border-blue-500/30' : 'bg-red-500/12 text-bear border-red-500/30'}
        />
        <StatusPill
          label={`Zone Q${signal.zoneQuality}`}
          className="bg-elevated text-muted border-line"
        />
        <StatusPill
          label={`R:R ${signal.riskRewardRatio.toFixed(2)}`}
          className="bg-elevated text-muted border-line"
        />
        <StatusPill
          label={`${signal.structureTimeframe}→${signal.setupTimeframe}→${signal.entryTimeframe}`}
          className="bg-elevated text-muted border-line"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatTile
          label="Entry zone"
          value={`${formatPrice(signal.entryZoneLow, signal.precision)}–${formatPrice(
            signal.entryZoneHigh,
            signal.precision
          )}`}
        />
        <StatTile
          label="Invalidation"
          value={formatPrice(signal.invalidationPrice, signal.precision)}
          valueClass="text-bear"
        />
        <StatTile
          label="TP1"
          value={formatPrice(signal.takeProfit1, signal.precision)}
          valueClass="text-emerald-400"
        />
        <StatTile
          label="TP2"
          value={formatPrice(signal.takeProfit2, signal.precision)}
          valueClass="text-emerald-400"
        />
        <StatTile
          label="TP3"
          value={signal.takeProfit3 === null ? '—' : formatPrice(signal.takeProfit3, signal.precision)}
          valueClass="text-emerald-400"
        />
        <StatTile label="Zone quality" value={`${signal.zoneQuality}/100`} />
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
  analysis: DsInstrumentAnalysis;
  precision: number;
  active: boolean;
  onSelect: () => void;
}) {
  const signal = analysis.signal;
  const candidate = analysis.bestCandidate;
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
        {signal ? (
          <span className={`text-[11px] font-bold font-mono ${signal.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'}`}>
            {signal.direction} · {signal.score}
          </span>
        ) : (
          <span className="text-[11px] text-faint font-mono">
            {candidate ? `${candidate.score}/100` : '—'}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATUS_STYLE[analysis.status]}`}>
          {DS_STATUS_LABELS[analysis.status]}
        </span>
        <span className="text-[10px] text-faint font-mono">
          {formatPrice(analysis.price, precision)}
        </span>
        <span className="text-[10px] text-faint">
          {analysis.zones.length} zone{analysis.zones.length === 1 ? '' : 's'}
        </span>
      </div>
    </button>
  );
}

function StatusBanner({ analysis }: { analysis: DsInstrumentAnalysis }) {
  const tone = STATUS_STYLE[analysis.status];
  const isDemand = analysis.status.includes('DEMAND');
  const isSupply = analysis.status.includes('SUPPLY');
  const Icon = analysis.status === 'RISE_CONFIRMED' || isDemand
    ? TrendingUp
    : analysis.status === 'FALL_CONFIRMED' || isSupply
      ? TrendingDown
      : Crosshair;
  return (
    <Card className={`px-4 py-3 border ${tone}`}>
      <div className="flex items-start gap-2.5">
        <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-extrabold uppercase tracking-wide">
              {DS_STATUS_LABELS[analysis.status]}
            </span>
            <StatusPill
              label={analysis.demandSupplyBalance.replace(/_/g, ' ')}
              className="bg-elevated text-muted border-line"
            />
          </div>
          <p className="text-[11px] text-muted leading-snug mt-1.5">{analysis.statusExplanation}</p>
        </div>
      </div>
    </Card>
  );
}

function TimeframeReads({ analysis }: { analysis: DsInstrumentAnalysis }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {analysis.timeframes.map((tf) => (
        <div key={tf.timeframe} className="rounded-lg border border-line bg-panel px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-ink">{tf.label}</span>
            <span className="text-[10px] font-mono text-faint">{tf.timeframe}</span>
          </div>
          <p className={`text-[11px] leading-snug mt-1 ${toneClass(tf.tone)}`}>{tf.detail}</p>
        </div>
      ))}
    </div>
  );
}

function ZoneDetail({ zone, precision, onClose }: { zone: DsZone; precision: number; onClose: () => void }) {
  const isDemand = zone.type === 'demand';
  return (
    <SectionCard
      title={`${isDemand ? 'Demand' : 'Supply'} Zone Analysis`}
      subtitle={`${zone.formationLabel} · quality ${zone.score.total}/100`}
      icon={<Crosshair className="w-3.5 h-3.5" aria-hidden="true" />}
      right={
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-ink cursor-pointer"
          aria-label="Close zone analysis"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="Proximal" value={formatPrice(zone.proximalPrice, precision)} />
        <StatTile label="Distal" value={formatPrice(zone.distalPrice, precision)} />
        <StatTile label="Displacement" value={`${zone.displacementAtr.toFixed(1)}× ATR`} />
        <StatTile label="Touches" value={String(zone.touches)} />
      </div>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-5 gap-2">
        <StatTile label="Formation" value={`${zone.score.formationQuality}/30`} />
        <StatTile label="Displacement" value={`${zone.score.displacement}/20`} />
        <StatTile label="Freshness" value={`${zone.score.freshness}/20`} />
        <StatTile label="BOS origin" value={`${zone.score.bosOrigin}/15`} />
        <StatTile label="FVG" value={`${zone.score.fvgConfluence}/15`} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <StatusPill
          label={zone.state.replace(/_/g, ' ')}
          className="bg-elevated text-muted border-line"
        />
        {zone.causedBos && <StatusPill label="caused BOS" className="bg-elevated text-muted border-line" />}
        {zone.hasFvgConfluence && <StatusPill label="FVG confluence" className="bg-elevated text-muted border-line" />}
        {zone.untested && <StatusPill label="untested" className="bg-elevated text-muted border-line" />}
      </div>

      <p className="text-[11px] text-muted leading-snug mt-3">{zone.reason}</p>
    </SectionCard>
  );
}

export function DemandSupplyAIView({ scanner }: DemandSupplyAIViewProps) {
  const ws = useWorkspace();
  const [focused, setFocused] = useState<DsInstrumentAnalysis | null>(null);
  const [selectedZone, setSelectedZone] = useState<DsZone | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const precision = ws.precision;
  const winner = scanner.summary?.winner ?? null;

  const [liveAnalysis, setLiveAnalysis] = useState<DsInstrumentAnalysis | null>(null);
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
  const dsOverlay = useMemo<DsChartOverlay | null>(() => {
    if (!chartAnalysis) return null;
    return {
      zones: chartAnalysis.zones,
      watchZones: chartAnalysis.futureWatchZones,
      signal: chartAnalysis.signal ?? null,
      precision,
    };
  }, [chartAnalysis, precision]);

  const focusAnalysis = useCallback(
    (analysis: DsInstrumentAnalysis) => {
      setFocused(analysis);
      setSelectedZone(null);
      ws.selectMarket(analysis.symbol);
      ws.selectTimeframe(scanner.settings.chartTimeframe);
    },
    [ws, scanner.settings.chartTimeframe]
  );

  const focusSignal = useCallback(
    (signal: DsSignal) => {
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

  const demandZones = chartAnalysis?.zones.filter((z) => z.type === 'demand') ?? [];
  const supplyZones = chartAnalysis?.zones.filter((z) => z.type === 'supply') ?? [];
  const dark = ws.settings.theme === 'dark';

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-lg bg-accent/15 text-accent border border-accent/30 flex items-center justify-center">
            <Boxes className="w-4 h-4" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-base font-extrabold tracking-tight text-ink leading-none">
              Demand &amp; Supply AI
            </h1>
            <p className="text-[11px] text-muted leading-none mt-0.5">
              M15 zones · M5 setup · M1 confirmation · independent of every other engine
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer"
          >
            Models &amp; Settings
          </button>
          {scanner.isScanning ? (
            <button
              type="button"
              onClick={scanner.cancelScan}
              className="h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-bear/50 cursor-pointer inline-flex items-center gap-1.5"
            >
              <Square className="w-3 h-3" aria-hidden="true" />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void scanner.scanMarkets()}
              className="h-8 px-3 text-[11px] font-semibold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer inline-flex items-center gap-1.5"
            >
              <ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />
              Scan demand &amp; supply
            </button>
          )}
        </div>
      </div>

      {/* Progress banner */}
      <Card className="px-4 py-2.5 flex items-center gap-2.5">
        {scanner.isScanning ? (
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" aria-hidden="true" />
        ) : (
          <Gauge className="w-3.5 h-3.5 text-faint shrink-0" aria-hidden="true" />
        )}
        <span className="text-[11px] text-muted truncate flex-1">{scanner.progressMessage}</span>
        <span className="text-[10px] font-mono text-faint shrink-0">
          {scanner.targetMarketCount} markets · M15 → M5 → M1
          {scanner.lastScannedAt ? ` · last scan ${new Date(scanner.lastScannedAt).toLocaleTimeString()}` : ''}
        </span>
      </Card>

      {/* Status banner for the charted instrument */}
      {chartAnalysis && <StatusBanner analysis={chartAnalysis} />}

      {/* Settings */}
      {showSettings && (
        <SectionCard
          title="Models & Settings"
          subtitle="Toggle the six demand & supply entry models and set the publication gate"
          icon={<Activity className="w-3.5 h-3.5" aria-hidden="true" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {DS_MODEL_IDS.map((id) => {
              const Icon = MODEL_ICON[id];
              const enabled = scanner.settings.enabledModels[id];
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => scanner.toggleModel(id)}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${
                    enabled ? 'border-accent/50 bg-accent/[0.06]' : 'border-line bg-panel'
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${enabled ? 'text-accent' : 'text-faint'}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <div className={`text-xs font-bold ${enabled ? 'text-ink' : 'text-muted'}`}>
                      {DS_MODEL_LABELS[id]}
                    </div>
                    <div className="text-[10px] text-faint">RISE &amp; FALL · M1 confirmation required</div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-muted">Direction</label>
              <div className="mt-1 flex gap-1.5">
                {(['BOTH', 'RISE', 'FALL'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => scanner.setDirectionPreference(d)}
                    className={`h-8 px-3 text-[11px] font-semibold rounded-md border cursor-pointer ${
                      scanner.settings.directionPreference === d
                        ? 'text-app bg-accent border-accent'
                        : 'text-muted bg-elevated border-line hover:text-ink'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-muted">
                Publication gate: {scanner.settings.minScore}/100
              </label>
              <input
                type="range"
                min={60}
                max={95}
                value={scanner.settings.minScore}
                onChange={(e) => scanner.setMinScore(Number(e.target.value))}
                className="mt-2 w-full accent-[var(--color-accent)]"
              />
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

      {/* Main grid: chart + panels */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-3">
        {/* Chart column */}
        <div className="flex flex-col gap-3 min-w-0">
          <ModuleChartSlot dsOverlay={dsOverlay} onDsZoneSelect={setSelectedZone} />

          {selectedZone && (
            <ZoneDetail
              zone={selectedZone}
              precision={chartAnalysis?.precision ?? precision}
              onClose={() => setSelectedZone(null)}
            />
          )}

          {chartAnalysis && <TimeframeReads analysis={chartAnalysis} />}

          {/* Current zones */}
          <SectionCard
            title="Current Demand & Supply Zones"
            subtitle="Blue = demand, red = supply · current valid zones only (nearest first)"
            icon={<Layers className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {!chartAnalysis ? (
              <div className="text-[11px] text-faint py-4 text-center">
                Awaiting demand &amp; supply analysis for this instrument…
              </div>
            ) : chartAnalysis.zones.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center leading-snug">
                No valid demand or supply zone on the current M15 structure. Weak formations and
                ordinary consolidation are never marked.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {chartAnalysis.zones.map((zone) => (
                  <ZoneRow
                    key={zone.id}
                    zone={zone}
                    precision={chartAnalysis.precision}
                    active={selectedZone?.id === zone.id}
                    onSelect={() => setSelectedZone(zone)}
                  />
                ))}
              </div>
            )}
          </SectionCard>

          {/* Future watch zones — where price may react NEXT */}
          {chartAnalysis && chartAnalysis.futureWatchZones.length > 0 && (
            <SectionCard
              title="Future Watch Zones"
              subtitle="Untouched zones still ahead of price — the NEXT potential reaction"
              icon={<Crosshair className="w-3.5 h-3.5" aria-hidden="true" />}
            >
              <div className="flex flex-col gap-2">
                {chartAnalysis.futureWatchZones.map((zone) => (
                  <ZoneRow
                    key={zone.id}
                    zone={zone}
                    precision={chartAnalysis.precision}
                    active={selectedZone?.id === zone.id}
                    onSelect={() => setSelectedZone(zone)}
                  />
                ))}
              </div>
            </SectionCard>
          )}
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-3 min-w-0">
          <SectionCard
            title="Best Demand & Supply Signal"
            subtitle="Strongest confirmed setup across the scanned markets"
            icon={<Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {winner ? (
              <SignalCard signal={winner} onFocus={() => focusSignal(winner)} />
            ) : (
              <div className="text-center py-6">
                <Gauge className="w-7 h-7 text-faint mx-auto mb-2" aria-hidden="true" />
                <div className="text-xs font-semibold text-ink">No confirmed signal</div>
                <p className="text-[11px] text-faint mt-1 max-w-xs mx-auto leading-snug">
                  {scanner.summary
                    ? scanner.summary.statusBanner
                    : 'Run a demand & supply scan to search all enabled markets.'}
                </p>
              </div>
            )}
          </SectionCard>

          {/* Fresh zones summary */}
          {chartAnalysis && (
            <SectionCard
              title="Zone Read"
              subtitle={`${demandZones.length} demand · ${supplyZones.length} supply`}
              icon={<Waves className="w-3.5 h-3.5" aria-hidden="true" />}
            >
              <div className="grid grid-cols-2 gap-2">
                <StatTile
                  label="Fresh demand"
                  value={chartAnalysis.freshDemand ? `${chartAnalysis.freshDemand.score.total}/100` : '—'}
                  valueClass="text-blue-400"
                />
                <StatTile
                  label="Fresh supply"
                  value={chartAnalysis.freshSupply ? `${chartAnalysis.freshSupply.score.total}/100` : '—'}
                  valueClass="text-bear"
                />
                <StatTile
                  label="Active zone"
                  value={chartAnalysis.activeZone ? chartAnalysis.activeZone.type.toUpperCase() : '—'}
                />
                <StatTile label="Balance" value={chartAnalysis.demandSupplyBalance.replace(/_/g, ' ')} />
              </div>
            </SectionCard>
          )}

          <SectionCard
            title="Scanned Markets"
            subtitle={`${scanner.analyses.length} instrument${scanner.analyses.length === 1 ? '' : 's'} analysed${
              scanner.summary ? ` · ${scanner.summary.confirmedCount} confirmed` : ''
            }`}
            icon={<ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {scanner.analyses.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center">No scan results yet.</div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-0.5">
                {[...scanner.analyses]
                  .sort(
                    (a, b) =>
                      (b.signal?.score ?? b.bestCandidate?.score ?? 0) -
                      (a.signal?.score ?? a.bestCandidate?.score ?? 0)
                  )
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
            title="Signal History"
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
                Confirmed demand &amp; supply signals will be logged here.
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-0.5">
                {scanner.history.slice(0, 40).map((sig) => (
                  <div key={sig.id} className="rounded-lg border border-line bg-panel px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-ink truncate">{sig.displayName}</span>
                      <span className={`text-[11px] font-bold font-mono ${sig.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'}`}>
                        {sig.direction} · {sig.score}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-faint">
                      <span>{DS_MODEL_SHORT[sig.model]}</span>
                      <span>·</span>
                      <span className="font-mono">
                        {formatPrice(sig.entryPrice, sig.precision)} → {formatPrice(sig.takeProfit1, sig.precision)}
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
          The Demand &amp; Supply AI runs independently of the price-action engine and the Trendline
          AI, reusing the same live Deriv feed. M15 identifies the primary zones (DBR / RBR / RBD /
          DBD with strong displacement), M5 refines them and develops the setup, and M1 confirms the
          rejection entry. A signal is published only when a confirmed M1 rejection clears the score
          gate — a zone touch alone never triggers a signal, and Boom &amp; Crash indices are
          excluded.
        </p>
      </Card>
    </div>
  );
}
