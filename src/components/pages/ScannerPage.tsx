import React, { useMemo, useState } from 'react';
import { ActiveSymbol, OpportunitySignal, Timeframe } from '../../types/scanner';
import { ActiveObservedContract } from '../../services/PathSettlementTracker';
import { LiveMarketScannerTable, ScannerFilter } from '../LiveMarketScannerTable';
import { InteractiveLightweightChart } from '../InteractiveLightweightChart';
import { OpportunityCard } from '../OpportunityCard';
import { Card, CardHeader, SectionTitle, StatCard, Badge, EmptyState, StatusDot } from '../ui';
import { TONE_HEX } from '../ui/format';
import {
  Layers,
  ShieldCheck,
  GitCompareArrows,
  CircleSlash,
  Clock,
  Sparkles,
  LineChart as LineChartIcon,
  Activity
} from 'lucide-react';

interface ScannerPageProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  activeMonitored: ActiveObservedContract[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  filterMode: ScannerFilter;
  onFilterChange: (mode: ScannerFilter) => void;
  selectedTimeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  activeCandles: import('../../types/scanner').Candle[];
  isScanning: boolean;
  lastScanTimestamp: number;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  onOpenAnalysis: (symbol: string) => void;
  density: 'comfortable' | 'compact';
}

const TIMEFRAMES: Timeframe[] = ['1m', '2m', '5m', '15m', '1h'];

