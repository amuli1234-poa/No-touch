import { useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  Crosshair,
  Layers,
  Radar,
  ShieldAlert,
  Sparkles,
  Target,
} from 'lucide-react';
import type {
  FutureReactionZone,
  SetupStage,
  StructureOverlayData,
  ZoneFreshness,
} from '../types/structure';
import { formatPrice } from '../utils/derivParser';

/**
 * Structure & Future Opportunity panel. Shows only the CURRENT valid structure and the
 * fresh future reaction zones the engine is watching — with their three-stage status
 * (zone detected → price approaching → entry confirmed) so a potential opportunity is
 * visible BEFORE an entry is confirmed. Entries are still gated by the signal engine.
 */

interface StructureOpportunitiesPanelProps {
  structure: StructureOverlayData | null;
  precision: number;
  /** Highlighted zone (from a chart tap); null when none selected. */
  selectedZoneId?: string | null;
  onSelectZone?: (zone: FutureReactionZone) => void;
}

const STAGE_STYLE: Record<SetupStage, { label: string; cls: string }> = {
  ZONE_DETECTED: { label: 'Zone detected', cls: 'bg-panel text-muted border-line' },
  PRICE_APPROACHING: {
    label: 'Price approaching',
    cls: 'bg-amber-500/12 text-warn border-amber-500/30',
  },
  ENTRY_CONFIRMED: {
    label: 'Entry confirmed',
    cls: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  },
  FAILED: { label: 'Failed', cls: 'bg-red-500/10 text-bear border-red-500/25' },
  INVALIDATED: { label: 'Invalidated', cls: 'bg-red-500/10 text-bear border-red-500/25' },
};

const FRESHNESS_LABEL: Record<ZoneFreshness, string> = {
  FRESH: 'Fresh',
  PROBED: 'Probed',
  PARTIALLY_TESTED: 'Partial',
  MITIGATED: 'Mitigated',
  INVALIDATED: 'Invalidated',
};

const STAGE_STEP: Record<SetupStage, number> = {
  ZONE_DETECTED: 1,
  PRICE_APPROACHING: 2,
  ENTRY_CONFIRMED: 3,
  FAILED: 0,
  INVALIDATED: 0,
};

function StageTrack({ stage }: { stage: SetupStage }) {
  const step = STAGE_STEP[stage];
  const failed = stage === 'FAILED' || stage === 'INVALIDATED';
  return (
    <div className="flex items-center gap-1" aria-label={`Stage: ${STAGE_STYLE[stage].label}`}>
      {[1, 2, 3].map((s) => (
        <span
          key={s}
          className={`h-1.5 rounded-full transition-all ${
            failed
              ? 'w-3 bg-bear/40'
              : step >= s
                ? 'w-5 bg-accent'
                : 'w-3 bg-line'
          }`}
        />
      ))}
    </div>
  );
}

function ZoneCard({
  zone,
  precision,
  active,
  onSelect,
}: {
  zone: FutureReactionZone;
  precision: number;
  active: boolean;
  onSelect?: (zone: FutureReactionZone) => void;
}) {
  const isRise = zone.direction === 'RISE';
  const stage = STAGE_STYLE[zone.stage];
  const mid = (zone.upperPrice + zone.lowerPrice) / 2;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(zone)}
      data-testid="structure-zone-card"
      data-direction={zone.direction}
      data-stage={zone.stage}
      className={`w-full text-left rounded-lg border px-3 py-2.5 space-y-2 transition-colors cursor-pointer ${
        active ? 'border-accent/50 bg-accent/8' : 'border-line-soft bg-panel hover:border-accent/30'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0 ${
            isRise ? 'bg-emerald-500/12 text-emerald-400' : 'bg-red-500/12 text-bear'
          }`}
        >
          {isRise ? (
            <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <ArrowDownRight className="w-3.5 h-3.5" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-bold ${isRise ? 'text-emerald-400' : 'text-bear'}`}>
              WATCH {isRise ? 'RISE' : 'FALL'}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${stage.cls}`}
            >
              {stage.label}
            </span>
          </div>
          <div className="text-[11px] text-faint font-mono tabular-nums mt-0.5">
            {formatPrice(zone.lowerPrice, precision)} – {formatPrice(zone.upperPrice, precision)} ·{' '}
            {zone.originTimeframe}
          </div>
        </div>
        <StageTrack stage={zone.stage} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1">
          <Layers className="w-3 h-3" aria-hidden="true" />
          {FRESHNESS_LABEL[zone.freshness]}
        </span>
        <span className="inline-flex items-center gap-1">
          <Crosshair className="w-3 h-3" aria-hidden="true" />
          {zone.reactions > 0 ? `${zone.reactions} reactions` : 'new structure'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Target className="w-3 h-3" aria-hidden="true" />
          {zone.distanceAtr.toFixed(1)}× ATR away
        </span>
      </div>

      <p className="text-[12px] leading-snug text-muted">{zone.reason}</p>

      <div className="text-[11px] text-faint">
        <span className="font-semibold text-muted">Invalidation: </span>
        {zone.invalidationCondition}{' '}
        <span className="font-mono tabular-nums">
          ({formatPrice(zone.invalidationLevel, precision)})
        </span>
      </div>

      {active && (
        <div className="pt-1.5 border-t border-line-soft space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Structure evidence
          </div>
          <p className="text-[11px] text-muted">{zone.sourceStructure}</p>
          {zone.evidence.map((e, i) => (
            <p key={i} className="text-[11px] text-muted">
              • {e}
            </p>
          ))}
          <p className="text-[11px] text-faint">
            Watching mid-level {formatPrice(mid, precision)} · approach{' '}
            {Math.round(zone.approachProgress * 100)}%
          </p>
        </div>
      )}
    </button>
  );
}

