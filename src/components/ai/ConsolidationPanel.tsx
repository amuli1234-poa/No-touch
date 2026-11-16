import { Gauge, Minimize2, Maximize2 } from 'lucide-react';
import type { AiInstrumentAnalysis } from '../../types/aiModule';
import type { ConsolidationRead } from '../../types/consolidation';
import { formatPrice } from '../../utils/derivParser';
import { CheckRow, SectionCard, StatTile, StatusPill } from '../ui/primitives';

/**
 * MARKET CONSOLIDATION & MOMENTUM AI — module panel.
 *
 * Renders the consolidation / compression detection (sideways, contraction, declining
 * volatility, repeated support-resistance, false breakouts), the independent bull/bear
 * momentum strengths, the expansion state and the breakout trade when one is approved.
 */

const CLASS_LABELS: Record<string, string> = {
  STRONG_BULLISH: 'Strong bullish',
  STRONG_BEARISH: 'Strong bearish',
  WEAK_MOMENTUM: 'Weak momentum',
  CONSOLIDATING: 'Consolidating',
  VOLATILITY_EXPANSION: 'Volatility expansion',
  UNCERTAIN: 'Uncertain',
  VOLATILITY_CONTRACTION: 'Volatility contraction',
  RANGING: 'Ranging',
};

const CLASS_STYLE: Record<string, string> = {
  STRONG_BULLISH: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  STRONG_BEARISH: 'bg-red-500/12 text-bear border-red-500/30',
  WEAK_MOMENTUM: 'bg-elevated text-muted border-line',
  CONSOLIDATING: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  VOLATILITY_EXPANSION: 'bg-amber-500/12 text-warn border-amber-500/30',
  VOLATILITY_CONTRACTION: 'bg-elevated text-muted border-line',
  UNCERTAIN: 'bg-panel text-faint border-line',
  RANGING: 'bg-elevated text-muted border-line',
};

const EXPANSION_LABELS: Record<string, string> = {
  NONE: 'None',
  BUILDING: 'Building',
  CONFIRMED: 'Confirmed',
  FADING: 'Fading',
};

function Bar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted">{label}</span>
        <span className="text-[12px] font-mono font-semibold text-ink">{Math.round(value)}/100</span>
      </div>
      <div className="h-1.5 rounded-full bg-elevated mt-1 overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function isConsolidationRead(value: AiInstrumentAnalysis['intelligence']): value is ConsolidationRead {
  return Boolean(value && 'classification' in value);
}

export function ConsolidationPanel({ analysis }: { analysis: AiInstrumentAnalysis }) {
  const read = isConsolidationRead(analysis.intelligence) ? analysis.intelligence : null;
  if (!read) {
    return (
      <SectionCard
        title="Consolidation & Momentum"
        subtitle="Compression detection and breakout / momentum read"
        icon={<Gauge className="w-3.5 h-3.5" aria-hidden="true" />}
      >
        <p className="text-[12px] text-faint py-2">
          {analysis.rejectionReason ?? 'No consolidation / momentum read for this instrument yet.'}
        </p>
      </SectionCard>
    );
  }

  const p = analysis.precision;
  const s = read.signals;

  return (
    <SectionCard
      title="Consolidation & Momentum"
      subtitle="Compression detection · breakout confirmation · momentum read"
      icon={<Gauge className="w-3.5 h-3.5" aria-hidden="true" />}
      right={
        <StatusPill
          label={CLASS_LABELS[read.classification] ?? read.classification}
          className={CLASS_STYLE[read.classification] ?? 'bg-elevated text-muted border-line'}
        />
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="Direction" value={read.direction ?? '—'} />
        <StatTile label="Expansion" value={EXPANSION_LABELS[read.expansion] ?? read.expansion} />
        <StatTile label="Consolidation" value={`${read.consolidationScore}/100`} />
        <StatTile label="Expansion pressure" value={`${read.expansionPressure}/100`} />
      </div>

      <div className="flex flex-col gap-2 mt-3">
        <Bar label="Bullish momentum" value={read.bullishMomentum} tone="bg-emerald-500" />
        <Bar label="Bearish momentum" value={read.bearishMomentum} tone="bg-red-500" />
      </div>

      <div className="flex flex-col gap-1 mt-3">
        <CheckRow label="Sideways / range-bound" ok={s.sideways} />
        <CheckRow label="Contained in a tight band" ok={s.consolidation} />
        <CheckRow label="Candle compression" ok={s.candleCompression} />
        <CheckRow label="Declining volatility" ok={s.decliningVolatility} />
        <CheckRow label="Repeated support / resistance" ok={s.repeatedSupportResistance} />
        <CheckRow label="Liquidity sweeps at edges" ok={s.liquiditySweeps} />
        <CheckRow label="False breakout detected" ok={s.falseBreakout} />
        <CheckRow label="Breakout approved" ok={read.breakoutApproved} />
      </div>

      <p className="text-[12px] text-muted leading-snug mt-3">
        <span className="text-faint">Confirmation: </span>
        {read.confirmationCondition}
      </p>
      <p className="text-[12px] text-muted leading-snug mt-1">
        <span className="text-faint">Invalidation: </span>
        {read.invalidationCondition}
        {read.invalidationLevel != null && (
          <span className="font-mono text-faint"> @ {formatPrice(read.invalidationLevel, p)}</span>
        )}
      </p>

      {read.trade ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <StatTile label="Entry" value={formatPrice(read.trade.entry, p)} />
          <StatTile label="Stop" value={formatPrice(read.trade.stop, p)} valueClass="text-bear" />
          <StatTile label="TP1" value={formatPrice(read.trade.tp1, p)} valueClass="text-emerald-400" />
          <StatTile label="R:R" value={read.trade.riskRewardRatio.toFixed(2)} />
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-3 text-[12px] text-faint">
          {read.genuineConsolidation ? (
            <>
              <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Coiling inside a range — awaiting a confirmed breakout.</span>
            </>
          ) : (
            <>
              <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>No approved breakout trade for this instrument.</span>
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