export const ScannerPage: React.FC<ScannerPageProps> = ({
  symbols,
  opportunities,
  activeMonitored,
  selectedSymbol,
  onSelectSymbol,
  filterMode,
  onFilterChange,
  selectedTimeframe,
  onTimeframeChange,
  activeCandles,
  isScanning,
  lastScanTimestamp,
  connectionState,
  onOpenAnalysis,
  density
}) => {
  const [inspecting, setInspecting] = useState(false);

  const oppList = useMemo(() => Array.from(opportunities.values()), [opportunities]);
  const qualified = useMemo(
    () => oppList.filter((o) => o.status === 'QUALIFIED').length,
    [oppList]
  );
  const aligned = useMemo(
    () => oppList.filter((o) => o.score.structureAlignment === 20).length,
    [oppList]
  );
  const rejected = useMemo(
    () => oppList.filter((o) => o.status === 'REJECTED').length,
    [oppList]
  );

  const activeOpp = opportunities.get(selectedSymbol);
  const selectedMeta = symbols.find((s) => s.symbol === selectedSymbol);

  const showInspector = activeOpp && (inspecting || activeOpp.status === 'QUALIFIED');

  return (
    <div className="space-y-5">
      <SectionTitle
        eyebrow="Live workspace"
        title="Scanner overview"
        description="Continuous qualification across Deriv synthetic indices using the 2m displacement / 5m alignment model."
        actions={
          <div className="hidden items-center gap-2 rounded-[10px] border border-[#162133] bg-[#0d1420] px-3 py-1.5 md:flex">
            <StatusDot
              tone={connectionState === 'CONNECTED' ? 'success' : connectionState === 'RECONNECTING' ? 'warning' : 'danger'}
              pulse={connectionState === 'CONNECTED'}
              label={connectionState === 'CONNECTED' ? 'Streaming live' : connectionState}
            />
          </div>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Total markets"
          value={symbols.length}
          hint="Active synthetic indices"
          tone="neutral"
          icon={<Layers className="h-4 w-4" />}
        />
        <StatCard
          label="Qualified"
          value={qualified}
          hint="All mandatory gates passed"
          tone="success"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <StatCard
          label="Aligned"
          value={aligned}
          hint="5m bias matches 2m structure"
          tone="info"
          icon={<GitCompareArrows className="h-4 w-4" />}
        />
        <StatCard
          label="Rejected setups"
          value={rejected}
          hint="Failed mandatory criteria"
          tone="danger"
          icon={<CircleSlash className="h-4 w-4" />}
        />
        <StatCard
          label="Last scan"
          value={
            lastScanTimestamp
              ? new Date(lastScanTimestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })
              : '—'
          }
          hint={isScanning ? 'Scanning in progress…' : `Feed ${connectionState.toLowerCase()}`}
          tone={connectionState === 'CONNECTED' ? 'info' : 'warning'}
          icon={<Clock className="h-4 w-4" />}
        />
      </div>

      {/* In-flight monitored contracts */}
      {activeMonitored.length > 0 && (
        <Card variant="raised" className="overflow-hidden">
          <CardHeader
            icon={<Sparkles className="h-4 w-4 text-sky-400" />}
            title={`Live path monitor · ${activeMonitored.length} in-flight contract${activeMonitored.length > 1 ? 's' : ''}`}
            subtitle="Verifying continuous excursion survival against the live tick stream"
            actions={<Badge tone="info" dot>Live</Badge>}
          />
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {activeMonitored.map((c) => {
              const remaining = Math.max(0, c.expiryEpoch - Math.floor(Date.now() / 1000));
              const lost = c.hasTouched;
              return (
                <div
                  key={c.id}
                  className={`rounded-[10px] border px-3 py-2.5 ${
                    lost
                      ? 'border-rose-500/30 bg-rose-500/[0.06]'
                      : 'border-[#1e2b40] bg-[#0a1018]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] font-semibold text-slate-100">
                      {c.displayName}
                    </span>
                    <Badge tone={lost ? 'danger' : 'success'} dot>
                      {lost ? 'Touched' : 'Surviving'}
                    </Badge>
                  </div>
                  <div className="tabular mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <span>
                      Barrier{' '}
                      <span className="text-slate-200">{c.barrierLevel.toFixed(3)}</span>
                    </span>
                    <span className="text-right">
                      Distance{' '}
                      <span className="text-slate-200">{c.currentDistance.toFixed(3)}</span>
                    </span>
                    <span>
                      Expiry <span className="text-slate-200">{remaining}s</span>
                    </span>
                    <span className="text-right" style={{ color: TONE_HEX.info }}>
                      ${c.payout.toFixed(2)} payout
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Scanner table */}
      <LiveMarketScannerTable
        symbols={symbols}
        opportunities={opportunities}
        selectedSymbol={selectedSymbol}
        onSelectSymbol={(sym) => {
          onSelectSymbol(sym);
          setInspecting(false);
        }}
        filterMode={filterMode}
        onFilterChange={onFilterChange}
        isScanning={isScanning}
        connectionState={connectionState}
        density={density}
      />

      {/* Chart workspace + signal detail */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="min-w-0 space-y-4 xl:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <LineChartIcon className="h-4 w-4 text-[#2E8AD8]" />
              <h2 className="text-[13px] font-semibold text-white">Chart workspace</h2>
              <span className="text-[11px] text-slate-500">
                {selectedMeta?.displayName ?? selectedSymbol} · 2m primary / 5m confirmation
              </span>
            </div>
            <div className="inline-flex items-center gap-0.5 rounded-[10px] border border-[#1e2b40] bg-[#0b1220] p-0.5">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => onTimeframeChange(tf)}
                  aria-pressed={selectedTimeframe === tf}
                  className={`rounded-[8px] px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                    selectedTimeframe === tf
                      ? 'bg-[#0068B5] text-white'
                      : 'text-slate-400 hover:bg-[#121b2b] hover:text-slate-100'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          <InteractiveLightweightChart
            candles={activeCandles}
            symbol={selectedSymbol}
            displayName={selectedMeta?.displayName}
            timeframe={selectedTimeframe}
            fvg={activeOpp?.activeFvg}
            tradeableRange={activeOpp?.tradeableRange}
            barrier={activeOpp?.barrierProposal}
            structuralShift={activeOpp?.marketShift}
            sweptPool={activeOpp?.sweptPool}
          />

          {activeOpp && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Target market opportunity analysis
                </h3>
                <button
                  onClick={() => setInspecting((v) => !v)}
                  className="text-[11.5px] font-medium text-[#60A5FA] hover:text-[#2E8AD8]"
                >
                  {inspecting ? 'Hide detail' : 'Show detail'}
                </button>
              </div>
              {showInspector && (
                <OpportunityCard
                  opp={activeOpp}
                  onSelectMarket={onSelectSymbol}
                  onInspectChart={onOpenAnalysis}
                  isSelected
                />
              )}
            </div>
          )}
        </div>

        {/* Market context rail */}
        <aside className="min-w-0 space-y-4 xl:col-span-4">
          <Card>
            <CardHeader
              icon={<Activity className="h-4 w-4" />}
              title="Market context"
              subtitle="Deriv synthetic indices"
              actions={
                <StatusDot
                  tone={connectionState === 'CONNECTED' ? 'success' : connectionState === 'RECONNECTING' ? 'warning' : 'danger'}
                  pulse={connectionState === 'CONNECTED'}
                />
              }
            />
            <div className="grid grid-cols-2 gap-2 p-4">
              <ContextCell
                label="5m alignment"
                value={
                  activeOpp
                    ? activeOpp.score.structureAlignment === 20
                      ? 'Aligned'
                      : 'Divergent'
                    : 'Awaiting data'
                }
              />
              <ContextCell
                label="2m shift"
                value={activeOpp?.marketShift ? activeOpp.marketShift.type : 'None'}
              />
              <ContextCell
                label="Liquidity sweep"
                value={
                  activeOpp?.sweptPool
                    ? `${activeOpp.sweptPool.type === 'SELLSIDE' ? 'Sell-side' : 'Buy-side'} swept`
                    : 'Not detected'
                }
              />
              <ContextCell
                label="Fair value gap"
                value={
                  activeOpp?.activeFvg
                    ? activeOpp.activeFvg.fresh
                      ? 'Fresh'
                      : 'Mitigated'
                    : 'Not detected'
                }
              />
            </div>
            {activeOpp ? (
              <div className="border-t border-[#1e2b40] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                    Current setup
                  </span>
                  <span className="tabular text-[13px] font-semibold text-[#60A5FA]">
                    {activeOpp.score.total}/100
                  </span>
                </div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-slate-400">
                  {activeOpp.explanation}
                </p>
              </div>
            ) : (
              <EmptyState
                className="border-t border-[#1e2b40]"
                icon={<Activity className="h-5 w-5" />}
                title="No active analysis"
                description="Select a market from the scanner to inspect its structural context."
              />
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
};

const ContextCell: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-[10px] border border-[#162133] bg-[#0a1018] px-3 py-2.5">
    <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
      {label}
    </div>
    <div className="mt-1 truncate text-[12.5px] font-semibold text-slate-100">{value}</div>
  </div>
);