export function StructureOpportunitiesPanel({
  structure,
  precision,
  selectedZoneId = null,
  onSelectZone,
}: StructureOpportunitiesPanelProps) {
  const [open, setOpen] = useState(true);

  const zones = useMemo(() => {
    if (!structure) return [];
    const order: Record<SetupStage, number> = {
      PRICE_APPROACHING: 0,
      ENTRY_CONFIRMED: 1,
      ZONE_DETECTED: 2,
      FAILED: 3,
      INVALIDATED: 4,
    };
    return [...structure.watchZones].sort((a, b) => {
      if (order[a.stage] !== order[b.stage]) return order[a.stage] - order[b.stage];
      return a.distanceAtr - b.distanceAtr;
    });
  }, [structure]);

  const bias = structure?.bias ?? 'neutral';
  const biasCls =
    bias === 'bullish'
      ? 'text-emerald-400'
      : bias === 'bearish'
        ? 'text-bear'
        : 'text-muted';
  const confirmingBreak = structure?.breaks.filter((b) => b.momentumConfirmed).length ?? 0;

  return (
    <section
      data-testid="structure-panel"
      className="rounded-xl border border-line bg-elevated overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-panel/60 transition-colors"
        aria-expanded={open}
      >
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-accent/12 text-accent">
          <Radar className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
        <span className="text-xs font-bold uppercase tracking-wide text-ink">
          Structure &amp; Future Opportunities
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className={`text-[11px] font-bold uppercase tracking-wide ${biasCls}`}>
            {bias}
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-accent" aria-hidden="true" />
              {structure?.htfTimeframe ? `${structure.htfTimeframe} bias: ` : 'Bias: '}
              <span className={biasCls}>{structure?.htfBias ?? 'neutral'}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldAlert className="w-3 h-3" aria-hidden="true" />
              {structure?.breaks.length ?? 0} break{(structure?.breaks.length ?? 0) === 1 ? '' : 's'}
              {confirmingBreak > 0 ? ` · ${confirmingBreak} with momentum` : ''}
            </span>
            <span>{zones.length} watch zone{zones.length === 1 ? '' : 's'}</span>
          </div>

          {structure?.summary && (
            <p className="text-[12px] leading-snug text-muted">{structure.summary}</p>
          )}

          {zones.length === 0 ? (
            <div className="rounded-lg border border-line-soft bg-panel px-3 py-3 text-center">
              <p className="text-[12px] text-muted">
                No fresh future reaction zones right now. The engine only surfaces zones with
                genuine, repeated structure — it will not invent levels.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {zones.map((zone) => (
                <ZoneCard
                  key={zone.id}
                  zone={zone}
                  precision={precision}
                  active={zone.id === selectedZoneId}
                  onSelect={onSelectZone}
                />
              ))}
            </div>
          )}

          <p className="text-[11px] text-faint leading-snug">
            These are potential reaction zones, not entries. An entry is published only after the
            signal engine confirms the reaction with a quality-gated setup.
          </p>
        </div>
      )}
    </section>
  );
}
