import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Radar, RefreshCw, ScanSearch, Square, Trophy } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import type { AiScannerValue } from '../../hooks/useAiScanner';
import type { AiInstrumentAnalysis, AiSignal } from '../../types/aiModule';
import { AI_STATUS_LABELS } from '../../types/aiModule';
import { formatPrice } from '../../utils/derivParser';
import { ModuleChartSlot } from '../chart/ModuleChartSlot';
import { Card, EmptyState, SectionCard, StatTile, StatusPill } from '../ui/primitives';

interface LiveScannerViewProps {
  scanner: AiScannerValue;
}

type SortKey = 'quality' | 'symbol' | 'direction';

interface RankedRow {
  analysis: AiInstrumentAnalysis;
  signal: AiSignal | null;
  score: number;
}

function statusStyle(status: AiSignal['status']): string {
  if (status === 'CONFIRMED') return 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30';
  if (status === 'DEVELOPING' || status === 'WATCHING' || status === 'APPROACHING_ENTRY')
    return 'bg-amber-500/12 text-warn border-amber-500/30';
  if (status === 'NO_HIGH_QUALITY_OPPORTUNITY' || status === 'NO_VALID_SETUP')
    return 'bg-panel text-faint border-line';
  return 'bg-elevated text-muted border-line';
}

/**
 * LIVE MARKET SCANNER — dedicated ranking panel. It shows the strongest current
 * opportunities across every index, with real controls wired to the actual scanner engine.
 */
