import React, { useMemo, useState } from 'react';
import { ActiveSymbol, OpportunitySignal, OpportunityStatus } from '../types/scanner';
import {
  Search,
  ArrowUpDown,
  ShieldCheck,
  ShieldAlert,
  Zap,
  Inbox,
  WifiOff,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  TrendingDown
} from 'lucide-react';
import { Badge, Button, EmptyState, SkeletonRows, StatusDot } from './ui';
import { STATUS_LABEL, biasTone, formatPrice, scoreHex, scoreTone, statusTone } from './ui/format';

export type ScannerFilter = 'ALL' | 'STANDARD' | '1S' | 'QUALIFIED' | 'WATCHLIST';
type SortField = 'score' | 'symbol' | 'price';

interface LiveMarketScannerTableProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  filterMode: ScannerFilter;
  onFilterChange: (mode: ScannerFilter) => void;
  isScanning?: boolean;
  connectionState?: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  density?: 'comfortable' | 'compact';
}

const FILTERS: { value: ScannerFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'QUALIFIED', label: 'Qualified' },
  { value: 'WATCHLIST', label: 'Watchlist' },
  { value: 'STANDARD', label: 'Standard' },
  { value: '1S', label: '1-Second' }
];

const PAGE_SIZE = 12;

export const LiveMarketScannerTable: React.FC<LiveMarketScannerTableProps> = ({
  symbols,
  opportunities,
  selectedSymbol,
  onSelectSymbol,
  filterMode,
  onFilterChange,
  isScanning = false,
  connectionState = 'CONNECTED',
  density = 'comfortable'
}) => {
  const rowPad = density === 'compact' ? 'py-1.5' : 'py-2.5';
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('score');
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const rows = symbols.filter((sym) => {
      const opp = opportunities.get(sym.symbol);
      if (
        query &&
        !sym.displayName.toLowerCase().includes(query) &&
        !sym.symbol.toLowerCase().includes(query)
      ) {
        return false;
      }
      if (filterMode === 'STANDARD' && sym.is1s) return false;
      if (filterMode === '1S' && !sym.is1s) return false;
      if (filterMode === 'QUALIFIED' && opp?.status !== 'QUALIFIED') return false;
      if (filterMode === 'WATCHLIST' && opp?.status !== 'WATCHLIST') return false;
      return true;
    });

    const dir = sortAsc ? 1 : -1;
    return rows.sort((a, b) => {
      const oppA = opportunities.get(a.symbol);
      const oppB = opportunities.get(b.symbol);
      if (sortBy === 'score') {
        return dir * ((oppA?.score.total ?? 0) - (oppB?.score.total ?? 0));
      }
      if (sortBy === 'price') {
        const pA = a.lastQuote ?? oppA?.currentPrice ?? 0;
        const pB = b.lastQuote ?? oppB?.currentPrice ?? 0;
        return dir * (pA - pB);
      }
      return dir * a.displayName.localeCompare(b.displayName);
    });
  }, [symbols, opportunities, searchQuery, filterMode, sortBy, sortAsc]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(field);
      setSortAsc(field === 'symbol');
    }
  };

  const isOffline = connectionState === 'DISCONNECTED' && symbols.length === 0;

  const sortIndicator = (field: SortField) => (
    <ArrowUpDown className={`h-3 w-3 ${sortBy === field ? 'text-accent-strong' : 'text-fg-6'}`} />
  );

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-[var(--shadow-control)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-3.5 py-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-fg-1">Market scanner</div>
            <div className="text-[10.5px] text-fg-5">Live quotes · 2m structure · 5m context</div>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(0);
              }}
              placeholder="Search markets"
              aria-label="Search markets"
              className="h-8 w-40 rounded-[9px] border border-line bg-surface-deepest pl-8 pr-3 text-[12px] text-fg-2 placeholder:text-fg-6 transition-colors hover:border-line-strong focus:border-accent focus:outline-none sm:w-52"
            />
          </div>
          <span className="tabular text-[11px] text-fg-5">
            {filtered.length} / {symbols.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => {
            const active = filterMode === f.value;
            return (
              <button
                key={f.value}
                onClick={() => {
                  onFilterChange(f.value);
                  setPage(0);
                }}
                aria-pressed={active}
                className={`rounded-[8px] border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  active
                    ? 'border-accent/40 bg-accent/15 text-accent-soft'
                    : 'border-transparent text-fg-4 hover:bg-surface-raised hover:text-fg-2'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden min-w-0 md:block">
        <div className="max-h-[600px] overflow-auto">
          <table className="w-full min-w-[960px] border-collapse text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-surface-deepest text-[10px] uppercase tracking-[0.08em] text-fg-5">
              <tr className="border-b border-line">
                <th className="px-3 py-2.5 font-semibold">
                  <button
                    onClick={() => handleSort('symbol')}
                    className="inline-flex items-center gap-1.5 hover:text-fg-2"
                  >
                    Market {sortIndicator('symbol')}
                  </button>
                </th>
                <th className="px-3 py-2.5 text-right font-semibold">
                  <button
                    onClick={() => handleSort('price')}
                    className="inline-flex items-center gap-1.5 hover:text-fg-2"
                  >
                    Spot price {sortIndicator('price')}
                  </button>
                </th>
                <th className="px-3 py-2.5 font-semibold">5m Bias</th>
                <th className="px-3 py-2.5 font-semibold">2m Structure</th>
                <th className="px-3 py-2.5 font-semibold">Sweep</th>
                <th className="px-3 py-2.5 font-semibold">FVG Status</th>
                <th className="px-3 py-2.5 text-right font-semibold">Protected Swing</th>
                <th className="px-3 py-2.5 font-semibold">
                  <button
                    onClick={() => handleSort('score')}
                    className="inline-flex items-center gap-1.5 hover:text-fg-2"
                  >
                    Technical score {sortIndicator('score')}
                  </button>
                </th>
                <th className="px-3 py-2.5 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {isScanning && pageRows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <SkeletonRows rows={6} />
                  </td>
                </tr>
              )}

              {pageRows.map((sym) => {
                const opp = opportunities.get(sym.symbol);
                const selected = selectedSymbol === sym.symbol;
                const price = sym.lastQuote ?? opp?.currentPrice ?? 0;
                const status: OpportunityStatus = opp?.status ?? 'WAITING';
                const alignmentAligned = opp?.score.structureAlignment === 20;
                const shift = opp?.marketShift;

                return (
                  <tr
                    key={sym.symbol}
                    onClick={() => onSelectSymbol(sym.symbol)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSelectSymbol(sym.symbol);
                    }}
                    aria-selected={selected}
                    className={`cursor-pointer transition-colors ${
                      selected ? 'bg-accent/10' : 'hover:bg-surface-raised'
                    }`}
                  >
                    <td className={`px-3 ${rowPad}`}>
                      <div className="flex items-center gap-2">
                        <StatusDot
                          tone={
                            sym.isOpen && !sym.isStale
                              ? 'success'
                              : sym.isStale
                                ? 'warning'
                                : 'danger'
                          }
                        />
                        <span className="font-medium text-fg-1">{sym.displayName}</span>
                        {sym.is1s && (
                          <span className="rounded border border-accent/30 bg-accent/10 px-1 py-px text-[9px] font-bold text-accent-soft">
                            1s
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={`tabular px-3 ${rowPad} text-right font-medium text-fg-2`}>
                      {formatPrice(price)}
                    </td>
                    <td className={`px-3 ${rowPad}`}>
                      {opp ? (
                        <Badge tone={alignmentAligned ? 'success' : 'neutral'}>
                          {alignmentAligned ? 'Aligned' : 'Neutral'}
                        </Badge>
                      ) : (
                        <span className="text-fg-6">—</span>
                      )}
                    </td>
                    <td className={`px-3 ${rowPad}`}>
                      {shift ? (
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                            shift.direction === 'BULLISH' ? 'text-success' : 'text-danger'
                          }`}
                        >
                          {shift.direction === 'BULLISH' ? (
                            <TrendingUp className="h-3 w-3" />
                          ) : (
                            <TrendingDown className="h-3 w-3" />
                          )}
                          {shift.type}
                        </span>
                      ) : (
                        <span className="text-[11px] text-fg-5">Normal</span>
                      )}
                    </td>
                    <td className={`px-3 ${rowPad}`}>
                      {opp?.sweptPool ? (
                        <span className="text-[11px] font-medium text-warning">
                          {opp.sweptPool.type === 'SELLSIDE' ? 'SSL swept' : 'BSL swept'}
                        </span>
                      ) : (
                        <span className="text-[11px] text-fg-5">None</span>
                      )}
                    </td>
                    <td className={`px-3 ${rowPad}`}>
                      {opp?.activeFvg ? (
                        <span
                          className={`text-[11px] font-medium ${
                            opp.activeFvg.fresh ? 'text-accent-soft' : 'text-fg-4'
                          }`}
                        >
                          {opp.activeFvg.fresh
                            ? 'Fresh'
                            : `${opp.activeFvg.fillPercentage}% mitigated`}
                        </span>
                      ) : (
                        <span className="text-[11px] text-fg-5">None</span>
                      )}
                    </td>
                    <td className={`tabular px-3 ${rowPad} text-right text-fg-3`}>
                      {opp?.tradeableRange
                        ? formatPrice(opp.tradeableRange.newlyProtectedSwing, 2)
                        : '—'}
                    </td>
                    <td className={`px-3 ${rowPad}`}>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-deepest">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${opp?.score.total ?? 0}%`,
                              backgroundColor: scoreHex(opp?.score.total ?? 0)
                            }}
                          />
                        </div>
                        <span
                          className="tabular w-8 text-[11.5px] font-semibold"
                          style={{
                            color: scoreHex(opp?.score.total ?? 0)
                          }}
                        >
                          {opp ? opp.score.total : '—'}
                        </span>
                      </div>
                    </td>
                    <td className={`px-3 ${rowPad} text-right`}>
                      <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>
                    </td>
                  </tr>
                );
              })}

              {!isScanning && filtered.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    {isOffline ? (
                      <EmptyState
                        icon={<WifiOff className="h-5 w-5" />}
                        tone="danger"
                        title="Market feed unavailable"
                        description="The Deriv WebSocket feed is offline. The scanner repopulates automatically once the connection is restored."
                      />
                    ) : (
                      <EmptyState
                        icon={<Inbox className="h-5 w-5" />}
                        title="No markets match these filters"
                        description="Adjust the category filter or clear the search term to see more synthetic indices."
                        action={
                          <Button
                            size="sm"
                            onClick={() => {
                              setSearchQuery('');
                              onFilterChange('ALL');
                            }}
                          >
                            Reset filters
                          </Button>
                        }
                      />
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden">
        {isScanning && pageRows.length === 0 && <SkeletonRows rows={5} />}
        <div className="divide-y divide-line-soft">
          {pageRows.map((sym) => {
            const opp = opportunities.get(sym.symbol);
            const selected = selectedSymbol === sym.symbol;
            const price = sym.lastQuote ?? opp?.currentPrice ?? 0;
            const status: OpportunityStatus = opp?.status ?? 'WAITING';
            return (
              <button
                key={sym.symbol}
                onClick={() => onSelectSymbol(sym.symbol)}
                className={`w-full px-3.5 py-3 text-left transition-colors ${
                  selected ? 'bg-accent/10' : 'active:bg-surface-raised'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusDot
                      tone={
                        sym.isOpen && !sym.isStale ? 'success' : sym.isStale ? 'warning' : 'danger'
                      }
                    />
                    <span className="truncate text-[13px] font-semibold text-fg-1">
                      {sym.displayName}
                    </span>
                    {sym.is1s && (
                      <span className="rounded border border-accent/30 bg-accent/10 px-1 py-px text-[9px] font-bold text-accent-soft">
                        1s
                      </span>
                    )}
                  </div>
                  <span className="tabular shrink-0 text-[13px] font-semibold text-fg-1">
                    {formatPrice(price)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>
                  {opp && <Badge tone={scoreTone(opp.score.total)}>Score {opp.score.total}</Badge>}
                  {opp?.marketShift && (
                    <Badge tone={biasTone(opp.marketShift.direction)}>
                      {opp.marketShift.type} {opp.direction.slice(0, 4)}
                    </Badge>
                  )}
                  {opp?.sweptPool && <Badge tone="warning">Sweep</Badge>}
                  {opp?.activeFvg && (
                    <Badge tone="accent">
                      {opp.activeFvg.fresh ? 'Fresh FVG' : 'FVG mitigated'}
                    </Badge>
                  )}
                </div>
              </button>
            );
          })}

          {!isScanning && filtered.length === 0 && (
            <EmptyState
              icon={isOffline ? <WifiOff className="h-5 w-5" /> : <Inbox className="h-5 w-5" />}
              tone={isOffline ? 'danger' : 'neutral'}
              title={isOffline ? 'Market feed unavailable' : 'No markets match these filters'}
              description={
                isOffline
                  ? 'The scanner repopulates once the feed reconnects.'
                  : 'Adjust the filter or search term.'
              }
            />
          )}
        </div>
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-2.5 text-[11px] text-fg-4">
          <span className="tabular">
            Showing{' '}
            <span className="text-fg-2">
              {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)}
            </span>{' '}
            of <span className="text-fg-2">{filtered.length}</span> markets
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              icon={<ChevronLeft className="h-3.5 w-3.5" />}
            >
              Prev
            </Button>
            <span className="tabular px-1 text-fg-4">
              {safePage + 1} / {pageCount}
            </span>
            <Button
              size="sm"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line bg-surface-deep px-4 py-2 text-[10.5px] text-fg-5">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3 w-3 text-success" /> Qualified
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-warning" /> Watchlist
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ShieldAlert className="h-3 w-3 text-danger" /> Rejected
        </span>
        <span className="ml-auto hidden sm:inline">Click any row to load it in the chart workspace</span>
      </div>
    </div>
  );
};
