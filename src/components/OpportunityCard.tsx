import React, { useState } from 'react';
import { OpportunitySignal } from '../types/scanner';
import {
  ShieldCheck,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  Info,
  Clock,
  Target,
  Zap,
  CircleSlash,
  Crosshair
} from 'lucide-react';
import { Badge, Card, SegmentedBar, Tone } from './ui';
import {
  STATUS_LABEL,
  biasTone,
  formatPrice,
  scoreTone,
  statusTone,
  TONE_HEX,
  volatilityTone
} from './ui/format';

interface OpportunityCardProps {
  opp: OpportunitySignal;
  onSelectMarket: (symbol: string) => void;
  onInspectChart?: (symbol: string) => void;
  isSelected: boolean;
}

interface MetricProps {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
}

const Metric: React.FC<MetricProps> = ({ label, value, tone }) => (
  <div className="rounded-[10px] border border-[#1E293B] bg-[#0B1120] px-3 py-2">
    <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
      {label}
    </div>
    <div
      className="tabular mt-1 truncate text-[13px] font-semibold"
      style={{ color: tone ? TONE_HEX[tone] : '#E2E8F0' }}
    >
      {value}
    </div>
  </div>
);

const SCORE_ROWS: {
  key: keyof OpportunitySignal['score'];
  label: string;
  max: number;
  tone: Tone;
}[] = [
  { key: 'structureAlignment', label: 'Alignment', max: 20, tone: 'accent' },
  { key: 'liquidityAndProtectedSwing', label: 'Sweep', max: 15, tone: 'warning' },
  { key: 'candlestickConfirmation', label: 'Candle', max: 10, tone: 'success' },
  { key: 'confirmedMarketShift', label: 'Shift', max: 15, tone: 'accent' },
  { key: 'fvgAndDisplacement', label: 'FVG', max: 15, tone: 'info' },
  { key: 'tradeableRangeAndRetracement', label: 'Range', max: 15, tone: 'info' },
  { key: 'barrierSurvival', label: 'Survival', max: 10, tone: 'danger' }
];

