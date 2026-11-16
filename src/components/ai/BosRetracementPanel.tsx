import { Crosshair, Layers, ListChecks, ShieldCheck } from 'lucide-react';
import type { AiInstrumentAnalysis } from '../../types/aiModule';
import { AI_STATUS_LABELS } from '../../types/aiModule';
import { BOS_SETUP_STATE_LABELS } from '../../types/bosRetracement';
import { formatPrice } from '../../utils/derivParser';
import { CheckRow, SectionCard, StatTile, StatusPill } from '../ui/primitives';

/**
 * BOS RETRACEMENT & REJECTION AI — module panel.
 *
 * Renders the current valid setup's structured readout: the locked dealing range, the
 * discount/premium entry zone, the liquidity sweep, the decisive rejection, the
 * lower-timeframe MSS confirmation, and the entry / stop / targets when a trade is
 * published. A BOS is a setup, never an automatic entry — the panel shows exactly which
 * confirmation steps have and have not been satisfied.
 */

const STATE_STYLE: Record<string, string> = {
  CONFIRMED: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  CONFIRMATION: 'bg-amber-500/12 text-warn border-amber-500/30',
  REJECTION: 'bg-amber-500/12 text-warn border-amber-500/30',
  IN_ZONE: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  WAITING_FOR_PULLBACK: 'bg-elevated text-muted border-line',
  BOS_DETECTED: 'bg-elevated text-muted border-line',
  INVALIDATED: 'bg-panel text-faint border-line',
  EXPIRED: 'bg-panel text-faint border-line',
};

function PriceRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`text-[12px] font-mono font-semibold ${valueClass ?? 'text-ink'}`}>{value}</span>
    </div>
  );
}

