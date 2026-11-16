import { Activity, Brain, CandlestickChart, Layers, ShieldAlert, Target } from 'lucide-react';
import type {
  EngineFinding,
  EngineFindings,
  FalseSignalReport,
  TargetReachability,
} from '../types/intelligence';

interface EngineFindingsPanelProps {
  findings: EngineFindings | null;
  reachability: TargetReachability | null;
  falseSignal: FalseSignalReport | null;
}

const LENSES: { key: keyof EngineFindings; label: string; Icon: typeof Brain }[] = [
  { key: 'smc', label: 'Smart Money Concepts', Icon: Layers },
  { key: 'ict', label: 'ICT', Icon: Activity },
  { key: 'priceAction', label: 'Price Action', Icon: CandlestickChart },
  { key: 'technical', label: 'Technical', Icon: Brain },
];

function FindingRow({ finding }: { finding: EngineFinding }) {
  const tone =
    finding.supports === true
      ? 'text-emerald-400'
      : finding.supports === false
        ? 'text-bear'
        : 'text-muted';
  const mark = finding.supports === true ? '✓' : finding.supports === false ? '✕' : '·';
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-snug">
      <span className={`mt-[1px] font-bold ${tone}`} aria-hidden="true">
        {mark}
      </span>
      <div className="min-w-0">
        <div className={`font-semibold ${tone}`}>{finding.label}</div>
        <div className="text-faint">{finding.detail}</div>
      </div>
    </div>
  );
}

/**
 * Four-lens read (SMC / ICT / price action / technical) plus the target-first
 * reachability estimate and the false-signal guard for the leading setup.
 */
export function EngineFindingsPanel({
  findings,
  reachability,
  falseSignal,
}: EngineFindingsPanelProps) {
  if (!findings && !reachability && !falseSignal) return null;

  return (
    <div className="rounded-xl border border-line bg-panel overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-surface">
        <Brain className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
        <span className="text-[12px] font-bold uppercase tracking-wide text-ink">
          Multi-Engine Analysis
        </span>
        <span className="ml-auto text-[11px] font-mono text-faint uppercase">SMC · ICT · PA · TA</span>
      </div>

      <div className="p-3 space-y-3">
        {findings && (
          <div className="space-y-2.5">
            {LENSES.map(({ key, label, Icon }) => {
              const rows = findings[key];
              if (!rows || rows.length === 0) return null;
              return (
                <div key={key}>
                  <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-faint">
                    <Icon className="w-3 h-3" aria-hidden="true" />
                    {label}
                  </div>
                  <div className="mt-1 space-y-1.5">
                    {rows.map((finding, i) => (
                      <FindingRow key={i} finding={finding} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {reachability && (
          <div
            data-testid="engine-reachability"
            className={`rounded-lg border px-2.5 py-2 ${
              reachability.tp1Reachable
                ? 'border-emerald-500/25 bg-emerald-500/6'
                : 'border-amber-500/30 bg-amber-500/8'
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-faint">
              <Target className="w-3 h-3" aria-hidden="true" />
              Target reachability
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase">
              <span className={reachability.tp1Reachable ? 'text-emerald-400' : 'text-warn'}>
                TP1 {reachability.tp1Reachable ? 'reachable' : 'not reachable'}
              </span>
              <span className="text-faint">·</span>
              <span className={reachability.tp2Reachable ? 'text-emerald-400' : 'text-muted'}>
                TP2 {reachability.tp2Reachable ? 'reachable' : 'tight'}
              </span>
              {reachability.blocked && (
                <>
                  <span className="text-faint">·</span>
                  <span className="text-bear">blocked</span>
                </>
              )}
            </div>
            <p className="mt-1 text-[12px] text-muted leading-snug">{reachability.reason}</p>
            <div className="mt-1 text-[11px] font-mono text-faint">
              Room {reachability.roomToTp1Atr.toFixed(1)}× / {reachability.roomToTp2Atr.toFixed(1)}× ATR ·
              requires {reachability.requiredRoomAtr.toFixed(1)}×
            </div>
          </div>
        )}

        {falseSignal && (
          <div
            data-testid="engine-false-signal"
            className={`rounded-lg border px-2.5 py-2 ${
              falseSignal.flagged
                ? 'border-red-500/30 bg-red-500/8'
                : 'border-emerald-500/25 bg-emerald-500/6'
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-faint">
              <ShieldAlert
                className={`w-3 h-3 ${falseSignal.flagged ? 'text-bear' : 'text-emerald-400'}`}
                aria-hidden="true"
              />
              False-signal guard
            </div>
            <div
              className={`mt-1 text-[11px] font-bold uppercase tracking-wide ${
                falseSignal.flagged ? 'text-bear' : 'text-emerald-400'
              }`}
            >
              {falseSignal.flagged ? `${falseSignal.traps.length} trap pattern(s) flagged` : 'Clean'}
            </div>
            <p className="mt-1 text-[12px] text-muted leading-snug">{falseSignal.reason}</p>
          </div>
        )}
      </div>
    </div>
  );
}
