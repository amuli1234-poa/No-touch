import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Clock,
  Crosshair,
  Gauge,
  Target,
} from 'lucide-react';
import type { WatchZoneExpectation } from '../analysis/watchZoneExpectation';
import { formatPrice } from '../utils/derivParser';

interface WatchZoneExpectationPanelProps {
  expectation: WatchZoneExpectation | null;
  precision: number;
  /** Shown when analysis has not been run yet. */
  hasRun: boolean;
}

const FRESHNESS_LABEL: Record<WatchZoneExpectation['zone']['freshness'], string> = {
  FRESH: 'Fresh',
  PROBED: 'Probed',
  PARTIALLY_TESTED: 'Partially tested',
  MITIGATED: 'Mitigated',
  INVALIDATED: 'Invalidated',
};

function directionTone(reaction: WatchZoneExpectation['expectedReaction']): string {
  if (reaction === 'RISE') return 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30';
  if (reaction === 'FALL') return 'bg-red-500/12 text-[#f23645] border-red-500/30';
  return 'bg-amber-500/12 text-warn border-amber-500/30';
}

function marketTone(dir: WatchZoneExpectation['marketDirection']): string {
  if (dir === 'BULLISH') return 'text-emerald-400';
  if (dir === 'BEARISH') return 'text-[#f23645]';
  return 'text-muted';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="w-28 shrink-0 text-[12px] font-semibold text-faint uppercase tracking-wide">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[13px] text-ink leading-snug">{children}</span>
    </div>
  );
}

/**
 * WATCHING ZONE EXPECTATION — a compact, plain-language panel describing exactly what to
 * expect when price reaches the identified watching zone: direction, reaction, why, the
 * confirmation required, invalidation, targets and quality. It never predicts a reversal
 * without evidence — an unconfirmed zone shows WAITING FOR CONFIRMATION.
 */
export function WatchZoneExpectationPanel({
  expectation,
  precision,
  hasRun,
}: WatchZoneExpectationPanelProps) {
  if (!expectation) {
    return (
      <div
        data-testid="watch-zone-panel"
        className="rounded-xl border border-line bg-panel p-4"
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <Crosshair className="w-4 h-4 text-accent" aria-hidden="true" />
          Watching zone expectation
        </div>
        <p className="mt-2 text-[13px] text-muted leading-snug">
          {hasRun
            ? 'No fresh, untested watching zone right now. Tested and already-mitigated zones are never shown as fresh opportunities.'
            : 'Run the analysis to identify the next potential watching zone and the expected reaction when price reaches it.'}
        </p>
      </div>
    );
  }

  const e = expectation;
  const isRise = e.expectedReaction === 'RISE';
  const isFall = e.expectedReaction === 'FALL';
  const waiting = e.expectedReaction === 'WAITING_FOR_CONFIRMATION';

  return (
    <div
      data-testid="watch-zone-panel"
      data-reaction={e.expectedReaction}
      className="rounded-xl border border-line bg-panel overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line-soft">
        <Crosshair className="w-4 h-4 text-accent" aria-hidden="true" />
        <span className="text-[13px] font-bold text-ink">Watching zone expectation</span>
        <span
          className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[12px] font-bold ${directionTone(
            e.expectedReaction
          )}`}
        >
          {isRise && <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />}
          {isFall && <ArrowDownRight className="w-3.5 h-3.5" aria-hidden="true" />}
          {waiting && <Clock className="w-3.5 h-3.5" aria-hidden="true" />}
          {waiting ? 'WAITING FOR CONFIRMATION' : `EXPECT ${e.expectedReaction}`}
        </span>
      </div>

      <div className="px-3 py-2 divide-y divide-line-soft">
        <Row label="Market direction">
          <span className={`font-semibold ${marketTone(e.marketDirection)}`}>
            {e.marketDirection}
          </span>
        </Row>
        <Row label="Watching zone">
          <span className="font-mono tabular-nums text-ink">
            {formatPrice(e.zone.low, precision)} – {formatPrice(e.zone.high, precision)}
          </span>
          <span className="ml-2 text-[12px] text-faint">
            {FRESHNESS_LABEL[e.zone.freshness]} · {e.zone.stage.replace(/_/g, ' ').toLowerCase()}
          </span>
        </Row>
        <Row label="Zone type">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-elevated border border-line text-[12px] font-semibold text-muted">
            {e.zone.type}
          </span>
        </Row>
        <Row label="Expected reaction">
          <span className="font-semibold">{waiting ? 'Awaiting a confirmed reaction' : e.expectedReaction}</span>
        </Row>
        <Row label="Why">{e.reason}</Row>
        <Row label="Confirmation">
          <span className="inline-flex items-start gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" aria-hidden="true" />
            <span>{e.confirmationRequired}</span>
          </span>
        </Row>
        <Row label="Invalidation">
          <span className="inline-flex items-start gap-1.5">
            <Ban className="w-3.5 h-3.5 text-[#f23645] shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              <span className="font-mono tabular-nums text-ink">
                {formatPrice(e.invalidation.level, precision)}
              </span>{' '}
              — {e.invalidation.condition}
            </span>
          </span>
        </Row>
        <Row label="Targets">
          {e.targets.tp1 === null ? (
            <span className="text-faint">No targets until the reaction is confirmed.</span>
          ) : (
            <span className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
                <Target className="w-3 h-3" aria-hidden="true" /> TP1 {formatPrice(e.targets.tp1, precision)}
              </span>
              {e.targets.tp2 !== null && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
                  TP2 {formatPrice(e.targets.tp2, precision)}
                </span>
              )}
              {e.targets.tp3 !== null && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
                  TP3 {formatPrice(e.targets.tp3, precision)}
                </span>
              )}
              {!e.targets.justified && (
                <span className="text-[11px] text-faint">(projected — no structural level ahead)</span>
              )}
            </span>
          )}
        </Row>
        <Row label="Setup quality">
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <Gauge className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
              <span className="font-bold tabular-nums">{e.quality.score}/100</span>
            </span>
            <span className="text-[12px] text-muted">{e.quality.tier}</span>
            <span className="text-[12px] text-faint">· {e.quality.confidence} confidence</span>
          </span>
        </Row>
      </div>
    </div>
  );
}
