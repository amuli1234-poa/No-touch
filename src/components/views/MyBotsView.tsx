import { Archive, Bot, CirclePause, CirclePlay, FileEdit, Layers, ShieldCheck } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Card, EmptyState, SectionCard, StatusPill } from '../ui/primitives';

/**
 * MY BOTS — bot management.
 *
 * There is no bot store yet (persistence arrives with the strategy engine), so this
 * screen must not invent bots, counts, performance or execution history. It states
 * plainly that nothing is saved and previews the lifecycle controls that will act on
 * real, tenant-scoped records once they exist.
 */

/** The lifecycle a saved bot will move through. Shown as a legend, not as live counts. */
const LIFECYCLE: { label: string; detail: string; icon: typeof Bot }[] = [
  { label: 'Draft', detail: 'Blocks being composed; cannot run.', icon: FileEdit },
  { label: 'Validated', detail: 'Passed deterministic validation; ready to enable.', icon: ShieldCheck },
  { label: 'Active', detail: 'Enabled for the Pro Scanner to match.', icon: CirclePlay },
  { label: 'Paused', detail: 'Kept, but withheld from matching.', icon: CirclePause },
  { label: 'Archived', detail: 'Retired and read-only.', icon: Archive },
];

export function MyBotsView() {
  const ws = useWorkspace();

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-faint">
                Saved strategies
              </span>
              <StatusPill
                label="No bots yet"
                className="bg-panel text-muted border-line"
                dotClass="bg-faint"
              />
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-ink mt-1">
              My Bots
            </h1>
            <p className="text-xs sm:text-sm text-muted leading-relaxed mt-1.5 max-w-2xl">
              Bots you build will be saved to your own account and listed here with their
              strategy version, supported markets, execution mode and verified performance.
              Nothing is stored on this device, and no bot from another account is ever visible.
            </p>
          </div>
        </div>
      </Card>

      <SectionCard
        title="Your bots"
        subtitle="Populated once the Bot Builder can save strategies"
        icon={<Bot className="w-4 h-4" />}
      >
        <EmptyState
          icon={<Layers className="w-5 h-5" />}
          title="No bots saved yet"
          description="There are no strategy definitions on this account. The Bot Builder is being prepared; once it can save, your bots will appear here with start, pause, stop, edit and duplicate actions."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => ws.navigate('botbuilder')}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-white bg-accent rounded-lg hover:bg-accent-soft active:scale-[0.98] transition-all duration-150 cursor-pointer"
              >
                <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                Open Bot Builder
              </button>
              <button
                type="button"
                onClick={() => ws.navigate('scanner')}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 transition-colors cursor-pointer"
              >
                Open Pro Scanner
              </button>
            </div>
          }
        />
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          title="Bot lifecycle"
          subtitle="Every saved bot moves through these states"
          icon={<ShieldCheck className="w-4 h-4" />}
        >
          <ul className="space-y-2">
            {LIFECYCLE.map((state) => {
              const Icon = state.icon;
              return (
                <li key={state.label} className="flex items-start gap-2.5">
                  <span className="shrink-0 mt-0.5 w-6 h-6 rounded-md bg-elevated border border-line text-accent flex items-center justify-center">
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-ink">{state.label}</div>
                    <div className="text-[11px] text-muted leading-snug">{state.detail}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </SectionCard>

        <SectionCard
          title="What each bot will show"
          subtitle="Derived from stored records, never estimated"
          icon={<Bot className="w-4 h-4" />}
        >
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              'Strategy version',
              'Supported markets',
              'Execution mode',
              'Verified performance',
              'Last activity',
              'Lifecycle state',
            ].map((field) => (
              <li
                key={field}
                className="rounded-lg border border-line bg-panel px-3 py-2 text-xs font-semibold text-ink"
              >
                {field}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted leading-relaxed mt-2.5">
            Performance figures will be calculated from immutable execution records only, so a
            bot with no settled trades shows no rate rather than a guess.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
