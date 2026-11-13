import React, { useEffect, useMemo, useState } from 'react';
import {
  ActiveSymbol,
  OpportunitySignal,
  StrategyId,
  StrategySetupCandidate
} from '../../types/scanner';
import { HistoryAnalyticsSummary, IndexedDbStorage } from '../../services/IndexedDbStorage';
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Clock,
  LineChart,
  Send,
  ShieldCheck,
  Filter
} from 'lucide-react';

interface StrategyScannerViewProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  isScanning: boolean;
  storage: IndexedDbStorage;
  historyRevision: number;
  onScanAll: () => void;
  onSelectSymbol: (symbol: string, goToTab?: 'LIVE_CHART' | 'ANALYSIS') => void;
  onSendWhatsApp?: (opp: OpportunitySignal) => void;
}

type ScannerMode = 'ALL_STRATEGIES' | 'BEST_MARKET';
type SetupStatusFilter = 'ALL' | 'CONFIRMED' | 'ACTIVE' | 'PENDING';

const STRATEGY_FILTER_OPTIONS: { id: 'ALL' | StrategyId; label: string }[] = [
  { id: 'ALL', label: 'All 6 Core Strategies' },
  { id: 'TRENDLINE_CONTINUATION', label: '1. Trendline Continuation' },
  { id: 'SR_BREAKOUT_RETEST', label: '2. Support & Resistance Breakout' },
  { id: 'CONSOLIDATION_BREAKOUT', label: '3. Consolidation Breakout' },
  { id: 'FLIP_SUPPORT_RESISTANCE', label: '4. Support & Resistance Reversal / Flip' },
  { id: 'SUPPLY_DEMAND_REACTION', label: '5. Supply & Demand' },
  { id: 'CHART_PATTERN', label: '6. Chart Pattern Recognition' }
];

interface FlattenedStrategySetup {
  key: string;
  symbol: string;
  displayName: string;
  is1s: boolean;
  pipSize: number;
  spotPrice: number;
  regimeLabel: string;
  opp: OpportunitySignal;
  setup: StrategySetupCandidate;
}

