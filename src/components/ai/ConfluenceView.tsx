import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AiScannerValue } from '../../hooks/useAiScanner';
import type { AiInstrumentAnalysis } from '../../types/aiModule';
import { AI_CONDITION_LABELS } from '../../types/aiModule';
import { AiModuleView } from './AiModuleView';
import { SectionCard, StatusPill } from '../ui/primitives';

interface ConfluenceViewProps {
  scanner: AiScannerValue;
}

/**
 * CONFLUENCE & TRADE VALIDATION AI — dedicated view. It reuses the shared module layout
 * but adds an evidence panel showing which sibling modules support the trade and which
 * conflicting evidence was rejected.
 */
export function ConfluenceView({ scanner }: ConfluenceViewProps) {
  const extraPanel = (analysis: AiInstrumentAnalysis): ReactNode => {
    const signal = analysis.signal;
    const supporting = signal?.confirmations ?? [];
    const evidence = signal?.reasons ?? [];
    const conflicts = evidence.filter((r) => /conflict/i.test(r));
    const verifiedEvidence = evidence.filter((r) => !/conflict/i.test(r));

    return (
      <SectionCard
        title="Evidence & Validation"
        subtitle="Independently verified — correlated evidence is de-duplicated by entry model"
        icon={<ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />}
      >
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <StatusPill label={AI_CONDITION_LABELS[analysis.condition]} className="bg-elevated text-muted border-line" />
          {supporting.map((s) => (
            <StatusPill key={s} label={s} className="bg-blue-500/12 text-blue-400 border-blue-500/30" />
          ))}
        </div>
        <div className="space-y-1">
          {verifiedEvidence.length === 0 && conflicts.length === 0 && (
            <div className="text-[11px] text-faint py-2">
              No validated trade — {analysis.rejectionReason ?? analysis.statusExplanation}
            </div>
          )}
          {verifiedEvidence.slice(0, 6).map((r, i) => (
            <div key={i} className="text-[11px] text-muted leading-snug flex gap-1.5">
              <span className="text-emerald-400 shrink-0">✓</span>
              <span>{r}</span>
            </div>
          ))}
          {conflicts.map((r, i) => (
            <div key={`c${i}`} className="text-[11px] text-warn leading-snug flex gap-1.5">
              <span className="shrink-0">⚠</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    );
  };

  return (
    <AiModuleView
      scanner={scanner}
      meta={{
        title: 'Confluence & Trade Validation AI',
        subtitle: 'Independent verification, conflict detection and setup ranking',
        icon: <ShieldCheck className="w-4 h-4" aria-hidden="true" />,
        settingsSubtitle: 'Consumes evidence from every AI module but validates independently.',
        extraPanel,
      }}
    />
  );
}