export function LiveScannerView({ scanner }: LiveScannerViewProps) {
  const ws = useWorkspace();
  const [sortKey, setSortKey] = useState<SortKey>('quality');
  const [maxRows, setMaxRows] = useState(12);
  const [minQuality, setMinQuality] = useState(scanner.settings.minScore);
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => setMinQuality(scanner.settings.minScore), [scanner.settings.minScore]);

  const rows = useMemo<RankedRow[]>(() => {
    const ranked = scanner.analyses.map((analysis) => ({
      analysis,
      signal: analysis.signal,
      score: analysis.signal?.score ?? analysis.bestScore,
    }));
    const filtered = ranked.filter((r) => r.score >= minQuality || r.signal !== null);
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'symbol') return a.analysis.displayName.localeCompare(b.analysis.displayName);
      if (sortKey === 'direction') {
        const ad = a.signal?.direction ?? 'RISE';
        const bd = b.signal?.direction ?? 'RISE';
        if (ad !== bd) return ad.localeCompare(bd);
      }
      if (b.score !== a.score) return b.score - a.score;
      return (b.signal?.riskRewardRatio ?? 0) - (a.signal?.riskRewardRatio ?? 0);
    });
    return sorted.slice(0, maxRows);
  }, [scanner.analyses, sortKey, maxRows, minQuality]);

  const selectedAnalysis = useMemo(
    () => rows.find((r) => r.analysis.symbol === selected)?.analysis ?? rows[0]?.analysis ?? null,
    [rows, selected]
  );

  const openMarket = useCallback(
    (symbol: string) => {
      setSelected(symbol);
      ws.selectMarket(symbol);
      ws.selectTimeframe(scanner.settings.chartTimeframe);
    },
    [ws, scanner.settings.chartTimeframe]
  );

  const overlay = useMemo(() => {
    if (!selectedAnalysis) return null;
    return {
      zones: selectedAnalysis.activeZones,
      watchZones: selectedAnalysis.watchZones,
      signal: selectedAnalysis.signal,
      precision: selectedAnalysis.precision,
    };
  }, [selectedAnalysis]);

  const dark = ws.settings.theme === 'dark';

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-5 max-w-[1500px] w-full mx-auto">
      {/* Header + controls */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-accent/15 text-accent border border-accent/30 flex items-center justify-center">
          <Radar className="w-4 h-4" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-base font-extrabold tracking-tight text-ink leading-none">Live Market Scanner</h1>
          <p className="text-[12px] text-muted leading-none mt-0.5">
            Continuous multi-market opportunity ranking · M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="h-8 px-3 text-[12px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer"
          >
            Controls
          </button>
          <button
            type="button"
            onClick={() => void scanner.scanMarkets()}
            disabled={scanner.isScanning}
            className="h-8 px-3 text-[12px] font-semibold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />
            {scanner.isScanning ? 'Scanning…' : 'Start scanning'}
          </button>
          <button
            type="button"
            onClick={() => scanner.setAutoRefresh(!scanner.autoRefresh)}
            className={`h-8 px-3 text-[12px] font-semibold rounded-md border cursor-pointer ${
              scanner.autoRefresh ? 'border-accent/60 bg-accent/12 text-ink' : 'border-line bg-elevated text-muted hover:text-ink'
            }`}
          >
            {scanner.autoRefresh ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            onClick={scanner.cancelScan}
            className="h-8 px-3 text-[12px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-bear/50 cursor-pointer inline-flex items-center gap-1.5"
          >
            <Square className="w-3 h-3" aria-hidden="true" />
            Stop
          </button>
        </div>
      </div>

      {/* Progress */}
      <Card className="px-4 py-2.5 flex items-center gap-2.5">
        {scanner.isScanning ? (
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" aria-hidden="true" />
        ) : (
          <Radar className="w-3.5 h-3.5 text-faint shrink-0" aria-hidden="true" />
        )}
        <span className="text-[12px] text-muted truncate flex-1">{scanner.progressMessage}</span>
        <span className="text-[11px] font-mono text-faint shrink-0">
          {scanner.targetMarketCount} markets · {rows.length} ranked
          {scanner.lastScannedAt ? ` · ${new Date(scanner.lastScannedAt).toLocaleTimeString()}` : ''}
        </span>
      </Card>

      {/* Controls */}
      {showSettings && (
        <SectionCard title="Scanner Controls" subtitle="Filters feed the live ranking engine" icon={<Radar className="w-3.5 h-3.5" aria-hidden="true" />}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <div className="text-[12px] font-semibold text-muted mb-1">
                Minimum quality: <span className="font-mono text-ink">{minQuality}</span>
              </div>
              <input
                type="range"
                min={60}
                max={95}
                value={minQuality}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinQuality(v);
                  scanner.setMinScore(v);
                }}
                className="w-full accent-accent cursor-pointer"
              />
            </div>
            <div>
              <div className="text-[12px] font-semibold text-muted mb-1">
                Max opportunities: <span className="font-mono text-ink">{maxRows}</span>
              </div>
              <input
                type="range"
                min={5}
                max={30}
                value={maxRows}
                onChange={(e) => setMaxRows(Number(e.target.value))}
                className="w-full accent-accent cursor-pointer"
              />
            </div>
            <div>
              <div className="text-[12px] font-semibold text-muted mb-1">Sort by</div>
              <div className="flex items-center gap-1.5">
                {(['quality', 'symbol', 'direction'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSortKey(k)}
                    className={`h-7 px-2.5 text-[12px] font-semibold rounded-md border cursor-pointer ${
                      sortKey === k ? 'border-accent/60 bg-accent/12 text-ink' : 'border-line bg-elevated text-muted hover:text-ink'
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="text-[12px] font-semibold text-muted">Direction preference</div>
              <div className="flex items-center gap-1.5">
                {(['BOTH', 'RISE', 'FALL'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => scanner.setDirectionPreference(d)}
                    className={`h-7 px-2.5 text-[12px] font-semibold rounded-md border cursor-pointer ${
                      scanner.settings.directionPreference === d
                        ? 'border-accent/60 bg-accent/12 text-ink'
                        : 'border-line bg-elevated text-muted hover:text-ink'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => scanner.setInclude1Sec(!scanner.settings.include1Sec)}
                className={`h-7 px-2.5 text-[12px] font-semibold rounded-md border cursor-pointer ${
                  scanner.settings.include1Sec ? 'border-accent/60 bg-accent/12 text-ink' : 'border-line bg-elevated text-muted hover:text-ink'
                }`}
              >
                1-second indices {scanner.settings.include1Sec ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </SectionCard>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.1fr] gap-3">
        {/* Ranking panel */}
        <SectionCard
          title="Top Opportunities"
          subtitle="Ranked by quality, structure and reward-to-risk — correlated signals are not double-counted"
          icon={<Trophy className="w-3.5 h-3.5" aria-hidden="true" />}
          right={
            <button
              type="button"
              onClick={() => void scanner.scanMarkets()}
              className="text-[12px] font-semibold text-accent hover:underline cursor-pointer inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              Refresh
            </button>
          }
        >
          {scanner.analyses.length === 0 ? (
            <EmptyState title="No scan yet" description="Run a scan to hunt for opportunities across every Volatility Index." />
          ) : rows.length === 0 ? (
            <div className="text-[12px] text-faint py-6 text-center">
              NO HIGH-QUALITY OPPORTUNITY RIGHT NOW.
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[620px] overflow-y-auto">
              {rows.map((row, i) => {
                const sig = row.signal;
                const isRise = (sig?.direction ?? 'RISE') === 'RISE';
                return (
                  <button
                    key={row.analysis.symbol}
                    type="button"
                    onClick={() => openMarket(row.analysis.symbol)}
                    className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
                      selectedAnalysis?.symbol === row.analysis.symbol
                        ? 'border-accent/60 bg-accent/[0.06]'
                        : 'border-line bg-panel hover:border-accent/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[11px] font-bold text-faint font-mono w-5 shrink-0">#{i + 1}</span>
                        <span className="text-xs font-bold text-ink truncate">{row.analysis.displayName}</span>
                      </div>
                      {sig ? (
                        <span className={`text-[12px] font-bold font-mono ${isRise ? 'text-emerald-400' : 'text-bear'}`}>
                          {sig.direction} · {sig.score}
                        </span>
                      ) : (
                        <span className="text-[12px] text-faint font-mono">{row.score}/100</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className={`text-[11px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${statusStyle(row.analysis.status)}`}>
                        {AI_STATUS_LABELS[row.analysis.status]}
                      </span>
                      {sig && <StatusPill label={sig.modelLabel} className="bg-elevated text-muted border-line" />}
                      <span className="text-[11px] text-faint font-mono">
                        {formatPrice(row.analysis.price, row.analysis.precision)}
                      </span>
                      {sig && (
                        <span className="text-[11px] text-faint font-mono">R:R {sig.riskRewardRatio.toFixed(2)}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </SectionCard>

        {/* Selected detail + chart */}
        <div className="flex flex-col gap-3 min-w-0">
          {selectedAnalysis && (
            <>
              <ModuleChartSlot aiOverlay={overlay} />

              <SectionCard title="Opportunity Detail" subtitle={selectedAnalysis.statusExplanation}>
                {selectedAnalysis.signal ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <StatTile
                      label="Entry zone"
                      value={`${formatPrice(selectedAnalysis.signal.entryZoneLow, selectedAnalysis.precision)}–${formatPrice(
                        selectedAnalysis.signal.entryZoneHigh,
                        selectedAnalysis.precision
                      )}`}
                    />
                    <StatTile label="Stop loss" value={formatPrice(selectedAnalysis.signal.stopLoss, selectedAnalysis.precision)} valueClass="text-bear" />
                    <StatTile label="TP1" value={formatPrice(selectedAnalysis.signal.takeProfit1, selectedAnalysis.precision)} valueClass="text-emerald-400" />
                    <StatTile label="TP2" value={formatPrice(selectedAnalysis.signal.takeProfit2, selectedAnalysis.precision)} valueClass="text-emerald-400" />
                    <StatTile
                      label="TP3"
                      value={selectedAnalysis.signal.takeProfit3 === null ? '—' : formatPrice(selectedAnalysis.signal.takeProfit3, selectedAnalysis.precision)}
                      valueClass="text-emerald-400"
                    />
                    <StatTile label="Model" value={selectedAnalysis.signal.modelLabel} />
                  </div>
                ) : (
                  <div className="text-[12px] text-faint py-3">
                    {selectedAnalysis.rejectionReason ?? 'No qualifying opportunity for this index right now.'}
                  </div>
                )}
              </SectionCard>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
