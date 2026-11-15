import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  GripHorizontal,
  Maximize2,
  Minus,
  Search,
  X,
} from 'lucide-react';
import type { MonitorScanSummary } from '../types/scanner';
import type { SyntheticMarket, TimeframeKey } from '../types/market';
import { formatPrice } from '../utils/derivParser';
import { isOneSecondVolatility, isVolatilityIndex } from '../utils/volatilityMarkets';

type SortKey = 'volatility' | 'change' | 'name';

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

/**
 * FLOATING MULTI-MARKET SCANNER — a draggable, resizable, minimizable panel that lists every
 * eligible market with its latest reading and opens the selection in the ONE shared chart.
 * It renders no chart of its own and never overlaps the chart toolbar at its default position.
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
}: FloatingScannerProps) {
  const [box, setBox] = useState<Box>(() => ({
    x: typeof window === 'undefined' ? 40 : Math.max(SNAP_MARGIN, window.innerWidth - 380),
    y: typeof window === 'undefined' ? 120 : Math.max(SNAP_MARGIN, window.innerHeight - 520),
    w: 352,
    h: 420,
  }));
  const [minimized, setMinimized] = useState(false);
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
  const onPointerUpDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setBox((b) => snap(b));
    void e;
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
      aria-label="Floating multi-market scanner"
      data-testid="floating-scanner"
      className={
        isMobile
          ? 'fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-line bg-nav shadow-2xl'
          : 'fixed z-30 rounded-xl border border-line bg-nav shadow-2xl'
      }
      style={isMobile ? { maxHeight: minimized ? 48 : '62dvh' } : { left: box.x, top: box.y, width: box.w, height: minimized ? 48 : box.h }}
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
        <span className="text-[13px] font-semibold text-ink truncate">Floating Scanner</span>
        <span className="text-[10px] font-medium text-faint">{rows.length} markets</span>
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
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <div className="flex items-center gap-1.5 flex-1 min-w-0 h-8 px-2 rounded-lg bg-elevated border border-line">
              <Search className="w-3.5 h-3.5 text-faint shrink-0" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter markets"
                aria-label="Filter markets"
                className="w-full bg-transparent text-[12px] text-ink placeholder:text-faint outline-none min-w-0"
              />
            </div>
            <button
              type="button"
              onClick={() =>
                setSortKey((k) => (k === 'volatility' ? 'change' : k === 'change' ? 'name' : 'volatility'))
              }
              className="inline-flex items-center gap-1 h-8 px-2 rounded-lg bg-elevated border border-line text-[11px] font-medium text-muted hover:text-ink cursor-pointer"
              title="Cycle sort order"
            >
              <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
              {sortKey === 'volatility' ? 'Vol' : sortKey === 'change' ? 'Chg' : 'Name'}
            </button>
            <button
              type="button"
              onClick={() => setOneSecOnly((v) => !v)}
              aria-pressed={oneSecOnly}
              className={`h-8 px-2 rounded-lg border text-[11px] font-medium cursor-pointer ${
                oneSecOnly ? 'bg-accent/10 text-accent border-accent/30' : 'bg-elevated text-muted border-line'
              }`}
              title="Show only 1-second indices"
            >
              1s
            </button>
          </div>

          <div className="overflow-y-auto" style={{ height: isMobile ? undefined : box.h - 100, maxHeight: isMobile ? '52dvh' : undefined }}>
            {rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11px] text-faint leading-snug">
                {monitorSummary
                  ? 'No market matches the current filter.'
                  : 'Run the Market Scanner to populate live market readings.'}
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
                          <span className="block text-[12px] font-medium text-ink truncate">
                            {r.displayName}
                          </span>
                          <span className="block text-[10px] text-faint">
                            {r.market?.family === 'VOLATILITY' ? 'Volatility' : r.market?.family}
                            {r.isOneSecond ? ' · 1s' : ''}
                          </span>
                        </span>
                        <span className="text-right shrink-0">
                          <span className="block text-[12px] font-semibold text-ink tabular-nums">
                            {formatPrice(price, r.precision)}
                          </span>
                          <span
                            className={`block text-[10px] tabular-nums ${
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
