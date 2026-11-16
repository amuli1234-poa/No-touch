import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, Gauge, Layers, LineChart, Loader2, ScanSearch, Square, X } from 'lucide-react';
import { TIMEFRAMES } from '../../config/deriv';
import { useWorkspace } from '../../context/WorkspaceContext';
import type { AiScannerValue } from '../../hooks/useAiScanner';
import type { AiInstrumentAnalysis, AiSignal, AiZone } from '../../types/aiModule';
import { AI_CONDITION_LABELS, AI_STATUS_LABELS } from '../../types/aiModule';
import { formatPrice } from '../../utils/derivParser';
import { ModuleChartSlot } from '../chart/ModuleChartSlot';
import { Card, SectionCard, StatTile, StatusPill } from '../ui/primitives';
import { scoreColor, toneClass } from '../../utils/signalVisuals';
import { TopDownPanel } from './TopDownPanel';

export interface AiModuleMeta {
  title: string;
  subtitle: string;
  icon: ReactNode;
  /** Short engine description shown in the settings subtitle. */
  settingsSubtitle: string;
  /** Extra module-specific panel rendered below the zones (optional). */
  extraPanel?: (analysis: AiInstrumentAnalysis) => ReactNode;
}

interface AiModuleViewProps {
  scanner: AiScannerValue;
  meta: AiModuleMeta;
}

const STATUS_STYLE: Partial<Record<AiSignal['status'], string>> = {
  ANALYSING: 'bg-elevated text-muted border-line',
  WATCHING: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  WAITING_FOR_SETUP: 'bg-amber-500/12 text-warn border-amber-500/30',
  WAITING_FOR_CONFIRMATION: 'bg-amber-500/12 text-warn border-amber-500/30',
  WAITING_FOR_REJECTION: 'bg-amber-500/12 text-warn border-amber-500/30',
  CONFIRMED: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  CONFIRMED_BREAKOUT: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  INVALIDATED: 'bg-panel text-faint border-line',
  NO_VALID_SETUP: 'bg-panel text-faint border-line',
  NO_HIGH_QUALITY_OPPORTUNITY: 'bg-panel text-faint border-line',
};

function statusStyle(status: AiSignal['status']): string {
  return STATUS_STYLE[status] ?? 'bg-elevated text-muted border-line';
}


function SignalCard({ signal }: { signal: AiSignal }) {
  const isRise = signal.direction === 'RISE';
  return (
    <div
      className={`rounded-lg border p-3 ${
        isRise ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-red-500/40 bg-red-500/[0.06]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-sm font-extrabold tracking-tight ${isRise ? 'text-emerald-400' : 'text-bear'}`}>
            {signal.direction}
          </span>
          <span className="text-[11px] text-muted truncate">{signal.displayName}</span>
        </div>
        <span className={`text-sm font-bold font-mono ${scoreColor(signal.score)}`}>{signal.score}/100</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusPill label={signal.modelLabel} className="bg-elevated text-muted border-line" />
        <StatusPill
          label={signal.strategyLabel}
          className={isRise ? 'bg-blue-500/12 text-blue-400 border-blue-500/30' : 'bg-red-500/12 text-bear border-red-500/30'}
        />
        <StatusPill label={AI_CONDITION_LABELS[signal.condition]} className="bg-elevated text-muted border-line" />
        <StatusPill label={`R:R ${signal.riskRewardRatio.toFixed(2)}`} className="bg-elevated text-muted border-line" />
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${statusStyle(signal.status)}`}>
          {AI_STATUS_LABELS[signal.status]}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatTile
          label="Entry zone"
          value={`${formatPrice(signal.entryZoneLow, signal.precision)}–${formatPrice(signal.entryZoneHigh, signal.precision)}`}
        />
        <StatTile label="Invalidation" value={formatPrice(signal.stopLoss, signal.precision)} valueClass="text-bear" />
        <StatTile label="TP1" value={formatPrice(signal.takeProfit1, signal.precision)} valueClass="text-emerald-400" />
        <StatTile label="TP2" value={formatPrice(signal.takeProfit2, signal.precision)} valueClass="text-emerald-400" />
        <StatTile
          label="TP3"
          value={signal.takeProfit3 === null ? '—' : formatPrice(signal.takeProfit3, signal.precision)}
          valueClass="text-emerald-400"
        />
        <StatTile label="Setup quality" value={`${signal.score}/100`} />
      </div>

      <div className="mt-3 space-y-1">
        {signal.reasons.slice(0, 4).map((r, i) => (
          <div key={i} className="text-[11px] text-muted leading-snug flex gap-1.5">
            <span className="text-accent shrink-0">•</span>
            <span>{r}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ZoneRow({
  zone,
  precision,
  active,
  onSelect,
}: {
  zone: AiZone;
  precision: number;
  active: boolean;
  onSelect?: () => void;
}) {
  const isBull = zone.direction === 'RISE';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors cursor-pointer ${
        isBull ? 'border-blue-500/35 bg-blue-500/[0.05]' : 'border-red-500/35 bg-red-500/[0.05]'
      } ${active ? 'ring-1 ring-accent/60' : 'hover:border-accent/40'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-bold ${isBull ? 'text-blue-400' : 'text-bear'}`}>
          {zone.label} · {isBull ? 'RISE' : 'FALL'}
        </span>
        <span className={`text-[11px] font-bold font-mono ${scoreColor(zone.quality)}`}>
          {Math.round(zone.quality)}/100
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-faint">
        <span className="font-mono">
          {formatPrice(zone.lowerPrice, precision)} – {formatPrice(zone.upperPrice, precision)}
        </span>
        {zone.watch && <StatusPill label="FUTURE" className="bg-elevated text-muted border-line" />}
        {zone.fresh && <StatusPill label="FRESH" className="bg-elevated text-muted border-line" />}
      </div>
      <p className="mt-1 text-[10px] text-faint leading-snug">{zone.reason}</p>
    </button>
  );
}