export const OpportunityCard: React.FC<OpportunityCardProps> = ({
  opp,
  onSelectMarket,
  onInspectChart,
  isSelected
}) => {
  const [openSection, setOpenSection] = useState<string | null>(null);
  const toggle = (key: string) => setOpenSection((cur) => (cur === key ? null : key));

  const isBullish = opp.direction === 'BULLISH';
  const tone = statusTone(opp.status);
  const aligned = opp.score.structureAlignment === 20;
  const mandatoryFailures = opp.rejectionReasons.filter((r) =>
    r.toLowerCase().includes('mandatory')
  );

  const segments = SCORE_ROWS.map((row) => ({
    value: (opp.score[row.key] as number) / 2, // scaled so each row contributes ~half its weight visually
    tone: row.tone,
    label: `${row.label}: ${opp.score[row.key]}/${row.max}`
  }));

  const StatusIcon =
    opp.status === 'QUALIFIED'
      ? ShieldCheck
      : opp.status === 'WATCHLIST'
        ? Zap
        : opp.status === 'WAITING' || opp.status === 'DATA_UNAVAILABLE'
          ? Info
          : opp.status === 'REJECTED' || opp.status === 'INVALIDATED'
            ? CircleSlash
            : ShieldAlert;

  return (
    <Card
      variant={isSelected ? 'elevated' : 'default'}
      className={`overflow-hidden transition-colors ${
        isSelected ? 'border-[#635BFF]/40' : ''
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#273449] px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => onSelectMarket(opp.symbol)}
              className="text-[15px] font-bold tracking-tight text-white transition-colors hover:text-[#A5A0FF]"
            >
              {opp.displayName}
            </button>
            <Badge tone={opp.is1s ? 'accent' : 'neutral'}>
              {opp.is1s ? '1-Second' : 'Standard'}
            </Badge>
            <Badge tone={biasTone(opp.direction)} icon={isBullish ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}>
              {opp.direction}
            </Badge>
          </div>
          <div className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slate-400">
            <span>
              Spot <span className="font-semibold text-slate-200">{formatPrice(opp.currentPrice)}</span>
            </span>
            <span className="text-slate-600">•</span>
            <span>
              Volatility{' '}
              <span className="font-semibold" style={{ color: TONE_HEX[volatilityTone(opp.volatilityRegime)] }}>
                {opp.volatilityRegime}
              </span>
            </span>
            <span className="text-slate-600">•</span>
            <span>
              ATR <span className="font-semibold text-slate-200">{opp.atr.toFixed(3)}</span>
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={scoreTone(opp.score.total)}>{opp.score.total} / 100</Badge>
          <Badge tone={tone} icon={<StatusIcon className="h-3 w-3" />}>
            {STATUS_LABEL[opp.status]}
          </Badge>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {/* Key metrics grid */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric
            label="5m Alignment"
            value={aligned ? 'Aligned' : 'Divergent'}
            tone={aligned ? 'success' : 'neutral'}
          />
          <Metric
            label="2m Structure"
            value={opp.marketShift ? `${opp.marketShift.type}` : 'No shift'}
            tone={opp.marketShift ? biasTone(opp.marketShift.direction) : 'neutral'}
          />
          <Metric
            label="Protected Swing"
            value={opp.tradeableRange ? formatPrice(opp.tradeableRange.newlyProtectedSwing) : '—'}
            tone="warning"
          />
          <Metric
            label="FVG Status"
            value={
              opp.activeFvg
                ? opp.activeFvg.fresh
                  ? 'Fresh'
                  : `${opp.activeFvg.fillPercentage}% mitigated`
                : 'None'
            }
            tone={opp.activeFvg ? 'accent' : 'neutral'}
          />
        </div>

        {/* Contract proposal */}
        {opp.barrierProposal ? (
          <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-[#273449] bg-[#0B1120] p-3 sm:grid-cols-4">
            <Metric label="Contract" value={`No Touch (${opp.barrierProposal.direction})`} tone="accent" />
            <Metric
              label="Barrier"
              value={`${formatPrice(opp.barrierProposal.barrierLevel)} (${opp.barrierProposal.barrier})`}
              tone="danger"
            />
            <Metric
              label="Path survival"
              value={`${(opp.barrierProposal.pathSurvivalProb * 100).toFixed(1)}%`}
              tone="success"
            />
            <Metric
              label="Payout"
              value={`$${opp.barrierProposal.payout.toFixed(2)}`}
              tone="info"
            />
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-[10px] border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-[11.5px] text-amber-300/90">
            <Info className="h-4 w-4 shrink-0" />
            <span>
              No economically viable No Touch barrier currently meets the minimum expectation threshold.
            </span>
          </div>
        )}

        {/* Tradeable range detail */}
        {opp.tradeableRange && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Metric
              label="Adaptive retracement target"
              value={formatPrice(opp.tradeableRange.adaptiveFillTarget)}
              tone="info"
            />
            <Metric
              label="Displacement break level"
              value={formatPrice(opp.tradeableRange.displacementBreakLevel)}
            />
            <Metric
              label="Range distance"
              value={`${opp.tradeableRange.rangeDistance.toFixed(2)} pts · ${opp.tradeableRange.fillDepthType}`}
            />
          </div>
        )}

        {/* Technical scoring engine */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-slate-400">Technical scoring engine</span>
            <span className="tabular font-semibold text-[#A5A0FF]">{opp.score.total} / 100</span>
          </div>
          <SegmentedBar segments={segments} height={8} />
          <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 pt-1 sm:grid-cols-4">
            {SCORE_ROWS.map((row) => {
              const val = opp.score[row.key] as number;
              return (
                <div key={row.label} className="flex items-center justify-between gap-2 text-[10.5px]">
                  <span className="text-slate-500">{row.label}</span>
                  <span
                    className="tabular font-semibold"
                    style={{ color: val > 0 ? TONE_HEX[row.tone] : '#475569' }}
                  >
                    {val}/{row.max}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Explanation */}
        <div className="rounded-[10px] border border-[#273449] bg-[#0B1120] px-3 py-2.5 text-[12px] leading-relaxed text-slate-300">
          {opp.explanation}
        </div>

        {/* Expandable disclosure sections */}
        <div className="divide-y divide-[#1E293B] overflow-hidden rounded-[10px] border border-[#273449]">
          {mandatoryFailures.length > 0 && (
            <Disclosure
              id="mandatory"
              label={`Mandatory requirement failures (${mandatoryFailures.length})`}
              tone="danger"
              open={openSection === 'mandatory'}
              onToggle={toggle}
            >
              <ul className="space-y-1.5">
                {mandatoryFailures.map((reason, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11.5px] text-slate-300">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          {opp.rejectionReasons.length > 0 && (
            <Disclosure
              id="rejections"
              label={`Rejection explanations (${opp.rejectionReasons.length})`}
              tone="warning"
              open={openSection === 'rejections'}
              onToggle={toggle}
            >
              <ul className="space-y-1.5">
                {opp.rejectionReasons.map((reason, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11.5px] text-slate-400">
                    <span className="mt-0.5 text-rose-400">✕</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          <Disclosure
            id="audit"
            label={`7-step sequence audit (${opp.stepAudit.filter((s) => s.passed).length}/${opp.stepAudit.length} passed)`}
            tone="accent"
            open={openSection === 'audit'}
            onToggle={toggle}
          >
            <div className="space-y-1.5">
              {opp.stepAudit.map((item) => (
                <div
                  key={item.step}
                  className="flex items-start justify-between gap-3 rounded-[8px] border border-[#1E293B] bg-[#0B1120] px-2.5 py-2"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                        item.passed
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-rose-500/15 text-rose-400'
                      }`}
                    >
                      {item.passed ? '✓' : '✗'}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-medium text-slate-200">
                        Step {item.step}: {item.name}
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-slate-500">{item.detail}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Disclosure>

          <Disclosure
            id="technical"
            label="Detailed technical analysis"
            tone="info"
            open={openSection === 'technical'}
            onToggle={toggle}
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Metric label="Volatility regime" value={opp.volatilityRegime} tone={volatilityTone(opp.volatilityRegime)} />
              <Metric label="ATR (14)" value={opp.atr.toFixed(4)} />
              <Metric
                label="Liquidity sweep"
                value={opp.sweptPool ? `${opp.sweptPool.type} @ ${opp.sweptPool.priceLevel.toFixed(3)}` : 'Not detected'}
                tone={opp.sweptPool ? 'warning' : 'neutral'}
              />
              <Metric
                label="Reversal pattern"
                value={opp.reversalPattern?.name && opp.reversalPattern.name !== 'NONE' ? opp.reversalPattern.name.replace(/_/g, ' ') : 'None'}
              />
              <Metric
                label="FVG boundaries"
                value={opp.activeFvg ? `${opp.activeFvg.lowerBoundary.toFixed(3)} – ${opp.activeFvg.upperBoundary.toFixed(3)}` : '—'}
              />
              <Metric
                label="Structural shift"
                value={opp.marketShift ? `${opp.marketShift.type} @ ${opp.marketShift.brokenLevel.toFixed(3)}` : 'None'}
                tone={opp.marketShift ? biasTone(opp.marketShift.direction) : 'neutral'}
              />
            </div>
          </Disclosure>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] text-slate-500">
            <Clock className="h-3 w-3" />
            <span className="tabular">
              Updated {new Date(opp.detectedEpoch * 1000).toLocaleTimeString()}
            </span>
          </div>
          <button
            onClick={() => (onInspectChart ?? onSelectMarket)(opp.symbol)}
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-[#635BFF]/40 bg-[#635BFF]/15 px-3 py-1.5 text-[12px] font-semibold text-[#A5A0FF] transition-colors hover:bg-[#635BFF]/25"
          >
            {onInspectChart ? <Crosshair className="h-3.5 w-3.5" /> : <Target className="h-3.5 w-3.5" />}
            Inspect on chart
          </button>
        </div>
      </div>
    </Card>
  );
};

interface DisclosureProps {
  id: string;
  label: string;
  tone: Tone;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

const Disclosure: React.FC<DisclosureProps> = ({ id, label, tone, open, onToggle, children }) => (
  <div className="bg-[#101829]">
    <button
      onClick={() => onToggle(id)}
      aria-expanded={open}
      className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-[#141D2F]"
    >
      <span className="flex items-center gap-2 text-[12px] font-medium text-slate-300">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TONE_HEX[tone] }} />
        {label}
      </span>
      <ChevronDown
        className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
      />
    </button>
    {open && <div className="animate-fade-in px-3.5 pb-3.5">{children}</div>}
  </div>
);
