import React, { useMemo } from 'react';
import { ActiveSymbol, OpportunitySignal, Timeframe } from '../../types/scanner';
import { InteractiveLightweightChart } from '../InteractiveLightweightChart';
import { OpportunityCard } from '../OpportunityCard';
import { Badge, Card, CardHeader, EmptyState, SectionTitle, Select, StatCard } from '../ui';
import { TONE_HEX, formatPrice, statusTone, STATUS_LABEL, biasTone } from '../ui/format';
import {
  Gauge,
  ArrowLeftRight,
  Waves,
  Boxes,
  ShieldHalf,
  TrendingUp,
  TrendingDown,
  Activity,
  Info
} from 'lucide-react';

interface AnalysisPageProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  selectedTimeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  activeCandles: import('../../types/scanner').Candle[];
}

const TIMEFRAMES: Timeframe[] = ['1m', '2m', '5m', '15m', '1h'];

export const AnalysisPage: React.FC<AnalysisPageProps> = ({
  symbols,
  opportunities,
  selectedSymbol,
  onSelectSymbol,
  selectedTimeframe,
  onTimeframeChange,
  activeCandles
}) => {
  const activeOpp = opportunities.get(selectedSymbol);
  const selectedMeta = symbols.find((s) => s.symbol === selectedSymbol);
  const price = selectedMeta?.lastQuote ?? activeOpp?.currentPrice ?? 0;

  const marketOptions = useMemo(
    () =>
      [...symbols]
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((s) => ({ value: s.symbol, label: s.displayName })),
    [symbols]
  );

  const DirectionIcon = activeOpp?.direction === 'BEARISH' ? TrendingDown : TrendingUp;

  return (
    <div className="space-y-5">
      <SectionTitle
        eyebrow="Deep dive"
        title="Market analysis workspace"
        description="Full multi-timeframe read: displacement, alignment, structure, liquidity and imbalance."
        actions={
          <div className="w-full sm:w-64">
            <Select
              aria-label="Select market"
              value={selectedSymbol}
              onChange={(e) => onSelectSymbol(e.target.value)}
              options={marketOptions}
            />
          </div>
        }
      />

      {/* Market overview strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Spot price"
          value={formatPrice(price)}
          hint={selectedMeta?.symbol ?? selectedSymbol}
          tone="info"
        />
        <StatCard
          label="Market bias"
          value={activeOpp?.direction ?? 'Neutral'}
          hint="2m / 5m directional"
          tone={activeOpp ? biasTone(activeOpp.direction) : 'neutral'}
          icon={<DirectionIcon className="h-4 w-4" />}
        />
        <StatCard
          label="Volatility"
          value={activeOpp?.volatilityRegime ?? '—'}
          hint={activeOpp ? `ATR ${activeOpp.atr.toFixed(3)}` : 'Awaiting scan'}
          tone={
            activeOpp?.volatilityRegime === 'HIGH'
              ? 'danger'
              : activeOpp?.volatilityRegime === 'MEDIUM'
                ? 'warning'
                : 'success'
          }
        />
        <StatCard
          label="Technical score"
          value={activeOpp ? `${activeOpp.score.total}` : '—'}
          hint="Weighted composite / 100"
          tone={activeOpp && activeOpp.score.total >= 90 ? 'success' : 'warning'}
          icon={<Gauge className="h-4 w-4" />}
        />
        <StatCard
          label="Status"
          value={activeOpp ? STATUS_LABEL[activeOpp.status] : 'Pending'}
          hint={activeOpp ? `Updated ${new Date(activeOpp.detectedEpoch * 1000).toLocaleTimeString()}` : 'Run a scan'}
          tone={activeOpp ? statusTone(activeOpp.status) : 'neutral'}
        />
      </div>

      {/* Large interactive chart */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold text-white">
            {selectedMeta?.displayName ?? selectedSymbol} · price action
          </h2>
          <div className="inline-flex items-center gap-0.5 rounded-[10px] border border-[#1e2b40] bg-[#0b1220] p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => onTimeframeChange(tf)}
                aria-pressed={selectedTimeframe === tf}
                className={`rounded-[8px] px-3 py-1 text-[11.5px] font-semibold transition-colors ${
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
          heightClass="h-[320px] sm:h-[420px] xl:h-[520px]"
        />
      </div>

      {/* Analysis grid */}
      {activeOpp ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <AnalysisCard
            icon={<ArrowLeftRight className="h-4 w-4" />}
            title="2m displacement analysis"
            badge={
              activeOpp.marketShift ? (
                <Badge tone={biasTone(activeOpp.marketShift.direction)}>
                  {activeOpp.marketShift.type}
                </Badge>
              ) : (
                <Badge>None</Badge>
              )
            }
          >
            <Row label="Break level" value={activeOpp.marketShift ? formatPrice(activeOpp.marketShift.brokenLevel) : '—'} />
            <Row
              label="Displacement score"
              value={activeOpp.marketShift ? `${(activeOpp.marketShift.displacementScore * 100).toFixed(0)}%` : '—'}
            />
            <Row
              label="Close confirmed"
              value={activeOpp.marketShift ? (activeOpp.marketShift.confirmedByClose ? 'Yes' : 'No') : '—'}
            />
            <Row
              label="Reversal candle"
              value={
                activeOpp.reversalPattern && activeOpp.reversalPattern.name !== 'NONE'
                  ? activeOpp.reversalPattern.name.replace(/_/g, ' ')
                  : 'None'
              }
            />
          </AnalysisCard>

          <AnalysisCard
            icon={<Waves className="h-4 w-4" />}
            title="5m alignment analysis"
            badge={
              <Badge tone={activeOpp.score.structureAlignment === 20 ? 'success' : 'warning'}>
                {activeOpp.score.structureAlignment === 20 ? 'Aligned' : 'Divergent'}
              </Badge>
            }
          >
            <Row
              label="Alignment score"
              value={`${activeOpp.score.structureAlignment} / 20`}
              tone={activeOpp.score.structureAlignment === 20 ? 'success' : 'warning'}
            />
            <Row label="Directional context" value={activeOpp.direction} />
            <Row label="Volatility regime" value={activeOpp.volatilityRegime} />
            <Row label="ATR (14)" value={activeOpp.atr.toFixed(4)} />
          </AnalysisCard>

          <AnalysisCard
            icon={<Boxes className="h-4 w-4" />}
            title="Fair value gap & imbalance"
            badge={
              activeOpp.activeFvg ? (
                <Badge tone={activeOpp.activeFvg.fresh ? 'accent' : 'neutral'}>
                  {activeOpp.activeFvg.fresh ? 'Fresh' : `${activeOpp.activeFvg.fillPercentage}% mitigated`}
                </Badge>
              ) : (
                <Badge>None</Badge>
              )
            }
          >
            <Row
              label="Boundaries"
              value={
                activeOpp.activeFvg
                  ? `${formatPrice(activeOpp.activeFvg.lowerBoundary)} – ${formatPrice(activeOpp.activeFvg.upperBoundary)}`
                  : '—'
              }
            />
            <Row label="Midpoint" value={activeOpp.activeFvg ? formatPrice(activeOpp.activeFvg.midpoint) : '—'} />
            <Row
              label="Gap size"
              value={activeOpp.activeFvg ? `${activeOpp.activeFvg.sizePercent.toFixed(3)}%` : '—'}
            />
            <Row
              label="Score"
              value={`${activeOpp.score.fvgAndDisplacement} / 15`}
              tone={activeOpp.score.fvgAndDisplacement > 0 ? 'accent' : 'neutral'}
            />
          </AnalysisCard>

          <AnalysisCard
            icon={<Activity className="h-4 w-4" />}
            title="Liquidity sweep"
            badge={
              activeOpp.sweptPool ? (
                <Badge tone="warning">{activeOpp.sweptPool.type}</Badge>
              ) : (
                <Badge>None</Badge>
              )
            }
          >
            <Row
              label="Swept level"
              value={activeOpp.sweptPool ? formatPrice(activeOpp.sweptPool.priceLevel) : '—'}
            />
            <Row label="Type" value={activeOpp.sweptPool?.type ?? '—'} />
            <Row
              label="Sweep score"
              value={`${activeOpp.score.liquidityAndProtectedSwing} / 15`}
              tone={activeOpp.score.liquidityAndProtectedSwing > 0 ? 'warning' : 'neutral'}
            />
            <Row label="Structural shift" value={activeOpp.marketShift?.type ?? 'None'} />
          </AnalysisCard>

          <AnalysisCard
            icon={<ShieldHalf className="h-4 w-4" />}
            title="Protected swing & retracement"
            badge={
              activeOpp.tradeableRange ? (
                <Badge tone={activeOpp.tradeableRange.isRetracementValid ? 'success' : 'danger'}>
                  {activeOpp.tradeableRange.isRetracementValid ? 'Valid' : 'Invalid'}
                </Badge>
              ) : (
                <Badge>None</Badge>
              )
            }
          >
            <Row
              label="Protected swing"
              value={activeOpp.tradeableRange ? formatPrice(activeOpp.tradeableRange.newlyProtectedSwing) : '—'}
              tone="warning"
            />
            <Row
              label="Adaptive target"
              value={activeOpp.tradeableRange ? formatPrice(activeOpp.tradeableRange.adaptiveFillTarget) : '—'}
              tone="info"
            />
            <Row label="Fill depth" value={activeOpp.tradeableRange?.fillDepthType ?? '—'} />
            <Row
              label="Range distance"
              value={activeOpp.tradeableRange ? activeOpp.tradeableRange.rangeDistance.toFixed(2) : '—'}
            />
          </AnalysisCard>

          <AnalysisCard
            icon={<Gauge className="h-4 w-4" />}
            title="Technical score breakdown"
            badge={<Badge tone={activeOpp.score.total >= 90 ? 'success' : 'warning'}>{activeOpp.score.total} / 100</Badge>}
          >
            <ScoreRow label="Alignment" value={activeOpp.score.structureAlignment} max={20} tone="accent" />
            <ScoreRow label="Sweep" value={activeOpp.score.liquidityAndProtectedSwing} max={15} tone="warning" />
            <ScoreRow label="Candle" value={activeOpp.score.candlestickConfirmation} max={10} tone="success" />
            <ScoreRow label="Shift" value={activeOpp.score.confirmedMarketShift} max={15} tone="accent" />
            <ScoreRow label="FVG" value={activeOpp.score.fvgAndDisplacement} max={15} tone="info" />
            <ScoreRow label="Range" value={activeOpp.score.tradeableRangeAndRetracement} max={15} tone="info" />
            <ScoreRow label="Survival" value={activeOpp.score.barrierSurvival} max={10} tone="danger" />
          </AnalysisCard>
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<Info className="h-5 w-5" />}
            title="No analysis available for this market"
            description="Run a scan or select a market that has produced a structural read. Analysis populates as candles stream in."
          />
        </Card>
      )}

      {activeOpp && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            Opportunity detail
          </h3>
          <OpportunityCard opp={activeOpp} onSelectMarket={onSelectSymbol} isSelected />
        </div>
      )}
    </div>
  );
};

const AnalysisCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, badge, children }) => (
  <Card className="flex flex-col">
    <CardHeader icon={icon} title={title} actions={badge} />
    <div className="space-y-2 p-4">{children}</div>
  </Card>
);

const Row: React.FC<{ label: string; value: React.ReactNode; tone?: keyof typeof TONE_HEX }> = ({
  label,
  value,
  tone
}) => (
  <div className="flex items-center justify-between gap-3 text-[12px]">
    <span className="text-slate-500">{label}</span>
    <span
      className="tabular truncate font-semibold"
      style={{ color: tone ? TONE_HEX[tone] : '#E2E8F0' }}
    >
      {value}
    </span>
  </div>
);

const ScoreRow: React.FC<{
  label: string;
  value: number;
  max: number;
  tone: keyof typeof TONE_HEX;
}> = ({ label, value, max, tone }) => (
  <div className="flex items-center gap-2 text-[11.5px]">
    <span className="w-20 shrink-0 text-slate-500">{label}</span>
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#0b1220]">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${(value / max) * 100}%`, backgroundColor: TONE_HEX[tone] }}
      />
    </div>
    <span className="tabular w-12 shrink-0 text-right font-semibold text-slate-300">
      {value}/{max}
    </span>
  </div>
);
