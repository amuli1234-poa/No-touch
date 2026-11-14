import React from 'react';
import { BellRing, Clock, ShieldAlert, Target } from 'lucide-react';
import type { OpportunitySignal } from '../../types/scanner';
import { Card, CardHeader, CardBody } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { formatNumber, formatPrice } from '../ui/format';

/**
 * Scanner signal summary for the selected instrument.
 *
 * The distinction this panel must never blur: a **score** is the confluence
 * percentage, while a **confirmed** setup is one that also cleared every
 * mandatory gate. A setup can score highly and still be `WAIT`. When nothing
 * is confirmed the panel says so plainly rather than dressing up a developing
 * idea as a signal. There is no "confidence" figure in the engine, so none is
 * shown.
 */

interface SignalPanelProps {
  opportunity?: OpportunitySignal;
  pipSize: number;
  onOpenAnalysis?: () => void;
}

export const SignalPanel: React.FC<SignalPanelProps> = ({ opportunity, pipSize, onOpenAnalysis }) => {
  const digits = pipSize < 0.01 ? 3 : 2;

  if (!opportunity) {
    return (
      <Card className="overflow-hidden p-0">
        <CardHeader title="Scanner signal" subtitle="Live confluence" icon={<BellRing className="h-4 w-4" />} />
        <CardBody className="pt-0">
          <div className="rounded-[var(--radius-md)] border border-dashed border-line bg-surface-deep px-4 py-5 text-center">
            <p className="text-[12.5px] font-semibold text-fg-3">No signal for this market</p>
            <p className="mx-auto mt-1 max-w-[280px] text-[11.5px] leading-relaxed text-fg-5">
              Run a scan to evaluate this instrument, or wait for the next automatic pass.
            </p>
          </div>
        </CardBody>
      </Card>
    );
  }

  const confirmed = opportunity.entryAndTp.confirmed;
  const score = opportunity.score.total;

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader
        title="Scanner signal"
        subtitle={`Updated ${new Date(opportunity.detectedEpoch).toLocaleTimeString()}`}
        icon={<BellRing className="h-4 w-4" />}
      />
      <CardBody className="space-y-3.5 pt-0">
        {/* Direction / state headline. */}
        <div
          className={`rounded-[var(--radius-md)] border px-3.5 py-3 ${
            confirmed
              ? opportunity.direction === 'BULLISH'
                ? 'border-success/40 bg-success/10'
                : 'border-danger/40 bg-danger/10'
              : 'border-warning/40 bg-warning/10'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-5">
              {confirmed ? 'Confirmed setup' : 'Awaiting confirmation'}
            </span>
            <Badge tone={confirmed ? 'success' : 'warning'}>
              {confirmed ? opportunity.riseFallLabel : 'WAIT'}
            </Badge>
          </div>
          <p
            className={`mt-1.5 text-[15px] font-bold ${
              confirmed
                ? opportunity.direction === 'BULLISH'
                  ? 'text-success'
                  : 'text-danger'
                : 'text-warning'
            }`}
          >
            {confirmed
              ? opportunity.selectedStrategy.label
              : `No signal — ${opportunity.marketRegimeLabel || opportunity.marketCondition}`}
          </p>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-fg-4">
            <span className="tabular">
              Confluence <strong className="text-fg-2">{formatNumber(score, 0)}%</strong>
            </span>
            <span className="h-3 w-px bg-line" />
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {opportunity.marketRegimeLabel || opportunity.marketCondition}
            </span>
          </div>
        </div>

        {/* Confluence breakdown — the real weighted components. */}
        <div className="space-y-2">
          <ScoreBar label="Market structure" value={opportunity.score.marketStructure} max={20} />
          <ScoreBar label="Range & POI" value={opportunity.score.rangeAndPoi} max={20} />
          <ScoreBar label="Price action" value={opportunity.score.priceActionConfirmation} max={20} />
          <ScoreBar label="Momentum" value={opportunity.score.momentumAndDisplacement} max={15} />
          <ScoreBar label="MTF alignment" value={opportunity.score.multiTimeframeAlignment} max={15} />
          <ScoreBar label="Technical" value={opportunity.score.technicalConfirmation} max={10} />
        </div>

        {/* Levels, shown only when the engine actually produced them. */}
        {confirmed && opportunity.entryAndTp.entryPrice !== undefined ? (
          <div className="grid grid-cols-2 gap-2 border-t border-line-soft pt-3">
            <Level label="Entry" value={formatPrice(opportunity.entryAndTp.entryPrice, digits)} tone="text-fg-1" />
            <Level
              label="Take profit"
              value={
                opportunity.entryAndTp.takeProfit !== undefined
                  ? formatPrice(opportunity.entryAndTp.takeProfit, digits)
                  : '—'
              }
              tone="text-success"
            />
            <Level
              label="Invalidation"
              value={
                opportunity.entryAndTp.invalidationLevel !== undefined
                  ? formatPrice(opportunity.entryAndTp.invalidationLevel, digits)
                  : '—'
              }
              tone="text-danger"
            />
            <Level
              label="Risk / reward"
              value={
                opportunity.entryAndTp.riskRewardRatio !== undefined
                  ? `${formatNumber(opportunity.entryAndTp.riskRewardRatio, 2)} : 1`
                  : '—'
              }
              tone="text-fg-1"
            />
          </div>
        ) : (
          <div className="space-y-2.5 border-t border-line-soft pt-3">
            <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-fg-5">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {opportunity.entryAndTp.waitReason ||
                  'Mandatory gates not yet satisfied. No entry levels are published until the setup confirms.'}
              </span>
            </div>
            {opportunity.explanation.trim() !==
              (opportunity.entryAndTp.waitReason || '').trim() && (
              <p className="text-[11.5px] leading-relaxed text-fg-4">{opportunity.explanation}</p>
            )}
          </div>
        )}

        {onOpenAnalysis && (
          <button
            onClick={onOpenAnalysis}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-accent/40 bg-accent/15 px-3 py-2 text-[12px] font-semibold text-accent-soft transition-colors hover:bg-accent/25"
          >
            <Target className="h-3.5 w-3.5" />
            Full multi-timeframe analysis
          </button>
        )}
      </CardBody>
    </Card>
  );
};

const ScoreBar: React.FC<{ label: string; value: number; max: number }> = ({ label, value, max }) => {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10.5px]">
        <span className="text-fg-5">{label}</span>
        <span className="tabular font-semibold text-fg-3">
          {formatNumber(value, 0)}/{max}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-elevated">
        <div
          className={`h-full rounded-full ${pct >= 70 ? 'bg-success' : pct >= 40 ? 'bg-accent' : 'bg-warning'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

const Level: React.FC<{ label: string; value: string; tone: string }> = ({ label, value, tone }) => (
  <div className="rounded-[var(--radius-sm)] border border-line-soft bg-surface-deep px-2.5 py-2">
    <span className="block text-[9.5px] font-semibold uppercase tracking-[0.1em] text-fg-6">{label}</span>
    <span className={`tabular mt-0.5 block truncate text-[13px] font-bold ${tone}`}>{value}</span>
  </div>
);
