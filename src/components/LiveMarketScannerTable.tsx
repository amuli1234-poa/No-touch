import React, { useState } from 'react';
import { ActiveSymbol, OpportunitySignal } from '../types/scanner';
import { Search, ArrowUpDown, Filter, ShieldCheck, Zap } from 'lucide-react';

interface LiveMarketScannerTableProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  filterMode: 'ALL' | 'STANDARD' | '1S' | 'QUALIFIED' | 'WATCHLIST';
  onFilterChange: (mode: 'ALL' | 'STANDARD' | '1S' | 'QUALIFIED' | 'WATCHLIST') => void;
}

export const LiveMarketScannerTable: React.FC<LiveMarketScannerTableProps> = ({
  symbols,
  opportunities,
  selectedSymbol,
  onSelectSymbol,
  filterMode,
  onFilterChange
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'score' | 'symbol' | 'price'>('score');
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 12;

  const handleSort = (field: 'score' | 'symbol' | 'price') => {
    if (sortBy === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(field);
      setSortAsc(false);
    }
  };

  const filtered = symbols.filter((sym) => {
    const opp = opportunities.get(sym.symbol);

    // Search query filter
    if (
      searchQuery &&
      !sym.displayName.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !sym.symbol.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }

    // Category filter
    if (filterMode === 'STANDARD' && sym.is1s) return false;
    if (filterMode === '1S' && !sym.is1s) return false;
    if (filterMode === 'QUALIFIED' && opp?.status !== 'QUALIFIED') return false;
    if (filterMode === 'WATCHLIST' && opp?.status !== 'WATCHLIST') return false;

    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    const oppA = opportunities.get(a.symbol);
    const oppB = opportunities.get(b.symbol);

    if (sortBy === 'score') {
      const scoreA = oppA?.score.total || 0;
      const scoreB = oppB?.score.total || 0;
      return sortAsc ? scoreA - scoreB : scoreB - scoreA;
    }
    if (sortBy === 'price') {
      const pA = a.lastQuote || oppA?.currentPrice || 0;
      const pB = b.lastQuote || oppB?.currentPrice || 0;
      return sortAsc ? pA - pB : pB - pA;
    }
    return sortAsc
      ? a.displayName.localeCompare(b.displayName)
      : b.displayName.localeCompare(a.displayName);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="rounded-xl border border-slate-800/80 bg-[#101829] overflow-hidden flex flex-col shadow-sm min-w-0">
      {/* Table Header & Controls */}
      <div className="p-3.5 bg-slate-900/70 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-3">
          <div className="mr-2"><div className="text-sm font-semibold text-white">Live market scanner</div><div className="mt-0.5 text-[10px] text-slate-500">Live quotes · 2m structure · 5m context</div></div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search markets..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
              className="bg-slate-950/80 border border-slate-800 rounded-lg pl-8 pr-3 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-44 font-mono"
            />
          </div>

          <span className="text-[11px] text-slate-400 font-mono">
            {filtered.length} / {symbols.length} Markets
          </span>
        </div>

        {/* Filter Badges */}
        <div className="flex flex-wrap items-center gap-1">
          {(['ALL', 'STANDARD', '1S', 'QUALIFIED', 'WATCHLIST'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onFilterChange(mode)}
              className={`px-2 py-1 rounded text-[10px] font-mono font-semibold transition ${
                filterMode === mode
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20'
                  : 'bg-slate-950/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Table Area */}
        <div className="overflow-x-auto overflow-y-auto flex-1 max-h-[580px]">
        <table className="w-full min-w-[1120px] text-left border-collapse text-xs">
          <thead className="bg-slate-950/80 text-[10px] uppercase font-mono tracking-wider text-slate-400 sticky top-0 z-10 border-b border-slate-800/80 backdrop-blur">
            <tr>
              <th
                onClick={() => handleSort('symbol')}
                className="p-3 cursor-pointer hover:text-white"
              >
                <div className="flex items-center space-x-1">
                  <span>Market</span>
                  <ArrowUpDown className="w-3 h-3 text-slate-500" />
                </div>
              </th>
              <th
                onClick={() => handleSort('price')}
                className="p-3 cursor-pointer hover:text-white"
              >
                <div className="flex items-center space-x-1">
                  <span>Spot</span>
                  <ArrowUpDown className="w-3 h-3 text-slate-500" />
                </div>
              </th>
              <th className="p-3">5m Bias</th>
              <th className="p-3">2m Structure</th>
              <th className="p-3">Sweep</th>
              <th className="p-3">FVG Status</th>
              <th className="p-3">Protected Swing</th>
              <th
                onClick={() => handleSort('score')}
                className="p-3 cursor-pointer hover:text-white"
              >
                <div className="flex items-center space-x-1">
                  <span>Score</span>
                  <ArrowUpDown className="w-3 h-3 text-slate-500" />
                </div>
              </th>
              <th className="p-3 text-right">Status</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-800/50 font-mono text-xs">
            {pageRows.map((sym) => {
              const opp = opportunities.get(sym.symbol);
              const isSelected = selectedSymbol === sym.symbol;
              const price = sym.lastQuote || opp?.currentPrice || 0;

              return (
                <tr
                  key={sym.symbol}
                  onClick={() => onSelectSymbol(sym.symbol)}
                  className={`cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-indigo-950/40 text-white'
                      : 'hover:bg-slate-850/40 text-slate-300'
                  }`}
                >
                  {/* Market Name */}
                  <td className="p-3 font-sans font-medium">
                    <div className="flex items-center space-x-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          sym.isOpen && !sym.isStale
                            ? 'bg-emerald-500'
                            : sym.isStale
                            ? 'bg-amber-500'
                            : 'bg-rose-500'
                        }`}
                      />
                      <span className="font-semibold text-slate-100">{sym.displayName}</span>
                      {sym.is1s && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800/60 font-mono">
                          1s
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Spot Price */}
                  <td className="p-3 font-mono font-semibold text-slate-200">
                    {price > 0 ? price.toFixed(3) : '—'}
                  </td>

                  {/* 5m Direction */}
                  <td className="p-3 font-sans">
                    {opp ? (
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          opp.score.structureAlignment === 20
                            ? 'bg-emerald-950 text-emerald-400'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {opp.score.structureAlignment === 20 ? 'ALIGNED' : 'NEUTRAL'}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>

                  {/* 2m Structure */}
                  <td className="p-3 font-sans">
                    {opp?.marketShift ? (
                      <span
                        className={`text-[10px] font-bold ${
                          opp.marketShift.direction === 'BULLISH'
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {opp.marketShift.type} ({opp.marketShift.direction.slice(0, 4)})
                      </span>
                    ) : (
                      <span className="text-slate-500">Normal</span>
                    )}
                  </td>

                  {/* Liquidity Status */}
                  <td className="p-3">
                    {opp?.sweptPool ? (
                      <span className="text-[10px] font-mono text-amber-400">
                        {opp.sweptPool.type === 'SELLSIDE' ? 'SSL Swept' : 'BSL Swept'}
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[10px]">None</span>
                    )}
                  </td>

                  {/* FVG Status */}
                  <td className="p-3">
                    {opp?.activeFvg ? (
                      <span
                        className={`text-[10px] font-mono ${
                          opp.activeFvg.fresh ? 'text-indigo-400 font-semibold' : 'text-slate-400'
                        }`}
                      >
                        {opp.activeFvg.fresh ? 'Fresh FVG' : `${opp.activeFvg.fillPercentage}% Mit.`}
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[10px]">None</span>
                    )}
                  </td>

                  {/* Protected Swing */}
                  <td className="p-3 font-mono text-slate-400">
                    {opp?.tradeableRange ? opp.tradeableRange.newlyProtectedSwing.toFixed(2) : '—'}
                  </td>

                  {/* Quality Score */}
                  <td className="p-3">
                    <div className="flex items-center space-x-1.5">
                      <span
                        className={`font-bold font-mono text-xs ${
                          opp && opp.score.total >= 90
                            ? 'text-emerald-400'
                            : opp && opp.score.total >= 80
                            ? 'text-amber-400'
                            : 'text-slate-500'
                        }`}
                      >
                        {opp ? `${opp.score.total}%` : '—'}
                      </span>
                    </div>
                  </td>

                  {/* Opportunity Status */}
                  <td className="p-3 text-right">
                    {opp ? (
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-sans font-bold ${
                          opp.status === 'QUALIFIED'
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : opp.status === 'WATCHLIST'
                            ? 'bg-amber-950 text-amber-400 border border-amber-800'
                            : 'bg-slate-900 text-slate-500 border border-slate-800'
                        }`}
                      >
                        {opp.status}
                      </span>
                    ) : (
                      <span className="text-slate-600 text-[10px]">WAITING</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={9} className="p-12 text-center"><div className="text-sm font-semibold text-slate-200">No markets match these filters</div><div className="mt-1 text-xs text-slate-500">Try another category or search term.</div></td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 bg-slate-900/50 px-4 py-3 text-[11px] text-slate-400">
        <span>Showing {filtered.length ? page * pageSize + 1 : 0}–{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length} markets</span>
        <div className="flex items-center gap-2"><button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="rounded-md border border-slate-700 px-2.5 py-1.5 disabled:opacity-40 hover:bg-slate-800">Previous</button><span className="font-mono">{page + 1} / {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} className="rounded-md border border-slate-700 px-2.5 py-1.5 disabled:opacity-40 hover:bg-slate-800">Next</button></div>
      </div>
    </div>
  );
};
