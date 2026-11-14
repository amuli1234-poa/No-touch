import React from 'react';
import { Activity, Gauge } from 'lucide-react';
import type { OpportunitySignal, TechnicalIndicatorsSnapshot } from '../../types/scanner';
import { Card, CardHeader, CardBody } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/StatCard';
import { formatNumber } from '../ui/format';
import type { Tone } from '../ui/format';

/**
 * Indicator read-out for the selected instrument.
 *
 * Every value here is computed by `TechnicalIndicatorsEngine` and carried on
 * the opportunity snapshot. Nothing is estimated: if no snapshot exists yet
 * (the multi-timeframe buffers are still filling) the panel says so instead of
 * showing placeholder numbers. These are WickSentinel's own calculations, not
 * TradingView indicators — the chart library renders price only.
 */

interface IndicatorPanelProps {
  opportunity?: OpportunitySignal;
}

const RSI_TONE: Record<TechnicalIndicatorsSnapshot['rsiState'], Tone> = {
  OVERSOLD: 'success',
  BULLISH: 'success',
  NEUTRAL: 'neutral',
  BEARISH: 'danger',
  OVERBOUGHT: 'danger'
};

const RSI_LABEL: Record<TechnicalIndicatorsSnapshot['rsiState'], string> = {
  OVERSOLD: 'Oversold',
  BULLISH: 'Bullish',
  NEUTRAL: 'Neutral',
  BEARISH: 'Bearish',
  OVERBOUGHT: 'Overbought'
};

const ADX_LABEL: Record<TechnicalIndicatorsSnapshot['adxRegime'], string> = {
  STRONG_TREND: 'Strong trend',
  TRENDING: 'Trending',
  WEAK_RANGING: 'Weak / ranging'
};

const BB_LABEL: Record<TechnicalIndicatorsSnapshot['bbPosition'], string> = {
  UPPER_BAND: 'Upper band',
  LOWER_BAND: 'Lower band',
  MID_ZONE: 'Mid zone'
};

interface Row {
  label: string;
  value: string;
  tone?: Tone;
  detail?: string;
}

export const IndicatorPanel: React.FC<IndicatorPanelProps> = ({ opportunity }) => {
  const ind = opportunity?.indicators;

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader
        title="Indicators"
        subtitle="WickSentinel calculations"
        icon={<Gauge className="h-4 w-4" />}
      />
      <CardBody className="pt-0">
        {!ind ? (
          <EmptyState
            icon={<Gauge className="h-5 w-5" />}
            title="No indicator snapshot yet"
            description="RSI, ADX, EMA and Bollinger values appear once the multi-timeframe buffers have filled."
          />
        ) : (
          <div className="space-y-4">
            {/* RSI — the headline momentum read. */}
            <div className="rounded-[var(--radius-md)] border border-line-soft bg-surface-deep px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-5">
                  <Activity className="h-3.5 w-3.5" /> RSI 14
                </span>
                <Badge tone={RSI_TONE[ind.rsiState]}>{RSI_LABEL[ind.rsiState]}</Badge>
              </div>
              <div className="tabular mt-2 text-[22px] font-bold leading-none text-fg-1">
                {formatNumber(ind.rsi14, 1)}
              </div>
              <RsiScale value={ind.rsi14} />
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
              <Metric label="ADX 14" value={formatNumber(ind.adx14, 1)} detail={ADX_LABEL[ind.adxRegime]} />
              <Metric label="ATR 14" value={formatNumber(ind.atr14, 5)} detail="Volatility" />
              <Metric
                label="+DI / −DI"
                value={`${formatNumber(ind.plusDi, 1)} / ${formatNumber(ind.minusDi, 1)}`}
                detail={ind.plusDi >= ind.minusDi ? 'Buyers leading' : 'Sellers leading'}
              />
              <Metric
                label="EMA 20 / 50"
                value={`${formatNumber(ind.ema20, 3)} / ${formatNumber(ind.ema50, 3)}`}
                detail={ind.emaBias === 'BULLISH' ? 'Bullish bias' : ind.emaBias === 'BEARISH' ? 'Bearish bias' : 'Neutral bias'}
              />
              <Metric
                label="Bollinger"
                value={`${formatNumber(ind.bbLower, 3)} – ${formatNumber(ind.bbUpper, 3)}`}
                detail={BB_LABEL[ind.bbPosition]}
              />
              <Metric
                label="Momentum"
                value={opportunity.momentum.classification}
                detail={`Score ${formatNumber(opportunity.momentum.score, 0)}/100`}
              />
            </div>

            {ind.confirmationNotes.length > 0 && (
              <ul className="space-y-1 border-t border-line-soft pt-3">
                {ind.confirmationNotes.slice(0, 4).map((note, i) => (
                  <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-fg-4">
                    <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-accent-soft" />
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
};

/** A compact 0–100 gauge marking the RSI position against the 30/70 bands. */
const RsiScale: React.FC<{ value: number }> = ({ value }) => {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="mt-3">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
        <span className="absolute inset-y-0 left-[30%] w-[40%] bg-fg-7/25" />
        <span
          className="absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-1"
          style={{ left: `${clamped}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9.5px] text-fg-6">
        <span>0</span>
        <span>30</span>
        <span>70</span>
        <span>100</span>
      </div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; detail?: string }> = ({ label, value, detail }) => (
  <div className="min-w-0">
    <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-6">{label}</span>
    <span className="tabular mt-0.5 block truncate text-[12.5px] font-semibold text-fg-2">{value}</span>
    {detail && <span className="block truncate text-[10.5px] text-fg-5">{detail}</span>}
  </div>
);