function AnalysisRow({
  analysis,
  precision,
  active,
  onSelect,
}: {
  analysis: AiInstrumentAnalysis;
  precision: number;
  active: boolean;
  onSelect: () => void;
}) {
  const signal = analysis.signal;
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
            {analysis.bestScore > 0 ? `${analysis.bestScore}/100` : '—'}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${statusStyle(analysis.status)}`}>
          {AI_STATUS_LABELS[analysis.status]}
        </span>
        <span className="text-[10px] text-faint font-mono">{formatPrice(analysis.price, precision)}</span>
        <span className="text-[10px] text-faint">
          {analysis.activeZones.length + analysis.watchZones.length} zone
          {analysis.activeZones.length + analysis.watchZones.length === 1 ? '' : 's'}
        </span>
      </div>
    </button>
  );
}

export function AiModuleView({ scanner, meta }: AiModuleViewProps) {
  const ws = useWorkspace();
  const [focused, setFocused] = useState<AiInstrumentAnalysis | null>(null);
  const [selectedZone, setSelectedZone] = useState<AiZone | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const precision = ws.precision;

  const [liveAnalysis, setLiveAnalysis] = useState<AiInstrumentAnalysis | null>(null);
  useEffect(() => {
    let cancelled = false;
    void scanner.analyzeLive(ws.selectedSymbol).then((analysis) => {
      if (!cancelled) setLiveAnalysis(analysis);
    });
    return () => {
      cancelled = true;
    };
  }, [scanner.analyzeLive, ws.selectedSymbol, ws.dataset.datasetId, scanner.summary]);

  const chartAnalysis = useMemo(() => {
    if (focused && focused.symbol === ws.selectedSymbol) return focused;
    return liveAnalysis;
  }, [focused, liveAnalysis, ws.selectedSymbol]);

  const overlay = useMemo(() => {
    if (!chartAnalysis) return null;
    return {
      zones: chartAnalysis.activeZones,
      watchZones: chartAnalysis.watchZones,
      signal: chartAnalysis.signal,
      precision: chartAnalysis.precision,
    };
  }, [chartAnalysis]);

  const dark = ws.settings.theme === 'dark';

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-lg bg-accent/15 text-accent border border-accent/30 flex items-center justify-center">
            {meta.icon}
          </span>
          <div>
            <h1 className="text-base font-extrabold tracking-tight text-ink leading-none">{meta.title}</h1>
            <p className="text-[11px] text-muted leading-none mt-0.5">{meta.subtitle}</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer"
          >
            Settings
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
              Scan markets
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
          {scanner.targetMarketCount} markets · M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1
          {scanner.lastScannedAt ? ` · last scan ${new Date(scanner.lastScannedAt).toLocaleTimeString()}` : ''}
        </span>
      </Card>

      {/* Settings */}
      {showSettings && (
        <SectionCard
          title="Settings"
          subtitle={meta.settingsSubtitle}
          icon={<Activity className="w-3.5 h-3.5" aria-hidden="true" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] font-semibold text-muted mb-1">
                Minimum score gate: <span className="font-mono text-ink">{scanner.settings.minScore}</span>
              </div>
              <input
                type="range"
                min={60}
                max={95}
                value={scanner.settings.minScore}
                onChange={(e) => scanner.setMinScore(Number(e.target.value))}
                className="w-full accent-accent cursor-pointer"
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="text-[11px] font-semibold text-muted">Direction preference</div>
              <div className="flex items-center gap-1.5">
                {(['BOTH', 'RISE', 'FALL'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => scanner.setDirectionPreference(d)}
                    className={`h-7 px-2.5 text-[11px] font-semibold rounded-md border cursor-pointer ${
                      scanner.settings.directionPreference === d
                        ? 'border-accent/60 bg-accent/12 text-ink'
                        : 'border-line bg-elevated text-muted hover:text-ink'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => scanner.setInclude1Sec(!scanner.settings.include1Sec)}
                className={`h-8 px-3 text-[11px] font-semibold rounded-md border cursor-pointer ${
                  scanner.settings.include1Sec
                    ? 'border-accent/60 bg-accent/12 text-ink'
                    : 'border-line bg-elevated text-muted hover:text-ink'
                }`}
              >
                1-second indices {scanner.settings.include1Sec ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                onClick={() => scanner.setAutoRefresh(!scanner.autoRefresh)}
                className={`h-8 px-3 text-[11px] font-semibold rounded-md border cursor-pointer ${
                  scanner.autoRefresh
                    ? 'border-accent/60 bg-accent/12 text-ink'
                    : 'border-line bg-elevated text-muted hover:text-ink'
                }`}
              >
                Auto-refresh {scanner.autoRefresh ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-muted">Chart timeframe</span>
              <div className="flex items-center gap-1.5">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf.key}
                    type="button"
                    onClick={() => scanner.setChartTimeframe(tf.key)}
                    className={`h-7 px-2 text-[11px] font-semibold rounded-md border cursor-pointer ${
                      scanner.settings.chartTimeframe === tf.key
                        ? 'border-accent/60 bg-accent/12 text-ink'
                        : 'border-line bg-elevated text-muted hover:text-ink'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </SectionCard>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-3">
        <div className="flex flex-col gap-3 min-w-0">
          <ModuleChartSlot aiOverlay={overlay} onAiZoneSelect={setSelectedZone} />

          {selectedZone && (
            <SectionCard
              title="Zone Analysis"
              subtitle={`${selectedZone.label} · quality ${Math.round(selectedZone.quality)}/100`}
              icon={<Layers className="w-3.5 h-3.5" aria-hidden="true" />}
              right={
                <button
                  type="button"
                  onClick={() => setSelectedZone(null)}
                  className="text-muted hover:text-ink cursor-pointer"
                  aria-label="Close zone analysis"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              }
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <StatTile label="Upper" value={formatPrice(selectedZone.upperPrice, precision)} />
                <StatTile label="Lower" value={formatPrice(selectedZone.lowerPrice, precision)} />
                <StatTile label="Quality" value={`${Math.round(selectedZone.quality)}/100`} />
              </div>
              <p className="text-[11px] text-muted leading-snug mt-3">{selectedZone.reason}</p>
            </SectionCard>
          )}

          {chartAnalysis && (
            <>
              <Card className={`px-4 py-3 border ${statusStyle(chartAnalysis.status)}`}>
                <div className="flex items-start gap-2.5">
                  <Activity className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-extrabold uppercase tracking-wide">
                        {AI_STATUS_LABELS[chartAnalysis.status]}
                      </span>
                      <StatusPill label={AI_CONDITION_LABELS[chartAnalysis.condition]} className="bg-elevated text-muted border-line" />
                    </div>
                    <p className="text-[11px] text-muted leading-snug mt-1.5">{chartAnalysis.statusExplanation}</p>
                  </div>
                </div>
              </Card>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {chartAnalysis.timeframes.map((tf) => (
                  <div key={tf.timeframe} className="rounded-lg border border-line bg-panel px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-ink">{tf.label}</span>
                      <span className="text-[10px] font-mono text-faint">{tf.timeframe}</span>
                    </div>
                    <p className={`text-[11px] leading-snug mt-1 ${toneClass(tf.tone)}`}>{tf.detail}</p>
                  </div>
                ))}
              </div>

              {chartAnalysis.topDown && <TopDownPanel analysis={chartAnalysis.topDown} />}

              {meta.extraPanel?.(chartAnalysis)}
            </>
          )}
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-3 min-w-0">
          <SectionCard
            title="Best Setup"
            subtitle="Only the strongest valid setup clears the gate — otherwise NO VALID SETUP"
            icon={<LineChart className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {scanner.summary?.winner ? (
              <SignalCard signal={scanner.summary.winner} />
            ) : (
              <div className="text-[11px] text-faint py-4 text-center">
                {scanner.summary ? scanner.summary.statusBanner : 'Run a scan to search for setups.'}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Zones In Play"
            subtitle="Current valid zones, nearest first"
            icon={<Layers className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {!chartAnalysis ? (
              <div className="text-[11px] text-faint py-4 text-center">Awaiting analysis for this instrument…</div>
            ) : chartAnalysis.activeZones.length === 0 && chartAnalysis.watchZones.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center">
                {chartAnalysis.rejectionReason ?? 'No current zones detected.'}
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto">
                {chartAnalysis.activeZones.map((z) => (
                  <ZoneRow
                    key={z.id}
                    zone={z}
                    precision={chartAnalysis.precision}
                    active={selectedZone?.id === z.id}
                    onSelect={() => setSelectedZone(z)}
                  />
                ))}
                {chartAnalysis.watchZones.length > 0 && (
                  <div className="text-[10px] font-bold uppercase tracking-wide text-faint mt-1">Future watch zones</div>
                )}
                {chartAnalysis.watchZones.map((z) => (
                  <ZoneRow
                    key={z.id}
                    zone={z}
                    precision={chartAnalysis.precision}
                    active={selectedZone?.id === z.id}
                    onSelect={() => setSelectedZone(z)}
                  />
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Scanned Markets"
            subtitle={`${scanner.analyses.length} indices analysed independently`}
            icon={<ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />}
          >
            {scanner.analyses.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center">No scan results yet.</div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto">
                {scanner.analyses.map((a) => (
                  <AnalysisRow
                    key={a.symbol}
                    analysis={a}
                    precision={a.precision}
                    active={a.symbol === ws.selectedSymbol}
                    onSelect={() => {
                      setFocused(a);
                      ws.selectMarket(a.symbol);
                      ws.selectTimeframe(scanner.settings.chartTimeframe);
                    }}
                  />
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Signal History"
            subtitle="Confirmed setups recorded this session"
            icon={<Activity className="w-3.5 h-3.5" aria-hidden="true" />}
            right={
              scanner.history.length > 0 ? (
                <button
                  type="button"
                  onClick={scanner.clearHistory}
                  className="text-[11px] font-semibold text-muted hover:text-ink cursor-pointer"
                >
                  Clear
                </button>
              ) : null
            }
          >
            {scanner.history.length === 0 ? (
              <div className="text-[11px] text-faint py-4 text-center">No confirmed signals yet.</div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto">
                {scanner.history.slice(0, 20).map((sig) => (
                  <div key={sig.id} className="rounded-lg border border-line bg-panel px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-ink truncate">{sig.displayName}</span>
                      <span className={`text-[11px] font-bold font-mono ${sig.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'}`}>
                        {sig.direction} · {sig.score}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-faint">
                      <span>{sig.modelLabel}</span>
                      <span>·</span>
                      <span>{new Date(sig.createdAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