export function BosRetracementPanel({ analysis }: { analysis: AiInstrumentAnalysis }) {
  const readout = analysis.detail;
  if (!readout) {
    return (
      <SectionCard
        title="BOS Retracement & Rejection"
        subtitle="Break of structure is a setup — not an entry trigger"
        icon={<Crosshair className="w-3.5 h-3.5" aria-hidden="true" />}
      >
        <p className="text-[12px] text-faint py-2">{analysis.rejectionReason ?? 'No validated BOS setup for this instrument.'}</p>
      </SectionCard>
    );
  }

  const p = analysis.precision;
  const { range, entryZone, sweep, rejection, ltf, state } = readout;
  const isRise = readout.direction === 'RISE';
  const dirClass = isRise ? 'text-emerald-400' : 'text-bear';

  return (
    <SectionCard
      title="BOS Retracement & Rejection"
      subtitle={`${readout.kind === 'REVERSAL' ? 'Reversal CHoCH / MSS' : 'Continuation BOS'} · dealing range locked to the protected swing`}
      icon={<Crosshair className="w-3.5 h-3.5" aria-hidden="true" />}
      right={
        <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${STATE_STYLE[state] ?? STATE_STYLE.WAITING_FOR_PULLBACK}`}>
          {BOS_SETUP_STATE_LABELS[state]}
        </span>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Dealing range */}
        <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <Layers className="w-3.5 h-3.5 text-faint" aria-hidden="true" />
            <span className="text-[12px] font-bold text-ink">Dealing Range</span>
            <StatusPill
              label={readout.position}
              className="ml-auto bg-elevated text-muted border-line"
            />
          </div>
          <PriceRow label="Range high" value={formatPrice(range.high, p)} valueClass={dirClass} />
          <PriceRow label="Equilibrium (50%)" value={formatPrice(range.equilibrium, p)} />
          <PriceRow label="Range low" value={formatPrice(range.low, p)} valueClass={dirClass} />
          <PriceRow
            label="OTE band (62–79%)"
            value={`${formatPrice(Math.min(range.ote62, range.ote79), p)}–${formatPrice(Math.max(range.ote62, range.ote79), p)}`}
          />
        </div>

        {/* Entry zone */}
        <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <Crosshair className="w-3.5 h-3.5 text-faint" aria-hidden="true" />
            <span className="text-[12px] font-bold text-ink">
              {isRise ? 'Discount' : 'Premium'} Entry Zone
            </span>
          </div>
          {entryZone ? (
            <>
              <PriceRow
                label="Zone"
                value={`${formatPrice(entryZone.low, p)} – ${formatPrice(entryZone.high, p)}`}
              />
              <PriceRow label="Inside 62–79% OTE" value={entryZone.inOte ? 'Yes' : 'No'} />
              <PriceRow label="Order block overlap" value={entryZone.orderBlockOverlap ? 'Yes' : 'No'} />
              <PriceRow label="FVG overlap" value={entryZone.fvgOverlap ? 'Yes' : 'No'} />
            </>
          ) : (
            <p className="text-[12px] text-faint">No retracement zone in play.</p>
          )}
        </div>
      </div>

      {/* Confirmation sequence */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div className="rounded-lg border border-line bg-panel px-3 py-2">
          <div className="text-[12px] font-bold text-ink mb-1">Confirmation sequence</div>
          {sweep && <PriceRow label="Sweep extreme" value={formatPrice(sweep.extremePrice, p)} />}
          {rejection && (
            <PriceRow
              label="Rejection close"
              value={`${formatPrice(rejection.price, p)} (${rejection.bodyAtr}× ATR)`}
            />
          )}
          {ltf && (
            <PriceRow
              label={`${ltf.timeframe} MSS level`}
              value={`${formatPrice(ltf.level, p)} (${ltf.displacementAtr}× ATR)`}
            />
          )}
          {!sweep && !rejection && !ltf && (
            <p className="text-[12px] text-faint">Awaiting the sweep, rejection and lower-timeframe shift.</p>
          )}
        </div>

        {/* Published trade geometry */}
        <div className="rounded-lg border border-line bg-panel px-3 py-2">
          <div className="text-[12px] font-bold text-ink mb-1">
            {analysis.signal ? 'Published trade' : 'Trade locked until confirmed'}
          </div>
          {analysis.signal ? (
            <div className="grid grid-cols-2 gap-2 mt-1">
              <StatTile label="Entry" value={formatPrice(analysis.signal.entryPrice, p)} />
              <StatTile label="Stop" value={formatPrice(analysis.signal.stopLoss, p)} valueClass="text-bear" />
              <StatTile label="TP1" value={formatPrice(analysis.signal.takeProfit1, p)} valueClass="text-emerald-400" />
              <StatTile label="TP2" value={formatPrice(analysis.signal.takeProfit2, p)} valueClass="text-emerald-400" />
              <StatTile
                label="TP3"
                value={analysis.signal.takeProfit3 === null ? '—' : formatPrice(analysis.signal.takeProfit3, p)}
                valueClass="text-emerald-400"
              />
              <StatTile label="R:R" value={analysis.signal.riskRewardRatio.toFixed(2)} />
            </div>
          ) : (
            <p className="text-[12px] text-faint">
              {readout.rr !== null
                ? `Estimated R:R ${readout.rr.toFixed(2)} — awaiting the final confirmation step.`
                : 'No entry is manufactured before the full sequence confirms.'}
            </p>
          )}
        </div>
      </div>

      {/* Evidence trail */}
      <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <ListChecks className="w-3.5 h-3.5 text-faint" aria-hidden="true" />
          <span className="text-[12px] font-bold text-ink">Evidence</span>
          <span className="ml-auto text-[11px] text-faint font-mono">
            {readout.barsSinceBos} bar{readout.barsSinceBos === 1 ? '' : 's'} since BOS
          </span>
        </div>
        {readout.evidence.map((e, i) => (
          <CheckRow key={i} label={e.label} ok={e.satisfied} detail={e.detail} />
        ))}
      </div>

      <div className="mt-3 flex items-start gap-2 text-[12px] text-muted">
        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-faint" aria-hidden="true" />
        <p className="leading-snug">
          {AI_STATUS_LABELS[analysis.status]} — {analysis.statusExplanation}
        </p>
      </div>
    </SectionCard>
  );
}