export const StrategyScannerView: React.FC<StrategyScannerViewProps> = ({
  symbols,
  opportunities,
  selectedSymbol,
  isScanning,
  storage,
  historyRevision,
  onScanAll,
  onSelectSymbol,
  onSendWhatsApp
}) => {
  const [scanMode, setScanMode] = useState<ScannerMode>('ALL_STRATEGIES');
  const [selectedStrategyFilter, setSelectedStrategyFilter] = useState<'ALL' | StrategyId>('ALL');
  const [statusFilter, setStatusFilter] = useState<SetupStatusFilter>('ALL');
  const [analytics, setAnalytics] = useState<HistoryAnalyticsSummary | null>(null);

  useEffect(() => {
    storage
      .computeHistoryAnalytics()
      .then(setAnalytics)
      .catch(() => {});
  }, [storage, historyRevision]);

  const oppList = useMemo(() => {
    const list = Array.from(opportunities.values());
    list.sort((a, b) => {
      const tw = (o: OpportunitySignal) =>
        o.setupTier === 'HIGH_QUALITY' ? 4 : o.setupTier === 'DEVELOPING' ? 3 : o.setupTier === 'WEAK' ? 2 : 1;
      const diff = tw(b) - tw(a);
      return diff !== 0 ? diff : b.score.total - a.score.total;
    });
    return list;
  }, [opportunities]);

  const bestMarketSymbol = useMemo(() => {
    if (oppList.length > 0) return oppList[0].symbol;
    return selectedSymbol;
  }, [oppList, selectedSymbol]);

  const allFlattened = useMemo((): FlattenedStrategySetup[] => {
    const items: FlattenedStrategySetup[] = [];
    const targetOpps =
      scanMode === 'BEST_MARKET'
        ? oppList.filter((o) => o.symbol === bestMarketSymbol)
        : oppList;

    for (const opp of targetOpps) {
      const symInfo = symbols.find((s) => s.symbol === opp.symbol);
      const setups = opp.strategySetups || [];
      for (const setup of setups) {
        if (setup.status === 'INACTIVE') continue;
        // Never force strategies outside their classified market condition unless confirmed
        if (!setup.regimePrioritized && setup.status !== 'CONFIRMED') continue;

        items.push({
          key: `${opp.symbol}_${setup.strategyId}`,
          symbol: opp.symbol,
          displayName: opp.displayName,
          is1s: opp.is1s,
          pipSize: opp.pipSize,
          spotPrice: symInfo?.lastQuote ?? opp.currentPrice,
          regimeLabel: opp.marketRegimeLabel || opp.marketCondition,
          opp,
          setup
        });
      }
    }

    return items.sort((a, b) => {
      const sw = (s: StrategySetupCandidate['status']) =>
        s === 'CONFIRMED' ? 3 : s === 'PENDING' ? 2 : 1;
      const diff = sw(b.setup.status) - sw(a.setup.status);
      if (diff !== 0) return diff;
      if (b.setup.regimePrioritized !== a.setup.regimePrioritized) {
        return b.setup.regimePrioritized ? 1 : -1;
      }
      return b.setup.confluenceScore - a.setup.confluenceScore;
    });
  }, [oppList, scanMode, bestMarketSymbol, symbols]);

  const filteredSetups = useMemo(() => {
    return allFlattened.filter((item) => {
      if (selectedStrategyFilter !== 'ALL' && item.setup.strategyId !== selectedStrategyFilter) {
        return false;
      }
      if (statusFilter === 'CONFIRMED') return item.setup.status === 'CONFIRMED';
      if (statusFilter === 'ACTIVE') {
        return item.setup.status === 'CONFIRMED' || item.opp.setupTier === 'DEVELOPING';
      }
      if (statusFilter === 'PENDING') return item.setup.status === 'PENDING';
      return true;
    });
  }, [allFlattened, selectedStrategyFilter, statusFilter]);

  const confirmedCount = allFlattened.filter((i) => i.setup.status === 'CONFIRMED').length;
  const activeCount = allFlattened.filter(
    (i) => i.setup.status === 'CONFIRMED' || i.opp.setupTier === 'DEVELOPING'
  ).length;
  const pendingCount = allFlattened.filter((i) => i.setup.status === 'PENDING').length;

  const topStat = analytics?.byStrategy[0];

  return (
    <div className="space-y-5">
      {/* Strategy Scanner Controls */}
      <section className="rounded-xl border border-line/90 bg-surface p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-fg-1 tracking-tight">
              Multi-Strategy Price Action Scanner
            </h2>
            <p className="text-xs text-fg-4 mt-0.5">
              Independent strategy evaluators share top-down H4 → H1 → M15 → M5 → M1 market structure and prioritize by live market regime.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Scan All Strategies vs Scan Best Market */}
            <div className="flex items-center p-1 bg-surface-deepest border border-line rounded-lg">
              <button
                onClick={() => setScanMode('ALL_STRATEGIES')}
                className={`px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md whitespace-nowrap transition ${
                  scanMode === 'ALL_STRATEGIES'
                    ? 'bg-accent text-fg-1'
                    : 'text-fg-4 hover:text-fg-1'
                }`}
              >
                Scan All Strategies
              </button>
              <button
                onClick={() => setScanMode('BEST_MARKET')}
                className={`px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md whitespace-nowrap transition ${
                  scanMode === 'BEST_MARKET'
                    ? 'bg-accent text-fg-1'
                    : 'text-fg-4 hover:text-fg-1'
                }`}
              >
                Scan Best Market ({bestMarketSymbol})
              </button>
            </div>

            <button
              onClick={onScanAll}
              disabled={isScanning}
              className="px-3.5 py-2 min-h-[38px] rounded-lg bg-surface-raised hover:bg-surface-elevated border border-line-strong text-xs font-semibold text-fg-1 flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-accent-soft' : ''}`} />
              <span>{isScanning ? 'Scanning Live Data...' : 'Scan Live Data'}</span>
            </button>
          </div>
        </div>

        {/* Individual Strategy Selector + Status Filters */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-line/70">
          <div className="flex items-center gap-2 min-w-[260px]">
            <Filter className="w-3.5 h-3.5 text-fg-4 shrink-0" />
            <label htmlFor="strategy-select" className="text-xs font-mono text-fg-4 whitespace-nowrap">
              Strategy:
            </label>
            <select
              id="strategy-select"
              value={selectedStrategyFilter}
              onChange={(e) => setSelectedStrategyFilter(e.target.value as 'ALL' | StrategyId)}
              className="bg-surface-deepest border border-line rounded-lg px-3 py-2 text-xs font-mono text-fg-1 focus:border-accent focus:outline-none max-w-[320px]"
            >
              {STRATEGY_FILTER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 bg-surface-deepest border border-line rounded-lg">
            {(
              [
                ['ALL', `All (${allFlattened.length})`],
                ['CONFIRMED', `Confirmed Signals (${confirmedCount})`],
                ['ACTIVE', `Active Setups (${activeCount})`],
                ['PENDING', `Pending Setups (${pendingCount})`]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setStatusFilter(id)}
                className={`px-3 py-1.5 min-h-[34px] text-xs font-mono rounded-md whitespace-nowrap transition ${
                  statusFilter === id
                    ? 'bg-surface-raised text-accent-cyan font-semibold'
                    : 'text-fg-4 hover:text-fg-1'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* KPI Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 font-mono tabular-nums">
        <div className="p-3.5 rounded-xl bg-surface border border-line/90">
          <span className="text-[11px] uppercase text-success block">Confirmed Signals (≥75%)</span>
          <span className="text-xl font-bold text-success mt-1 block">{confirmedCount}</span>
        </div>
        <div className="p-3.5 rounded-xl bg-surface border border-line/90">
          <span className="text-[11px] uppercase text-accent-soft block">Active Market Setups</span>
          <span className="text-xl font-bold text-fg-1 mt-1 block">{activeCount}</span>
        </div>
        <div className="p-3.5 rounded-xl bg-surface border border-line/90">
          <span className="text-[11px] uppercase text-warning block">Pending Setups</span>
          <span className="text-xl font-bold text-warning mt-1 block">{pendingCount}</span>
        </div>
        <div className="p-3.5 rounded-xl bg-surface border border-line/90">
          <span className="text-[11px] uppercase text-fg-4 block">Top Logged Strategy</span>
          <span className="text-sm font-bold text-fg-1 mt-1.5 block truncate">
            {topStat ? `${topStat.strategy} (${topStat.count})` : 'Awaiting logged signals'}
          </span>
        </div>
      </section>

      {/* Ranked Multi-Strategy Setups List */}
      <section className="rounded-xl border border-line/90 bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-line/80 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-2 font-mono">
            Ranked Strategy Setups ({filteredSetups.length})
          </h3>
          <span className="text-[11px] font-mono text-fg-4">
            Minimum 75% confluence + valid M15 range + closed M1 trigger required
          </span>
        </div>

        {filteredSetups.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <div className="text-sm font-bold font-mono text-warning">
              WAITING FOR SETUP
            </div>
            <p className="text-xs text-fg-4 max-w-lg mx-auto">
              No active strategy setup matches the selected market regime and filter criteria on live Deriv Volatility markets. No signals are ever forced.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line/70">
            {filteredSetups.map((item, idx) => {
              const { opp, setup } = item;
              const dec = item.pipSize < 0.01 ? 3 : 2;
              const isConfirmed = setup.status === 'CONFIRMED';
              const isBull = setup.direction === 'BULLISH';

              return (
                <div key={item.key} className="p-4 space-y-3 hover:bg-surface-deep/35 transition">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-bold text-fg-5 tabular-nums">
                          #{idx + 1}
                        </span>
                        <span className="text-sm font-bold text-fg-1">{item.displayName}</span>
                        <span className="text-fg-6">·</span>
                        <span className="font-mono text-fg-4">
                          {item.is1s ? 'Volatility 1s' : 'Plain Volatility'} · Spot{' '}
                          <strong className="text-fg-2 tabular-nums">
                            {item.spotPrice.toFixed(dec)}
                          </strong>
                        </span>
                        <span className="text-fg-6">·</span>
                        <span className="font-mono text-accent-cyan">{item.regimeLabel}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                        <span className="text-fg-3 font-semibold">{setup.category}</span>
                        <span className="text-fg-6">·</span>
                        <span className="text-fg-1 font-bold">{setup.label}</span>
                        <span className="text-fg-6">·</span>
                        <span
                          className={`inline-flex items-center gap-1 font-bold ${
                            isConfirmed
                              ? isBull
                                ? 'text-success'
                                : 'text-danger'
                              : 'text-warning'
                          }`}
                        >
                          {isConfirmed ? (
                            <>
                              {isBull ? (
                                <TrendingUp className="w-3.5 h-3.5" />
                              ) : (
                                <TrendingDown className="w-3.5 h-3.5" />
                              )}
                              <span>{setup.riseFallLabel}</span>
                            </>
                          ) : (
                            <span>WAITING FOR SETUP ({setup.direction})</span>
                          )}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 font-mono">
                      <div className="text-right mr-2 tabular-nums">
                        <div className="text-[10px] text-fg-5 uppercase">Confluence</div>
                        <div
                          className={`text-sm font-bold ${
                            setup.confluenceScore >= 75
                              ? 'text-success'
                              : setup.confluenceScore >= 60
                              ? 'text-warning'
                              : 'text-fg-4'
                          }`}
                        >
                          {setup.confluenceScore}%
                        </div>
                      </div>

                      <button
                        onClick={() => onSelectSymbol(item.symbol, 'LIVE_CHART')}
                        className="px-3 py-1.5 min-h-[36px] rounded-lg bg-surface-raised hover:bg-surface-elevated text-xs font-sans font-medium text-accent-cyan flex items-center gap-1 whitespace-nowrap"
                      >
                        <LineChart className="w-3.5 h-3.5" />
                        <span>Chart</span>
                      </button>

                      <button
                        onClick={() => onSelectSymbol(item.symbol, 'ANALYSIS')}
                        className="px-3 py-1.5 min-h-[36px] rounded-lg bg-accent/20 hover:bg-accent/30 border border-accent/40 text-xs font-sans font-medium text-accent-cyan whitespace-nowrap"
                      >
                        Analyze
                      </button>

                      {isConfirmed && onSendWhatsApp && (
                        <button
                          onClick={() => onSendWhatsApp(opp)}
                          className="px-3 py-1.5 min-h-[36px] rounded-lg bg-success hover:bg-success text-xs font-sans font-semibold text-fg-1 flex items-center gap-1 whitespace-nowrap"
                        >
                          <Send className="w-3 h-3" />
                          <span>WhatsApp</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Required Signal Output Details */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-2 border-t border-line/60 text-xs font-mono tabular-nums">
                    <div>
                      <span className="text-[10px] text-fg-5 block uppercase">Entry Price</span>
                      <strong className="text-accent-cyan">
                        {typeof setup.entryPrice === 'number' ? setup.entryPrice.toFixed(dec) : 'WAITING'}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[10px] text-fg-5 block uppercase">Stop Loss</span>
                      <strong className="text-danger">
                        {typeof setup.stopLoss === 'number' ? setup.stopLoss.toFixed(dec) : '—'}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[10px] text-fg-5 block uppercase">Take Profit</span>
                      <strong className="text-success">
                        {typeof setup.takeProfit === 'number' ? setup.takeProfit.toFixed(dec) : '—'}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[10px] text-fg-5 block uppercase">Reward : Risk</span>
                      <strong className="text-fg-1">
                        {setup.riskRewardRatio ? `${setup.riskRewardRatio} : 1` : '—'}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[10px] text-fg-5 block uppercase">Expected Hold</span>
                      <strong className="text-fg-2 font-sans text-[11px]">
                        {setup.expectedHoldingTime}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[10px] text-fg-5 block uppercase">Timeframes</span>
                      <strong className="text-fg-3 text-[11px]">
                        {setup.timeframesUsed.join(' · ')}
                      </strong>
                    </div>
                  </div>

                  <div className="text-xs text-fg-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div>
                        <span className="text-fg-4 font-mono text-[11px]">Confirmations: </span>
                        <span>
                          {setup.confirmationReasons.length > 0
                            ? setup.confirmationReasons.join(' · ')
                            : setup.entryCondition}
                        </span>
                      </div>
                      <div className="text-[11px] text-fg-4 font-mono">
                        Invalidation: {setup.invalidationCondition}
                        {!isConfirmed && setup.missingConditions.length > 0 && (
                          <span className="text-warning">
                            {' '}
                            · Awaiting: {setup.missingConditions.slice(0, 2).join(', ')}
                          </span>
                        )}
                      </div>
                    </div>
                    {isConfirmed && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-success font-semibold">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        Ready (Closed Trigger)
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Strategy Performance Statistics (Real IndexedDB Outcome Ledger) */}
      <section className="rounded-xl border border-line/90 bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-line/80 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-accent-soft" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-fg-2 font-mono">
              Live Strategy Performance Statistics
            </h3>
          </div>
          <span className="text-[11px] font-mono text-fg-5">
            Aggregated strictly from verified live Deriv signal outcomes
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
            <thead className="bg-surface-deepest text-[10px] uppercase text-fg-4 border-b border-line">
              <tr>
                <th className="p-3">Strategy</th>
                <th className="p-3 text-right">Signals</th>
                <th className="p-3 text-right">Active</th>
                <th className="p-3 text-right">TP Hit</th>
                <th className="p-3 text-right">Invalidated</th>
                <th className="p-3 text-right">Resolved Win %</th>
                <th className="p-3 text-right">Avg Confluence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60 text-fg-3">
              {!analytics || analytics.byStrategy.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-fg-5 font-sans">
                    No confirmed strategy signals recorded yet. Confirmed signals (≥75% confluence) and their live Deriv tick outcomes appear here automatically.
                  </td>
                </tr>
              ) : (
                analytics.byStrategy.map((row) => (
                  <tr key={row.strategy} className="hover:bg-surface-deep/50">
                    <td className="p-3 text-fg-1 font-sans font-medium">{row.strategy}</td>
                    <td className="p-3 text-right">{row.count}</td>
                    <td className="p-3 text-right text-warning">{row.active}</td>
                    <td className="p-3 text-right text-success">{row.tpHits}</td>
                    <td className="p-3 text-right text-danger">{row.invalidated}</td>
                    <td className="p-3 text-right font-bold text-accent-cyan">
                      {row.tpHits + row.invalidated > 0 ? `${row.winRatePct}%` : '—'}
                    </td>
                    <td className="p-3 text-right">{row.avgScore.toFixed(1)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
