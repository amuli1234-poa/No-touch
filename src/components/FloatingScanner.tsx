import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  GripHorizontal,
  Loader2,
  Maximize2,
  Minus,
  Play,
  Radar,
  Search,
  Target,
  X,
} from 'lucide-react';
import type { MonitorScanSummary } from '../types/scanner';
import type { SyntheticMarket, TimeframeKey } from '../types/market';
import type { ManagedRankedSetup } from '../types/ranking';
import type { FilteredSignal, SignalFilterConfig } from '../types/signalFilter';
import type { CentralRankingResult } from '../types/centralRanking';
import { formatPrice } from '../utils/derivParser';
import {
  familyLabel,
  isOneSecondVolatility,
  isVolatilityIndex,
  marketFamilyLabel,
} from '../utils/volatilityMarkets';

type SortKey = 'volatility' | 'change' | 'name';
type ScannerTab = 'setups' | 'filter' | 'markets';

/** The final-selection labels for the top overall opportunities. */
const RANK_LABELS = ['#1 BEST SETUP', '#2 SECOND BEST SETUP', '#3 THIRD BEST SETUP'];

type FilterToggleKey =
  | 'requireTrendAlignment'
  | 'requireStructure'
  | 'requireZone'
  | 'requireTrigger'
  | 'rejectConflicts'
  | 'rejectDuplicates';

/** The centralized filter's mandatory checks, surfaced as toggles in the Filter panel. */
const FILTER_TOGGLES: ReadonlyArray<{ key: FilterToggleKey; label: string; hint: string }> = [
  {
    key: 'requireTrendAlignment',
    label: 'Trend alignment',
    hint: 'Reject setups fighting the dominant directional trend.',
  },
  {
    key: 'requireStructure',
    label: 'Structure / BOS',
    hint: 'Require market-structure or break-of-structure confirmation.',
  },
  {
    key: 'requireZone',
    label: 'Supply / demand zone',
    hint: 'Require price to be reacting at a relevant zone.',
  },
  {
    key: 'requireTrigger',
    label: 'Entry trigger & momentum',
    hint: 'Reject weak, late or exhausted entries.',
  },
  {
    key: 'rejectConflicts',
    label: 'Reject conflicts',
    hint: 'Keep only the strongest direction per instrument.',
  },
  {
    key: 'rejectDuplicates',
    label: 'Reject duplicates',
    hint: 'One setup per instrument, direction and model.',
  },
];

export interface FloatingScannerProps {
  open: boolean;
  onClose: () => void;
  monitorSummary: MonitorScanSummary | null;
  markets: SyntheticMarket[];
  timeframe: TimeframeKey;
  livePrice: number | null;
  selectedSymbol: string;
  onOpenMarket: (symbol: string, tf: TimeframeKey) => void;
  onOpenAnalyser: (symbol: string, tf: TimeframeKey) => void;
  /** The best currently-valid setups from the central ranking engine. */
  rankedSetups: ManagedRankedSetup[];
  /** How many valid setups exist in total (may exceed the displayed list). */
  activeSetupCount: number;
  /** RUN SCAN — request the latest ranking. Never restarts the background scanner. */
  onRunScan: () => void;
  isValidating: boolean;
  lastRankedAt: number | null;
  /** Open a ranked setup in the shared chart. */
  onOpenSetup: (setup: ManagedRankedSetup) => void;
  /** The centralized Signal Quality Filter configuration (shown in the Filter panel). */
  filterConfig: SignalFilterConfig;
  /** Update the filter configuration. */
  onFilterConfigChange: (config: Partial<SignalFilterConfig>) => void;
  /** Accepted setups from the centralized filter for this pass. */
  filterAccepted: FilteredSignal[];
  /** Rejected setups (with short reasons) — kept internal, shown only in the Filter panel. */
  filterRejected: FilteredSignal[];
  /** The central multi-market ranking result (final opportunities + rejection reasons). */
  central: CentralRankingResult | null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SNAP_MARGIN = 12;
const MIN_W = 300;
const MIN_H = 260;

function clampBox(box: Box): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(box.w, MIN_W), Math.max(MIN_W, vw - SNAP_MARGIN * 2));
  const h = Math.min(Math.max(box.h, MIN_H), Math.max(MIN_H, vh - 100));
  const x = Math.min(Math.max(box.x, SNAP_MARGIN), Math.max(SNAP_MARGIN, vw - w - SNAP_MARGIN));
  const y = Math.min(Math.max(box.y, SNAP_MARGIN), Math.max(SNAP_MARGIN, vh - h - 72));
  return { x, y, w, h };
}

function relativeTime(ms: number | null): string {
  if (ms === null) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

function scoreTone(score: number): string {
  if (score >= 92) return 'text-[#089981]';
  if (score >= 85) return 'text-teal';
  if (score >= 75) return 'text-warn';
  return 'text-muted';
}

function statusStyle(status: ManagedRankedSetup['status']): string {
  if (status === 'COMPLETED') return 'bg-[#089981]/12 text-[#089981] border-[#089981]/30';
  if (status === 'INVALIDATED') return 'bg-[#f23645]/12 text-[#f23645] border-[#f23645]/30';
  return 'bg-accent/12 text-accent border-accent/30';
}

/**
 * FLOATING SCANNER — the final signal display. It reads PRE-ANALYSED, ranked setups from
 * the central ranking engine (never running analysis itself) and shows only the best
 * currently valid opportunities across every market and every AI module. RUN SCAN merely
 * requests the latest ranking — it never restarts the background market scanner.
 *
 * A second tab keeps the original live market monitor list available.
 */
export function FloatingScanner({
  open,
  onClose,
  monitorSummary,
  markets,
  timeframe,
  livePrice,
  selectedSymbol,
  onOpenMarket,
  onOpenAnalyser,
  rankedSetups,
  activeSetupCount,
  onRunScan,
  isValidating,
  lastRankedAt,
  onOpenSetup,
  filterConfig,
  onFilterConfigChange,
  filterAccepted,
  filterRejected,
  central,
}: FloatingScannerProps) {
  const [box, setBox] = useState<Box>(() => ({
    x: typeof window === 'undefined' ? 40 : Math.max(SNAP_MARGIN, window.innerWidth - 380),
    y: typeof window === 'undefined' ? 120 : Math.max(SNAP_MARGIN, window.innerHeight - 520),
    w: 352,
    h: 460,
  }));
  const [minimized, setMinimized] = useState(false);
  const [tab, setTab] = useState<ScannerTab>('setups');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('volatility');
  const [oneSecOnly, setOneSecOnly] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const onResize = () => setBox((b) => clampBox(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const snap = useCallback((next: Box): Box => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const centerX = next.x + next.w / 2;
    const centerY = next.y + next.h / 2;
    const snapped = { ...next };
    if (centerX < vw / 2) snapped.x = SNAP_MARGIN;
    else snapped.x = vw - next.w - SNAP_MARGIN;
    if (centerY < vh / 2) snapped.y = SNAP_MARGIN + 56;
    else snapped.y = vh - next.h - 72;
    return clampBox(snapped);
  }, []);

  const onPointerDownDrag = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { dx: e.clientX - box.x, dy: e.clientY - box.y };
  };
  const onPointerMoveDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setBox(clampBox({ ...box, x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy }));
  };
  const onPointerUpDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setBox((b) => snap(b));
  };

  const onPointerDownResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { x: e.clientX, y: e.clientY, w: box.w, h: box.h };
  };
  const onPointerMoveResize = (e: React.PointerEvent) => {
    const start = resizeRef.current;
    if (!start) return;
    setBox(
      clampBox({
        ...box,
        w: start.w + (e.clientX - start.x),
        h: start.h + (e.clientY - start.y),
      })
    );
  };
  const onPointerUpResize = () => {
    resizeRef.current = null;
  };

  const rows = useMemo(() => {
    const readings = monitorSummary?.readings ?? [];
    const marketBySymbol = new Map(markets.map((m) => [m.symbol, m]));
    const list = readings
      .map((r) => {
        const market = marketBySymbol.get(r.symbol);
        return { ...r, market, isOneSecond: market ? isOneSecondVolatility(market) : false };
      })
      .filter((r) => r.market && isVolatilityIndex(r.market))
      .filter((r) => (oneSecOnly ? r.isOneSecond : true))
      .filter((r) =>
        query.trim() === ''
          ? true
          : `${r.displayName} ${r.symbol}`.toLowerCase().includes(query.trim().toLowerCase())
      );
    list.sort((a, b) => {
      if (sortKey === 'name') return a.displayName.localeCompare(b.displayName);
      if (sortKey === 'change')
        return Math.abs(b.lastCandleChangePercent ?? 0) - Math.abs(a.lastCandleChangePercent ?? 0);
      return (b.volatilityPercent ?? 0) - (a.volatilityPercent ?? 0);
    });
    return list;
  }, [monitorSummary, markets, oneSecOnly, query, sortKey]);

  if (!open) return null;

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  return (
    <section
      aria-label="Floating scanner"
      data-testid="floating-scanner"
      className={
        isMobile
          ? 'fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-line bg-nav shadow-2xl'
          : 'fixed z-30 rounded-xl border border-line bg-nav shadow-2xl'
      }
      style={
        isMobile
          ? { maxHeight: minimized ? 52 : '72dvh' }
          : { left: box.x, top: box.y, width: box.w, height: minimized ? 52 : box.h }
      }
    >
      {/* Header (drag handle) */}
      <header
        onPointerDown={isMobile ? undefined : onPointerDownDrag}
        onPointerMove={isMobile ? undefined : onPointerMoveDrag}
        onPointerUp={isMobile ? undefined : onPointerUpDrag}
        onDoubleClick={() => setBox((b) => snap(b))}
        className={`flex items-center gap-2 px-3 h-12 border-b border-line ${isMobile ? '' : 'cursor-grab active:cursor-grabbing'}`}
      >
        {!isMobile && <GripHorizontal className="w-4 h-4 text-faint shrink-0" aria-hidden="true" />}
        <Radar className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-ink truncate">Setup Ranking</span>
        <span className="text-[11px] font-medium text-faint">
          {tab === 'setups'
            ? `${rankedSetups.length}/${activeSetupCount} valid`
            : tab === 'filter'
              ? `${filterAccepted.length} passed · ${filterRejected.length} filtered`
              : `${rows.length} markets`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            aria-label={minimized ? 'Restore scanner' : 'Minimize scanner'}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-ink hover:bg-elevated cursor-pointer"
          >
            {minimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close scanner"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-bear hover:bg-red-500/10 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {!minimized && (
        <>
          {/* Tabs + RUN SCAN */}
          <div className="flex items-center gap-1 px-2 pt-2">
            <div className="inline-flex items-center gap-0.5 p-0.5 bg-elevated border border-line rounded-lg">
              <button
                type="button"
                onClick={() => setTab('setups')}
                aria-pressed={tab === 'setups'}
                className={`h-7 px-2.5 rounded-md text-[12px] font-semibold cursor-pointer ${
                  tab === 'setups' ? 'bg-accent text-white' : 'text-muted hover:text-ink'
                }`}
              >
                Top Setups
              </button>
              <button
                type="button"
                onClick={() => setTab('filter')}
                aria-pressed={tab === 'filter'}
                data-testid="floating-tab-filter"
                className={`h-7 px-2.5 rounded-md text-[12px] font-semibold cursor-pointer ${
                  tab === 'filter' ? 'bg-accent text-white' : 'text-muted hover:text-ink'
                }`}
              >
                Filter
              </button>
              <button
                type="button"
                onClick={() => setTab('markets')}
                aria-pressed={tab === 'markets'}
                className={`h-7 px-2.5 rounded-md text-[12px] font-semibold cursor-pointer ${
                  tab === 'markets' ? 'bg-accent text-white' : 'text-muted hover:text-ink'
                }`}
              >
                Markets
              </button>
            </div>
            <button
              type="button"
              onClick={onRunScan}
              disabled={isValidating}
              data-testid="floating-run-scan"
              className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-accent text-white text-[12px] font-bold hover:bg-accent-soft active:scale-[0.98] disabled:opacity-60 transition-all cursor-pointer"
            >
              {isValidating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="w-3 h-3 fill-current" aria-hidden="true" />
              )}
              RUN SCAN
            </button>
          </div>

          {tab === 'setups' ? (
            <div
              className="overflow-y-auto px-2 pt-2 pb-3"
              style={{ height: isMobile ? undefined : box.h - 108, maxHeight: isMobile ? '60dvh' : undefined }}
            >
              <div className="flex items-center justify-between px-1 pb-1.5 text-[11px] text-faint">
                <span>Top {rankedSetups.length} overall — ranked across all markets &amp; AIs</span>
                <span>updated {relativeTime(lastRankedAt)}</span>
              </div>
              {rankedSetups.length === 0 ? (
                <p className="px-3 py-8 text-center text-[12px] text-faint leading-snug">
                  {activeSetupCount === 0
                    ? 'No valid setup right now. The background scanner is still analysing every market — this list fills automatically.'
                    : 'All valid setups are above the display gate.'}
                </p>
              ) : (
                <ol className="space-y-2">
                  {rankedSetups.map((setup, index) => (
                    <li key={setup.key}>
                      <button
                        type="button"
                        onClick={() => onOpenSetup(setup)}
                        data-testid={`ranked-setup-${index}`}
                        className="w-full text-left rounded-xl border border-line bg-panel hover:border-accent/40 transition-colors p-2.5 cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-accent/12 text-accent text-[12px] font-bold shrink-0">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold text-ink truncate">
                              {setup.displayName}
                            </span>
                            <span className="block text-[11px] text-faint truncate">
                              {RANK_LABELS[index] ?? `#${index + 1}`} · {setup.sourceLabel} · {familyLabel(setup.marketFamily)}
                            </span>
                          </span>
                          <span
                            className={`shrink-0 px-1.5 py-0.5 rounded text-[11px] font-bold border ${
                              setup.direction === 'RISE'
                                ? 'bg-[#089981]/12 text-[#089981] border-[#089981]/30'
                                : 'bg-[#f23645]/12 text-[#f23645] border-[#f23645]/30'
                            }`}
                          >
                            {setup.direction}
                          </span>
                          <span className={`shrink-0 text-[13px] font-extrabold tabular-nums ${scoreTone(setup.score)}`}>
                            {setup.score}
                          </span>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums">
                          <span className="flex justify-between gap-2">
                            <span className="text-faint">Entry</span>
                            <span className="text-ink font-medium">
                              {setup.entryPrice === null ? '—' : formatPrice(setup.entryPrice, setup.precision)}
                            </span>
                          </span>
                          <span className="flex justify-between gap-2">
                            <span className="text-faint">SL</span>
                            <span className="text-[#f23645] font-medium">
                              {setup.stopLoss === null ? '—' : formatPrice(setup.stopLoss, setup.precision)}
                            </span>
                          </span>
                          <span className="flex justify-between gap-2">
                            <span className="text-faint">TP1</span>
                            <span className="text-[#089981] font-medium">
                              {setup.takeProfit1 === null ? '—' : formatPrice(setup.takeProfit1, setup.precision)}
                            </span>
                          </span>
                          <span className="flex justify-between gap-2">
                            <span className="text-faint">TP2</span>
                            <span className="text-[#089981] font-medium">
                              {setup.takeProfit2 === null ? '—' : formatPrice(setup.takeProfit2, setup.precision)}
                            </span>
                          </span>
                        </div>

                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-elevated border border-line text-[11px] font-semibold text-muted">
                            <Target className="w-3 h-3" aria-hidden="true" />
                            R:R {setup.riskRewardRatio === null ? '—' : setup.riskRewardRatio.toFixed(1)}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-elevated border border-line text-[11px] font-semibold text-muted">
                            {setup.timeframe}
                          </span>
                          {setup.entryModelLabel && (
                            <span
                              className="px-1.5 py-0.5 rounded bg-accent/12 border border-accent/30 text-[11px] font-semibold text-accent truncate max-w-[160px]"
                              title={setup.entryModelLabel}
                            >
                              {setup.entryModelLabel}
                            </span>
                          )}
                          <span
                            className={`ml-auto px-1.5 py-0.5 rounded border text-[11px] font-bold ${statusStyle(setup.status)}`}
                          >
                            {setup.status === 'ACTIVE' ? 'ACTIVE' : setup.status === 'COMPLETED' ? 'TP HIT' : 'STOPPED'}
                          </span>
                        </div>

                        {setup.reasons.length > 0 && (
                          <p className="mt-2 text-[11px] leading-snug text-muted line-clamp-2">
                            {setup.reasons.join(' · ')}
                          </p>
                        )}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-3 px-1 text-[11px] leading-snug text-faint">
                Score ranks setup quality only — it is not a guaranteed win probability.
              </p>
            </div>
          ) : tab === 'filter' ? (
            <div
              className="overflow-y-auto px-3 pt-2 pb-3 space-y-3"
              style={{ height: isMobile ? undefined : box.h - 108, maxHeight: isMobile ? '60dvh' : undefined }}
              data-testid="floating-filter-panel"
            >
              <div className="rounded-lg border border-line bg-panel p-2.5">
                <p className="text-[12px] font-semibold text-ink">Signal Quality Filter</p>
                <p className="mt-0.5 text-[11px] leading-snug text-faint">
                  One centralized gate sits between every AI strategy and the display. Each AI
                  submits its candidate setups here first; only accepted setups are published.
                </p>
                <div className="mt-2 flex items-center gap-2 text-[11px] font-semibold">
                  <span className="px-1.5 py-0.5 rounded bg-[#089981]/12 text-[#089981] border border-[#089981]/30">
                    {filterAccepted.length} accepted
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-[#f23645]/12 text-[#f23645] border border-[#f23645]/30">
                    {filterRejected.length} filtered
                  </span>
                </div>
              </div>

              <label className="block">
                <span className="flex items-center justify-between text-[11px] font-semibold text-muted">
                  <span>Minimum quality gate</span>
                  <span className="tabular-nums text-ink">{filterConfig.minQuality}/100</span>
                </span>
                <input
                  type="range"
                  min={60}
                  max={95}
                  step={1}
                  value={filterConfig.minQuality}
                  onChange={(e) => onFilterConfigChange({ minQuality: Number(e.target.value) })}
                  className="mt-1.5 w-full accent-[var(--color-accent)]"
                  data-testid="floating-filter-quality"
                />
              </label>

              <div className="space-y-1.5">
                {FILTER_TOGGLES.map((t) => (
                  <label
                    key={t.key}
                    className="flex items-start gap-2 rounded-lg border border-line bg-elevated px-2 py-1.5 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={filterConfig[t.key]}
                      onChange={(e) => onFilterConfigChange({ [t.key]: e.target.checked })}
                      className="mt-0.5 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[12px] font-semibold text-ink">{t.label}</span>
                      <span className="block text-[11px] leading-snug text-faint">{t.hint}</span>
                    </span>
                  </label>
                ))}
              </div>

              {filterRejected.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                    Filtered this pass
                  </p>
                  <ul className="mt-1 space-y-1">
                    {filterRejected.slice(0, 20).map((f) => (
                      <li
                        key={`${f.key}-${f.direction}`}
                        className="rounded-lg border border-line-soft bg-panel px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 text-[12px] font-medium text-ink truncate">
                            {f.displayName}
                          </span>
                          <span
                            className={`shrink-0 text-[11px] font-bold ${
                              f.direction === 'RISE' ? 'text-[#089981]' : 'text-[#f23645]'
                            }`}
                          >
                            {f.direction}
                          </span>
                          <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted">
                            {f.score}/100
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-faint">
                          {f.reasons.join(' · ') || 'Below the quality gate.'}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {filterRejected.length === 0 && (
                <p className="px-1 text-[11px] leading-snug text-faint">
                  Nothing filtered yet — run a scan or wait for the next ranking pass.
                </p>
              )}

              <div className="rounded-lg border border-line bg-panel p-2.5" data-testid="central-ranking-panel">
                <p className="text-[12px] font-semibold text-ink">Central multi-market ranking</p>
                <p className="mt-0.5 text-[11px] leading-snug text-faint">
                  One engine collects every AI's candidates, verifies freshness, removes
                  duplicates and conflicting directions, applies the index-specific Entry Model
                  AI validation, then ranks with validated performance.
                </p>
                <div className="mt-2 flex items-center gap-2 text-[11px] font-semibold">
                  <span className="px-1.5 py-0.5 rounded bg-accent/12 text-accent border border-accent/30">
                    {central ? central.ranked.length : 0} ranked
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-amber-500/12 text-warn border border-amber-500/30">
                    {central ? central.watchlist.length : 0} watching
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-[#f23645]/12 text-[#f23645] border border-[#f23645]/30">
                    {central ? central.rejected.length : 0} rejected
                  </span>
                  {central && (
                    <span className="text-faint">of {central.considered} considered</span>
                  )}
                </div>
                {central && central.watchlist.length > 0 && (
                  <ul className="mt-2 space-y-1" data-testid="central-watchlist">
                    {central.watchlist.slice(0, 10).map((w) => (
                      <li
                        key={`${w.candidate.key}-watch`}
                        className="rounded-lg border border-line-soft bg-elevated px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 text-[12px] font-medium text-ink truncate">
                            {w.candidate.displayName}
                          </span>
                          <span
                            className={`shrink-0 text-[11px] font-bold ${
                              w.candidate.direction === 'RISE' ? 'text-[#089981]' : 'text-[#f23645]'
                            }`}
                          >
                            {w.candidate.direction}
                          </span>
                          <span className="shrink-0 px-1 py-0.5 rounded bg-amber-500/10 text-warn text-[10px] font-bold">
                            WATCH {w.score.total}/100
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-faint">
                          Cleared quality and entry validation — tracked, not executable until it
                          enters the published top-N.
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {central && central.rejected.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {central.rejected.slice(0, 20).map((r) => (
                      <li
                        key={`${r.key}-${r.reason}`}
                        className="rounded-lg border border-line-soft bg-elevated px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 text-[12px] font-medium text-ink truncate">
                            {r.displayName}
                          </span>
                          <span className="shrink-0 px-1 py-0.5 rounded bg-[#f23645]/10 text-[#f23645] text-[10px] font-bold">
                            {r.reason.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-faint">{r.detail}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
                <div className="flex items-center gap-1.5 flex-1 min-w-0 h-8 px-2 rounded-lg bg-elevated border border-line">
                  <Search className="w-3.5 h-3.5 text-faint shrink-0" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter markets"
                    aria-label="Filter markets"
                    className="w-full bg-transparent text-[13px] text-ink placeholder:text-faint outline-none min-w-0"
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setSortKey((k) => (k === 'volatility' ? 'change' : k === 'change' ? 'name' : 'volatility'))
                  }
                  className="inline-flex items-center gap-1 h-8 px-2 rounded-lg bg-elevated border border-line text-[12px] font-medium text-muted hover:text-ink cursor-pointer"
                  title="Cycle sort order"
                >
                  <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                  {sortKey === 'volatility' ? 'Vol' : sortKey === 'change' ? 'Chg' : 'Name'}
                </button>
                <button
                  type="button"
                  onClick={() => setOneSecOnly((v) => !v)}
                  aria-pressed={oneSecOnly}
                  className={`h-8 px-2 rounded-lg border text-[12px] font-medium cursor-pointer ${
                    oneSecOnly ? 'bg-accent/10 text-accent border-accent/30' : 'bg-elevated text-muted border-line'
                  }`}
                  title="Show only 1-second indices"
                >
                  1s
                </button>
              </div>

              <div
                className="overflow-y-auto"
                style={{ height: isMobile ? undefined : box.h - 148, maxHeight: isMobile ? '56dvh' : undefined }}
              >
                {rows.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[12px] text-faint leading-snug">
                    {monitorSummary
                      ? 'No market matches the current filter.'
                      : 'Waiting for the background scanner to populate live readings.'}
                  </p>
                ) : (
                  <ul className="divide-y divide-line-soft">
                    {rows.map((r) => {
                      const isSelected = r.symbol === selectedSymbol;
                      const change = r.lastCandleChangePercent;
                      const price = isSelected && livePrice !== null ? livePrice : r.price;
                      return (
                        <li key={r.symbol}>
                          <button
                            type="button"
                            onClick={() => onOpenMarket(r.symbol, timeframe)}
                            onDoubleClick={() => onOpenAnalyser(r.symbol, timeframe)}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-elevated transition-colors cursor-pointer ${
                              isSelected ? 'bg-accent/8' : ''
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block text-[13px] font-medium text-ink truncate">
                                {r.displayName}
                              </span>
                              <span className="block text-[11px] text-faint">
                                {r.market ? marketFamilyLabel(r.market) : r.marketFamily}
                              </span>
                            </span>
                            <span className="text-right shrink-0">
                              <span className="block text-[13px] font-semibold text-ink tabular-nums">
                                {formatPrice(price, r.precision)}
                              </span>
                              <span
                                className={`block text-[11px] tabular-nums ${
                                  change === null || change === 0
                                    ? 'text-faint'
                                    : change > 0
                                      ? 'text-[#089981]'
                                      : 'text-[#f23645]'
                                }`}
                              >
                                {change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(2)}%`}
                              </span>
                            </span>
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                r.dataHealth === 'HEALTHY'
                                  ? 'bg-[#089981]'
                                  : r.dataHealth === 'STALE'
                                    ? 'bg-[#d97706]'
                                    : 'bg-[#f23645]'
                              }`}
                              title={r.dataHealth}
                              aria-label={`Data health ${r.dataHealth}`}
                            />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}

          {!isMobile && (
            <span
              onPointerDown={onPointerDownResize}
              onPointerMove={onPointerMoveResize}
              onPointerUp={onPointerUpResize}
              role="separator"
              aria-label="Resize scanner"
              className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize"
              style={{
                background:
                  'linear-gradient(135deg, transparent 0 50%, var(--color-line) 50% 60%, transparent 60% 70%, var(--color-line) 70% 80%, transparent 80%)',
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
