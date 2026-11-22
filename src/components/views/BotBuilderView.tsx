import { useEffect, useState } from 'react';
import { Bot, FileUp, Info, ShieldCheck } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { fetchBotFormats, type BotFormats } from '../../lib/bots';
import { Card, SectionCard } from '../ui/primitives';
import { BotImporter } from '../bots/BotImporter';

/**
 * BOT IMPORTER — the import workspace.
 *
 * No-touch does not build strategies from scratch: it imports strategies that
 * already exist as Deriv DBot exports. This view is therefore an importer, not
 * a drag-and-drop editor, and it never pretends to create a bot.
 *
 * The block lists below are fetched from the server, which owns the parser, so
 * the page cannot advertise support for a block the parser does not handle.
 */

export function BotBuilderView() {
  const ws = useWorkspace();
  const [formats, setFormats] = useState<BotFormats | null>(null);
  const [formatsError, setFormatsError] = useState(false);

  useEffect(() => {
    let active = true;
    fetchBotFormats()
      .then((f) => {
        if (active) setFormats(f);
      })
      .catch(() => {
        if (active) setFormatsError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-faint">
            Import existing strategies
          </p>
          <h1 className="text-lg sm:text-xl font-bold text-ink mt-0.5">Bot Importer</h1>
          <p className="text-xs text-muted mt-1 max-w-2xl leading-relaxed">
            Bring a bot you already built in Deriv DBot into No-touch. Select the{' '}
            <code className="font-mono text-ink">.xml</code> file DBot saved to your computer and
            No-touch will validate it, explain exactly what it understands, and keep the original file
            safe.
          </p>
        </div>
        <button
          type="button"
          onClick={() => ws.navigate('mybots')}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line text-xs font-semibold text-muted hover:text-ink hover:border-accent/50 transition-colors cursor-pointer"
        >
          <Bot className="w-3.5 h-3.5" aria-hidden="true" />
          Open My Bots
        </button>
      </header>

      <BotImporter onImported={() => ws.navigate('mybots')} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          title="Supported blocks"
          subtitle="Blocks this build can interpret"
          icon={<ShieldCheck className="w-4 h-4" aria-hidden="true" />}
        >
          {formatsError && (
            <p className="text-xs text-muted">
              The block list could not be loaded. The importer still validates against the server's
              parser.
            </p>
          )}
          {!formatsError && !formats && <p className="text-xs text-muted">Loading…</p>}
          {formats && (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              {formats.supportedBlocks.map((block) => (
                <li key={block} className="text-[11px] text-muted font-mono truncate">
                  {block}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Blocks kept but not interpreted"
          subtitle="Preserved in the file, reported on import"
          icon={<Info className="w-4 h-4" aria-hidden="true" />}
        >
          {formats ? (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {formats.unsupportedBlocks.map((entry) => (
                <li key={entry.type} className="text-[11px]">
                  <code className="text-ink font-mono">{entry.type}</code>
                  <span className="text-muted"> — {entry.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">{formatsError ? 'Unavailable.' : 'Loading…'}</p>
          )}
        </SectionCard>
      </div>

      <Card className="p-3.5">
        <h3 className="text-xs font-bold uppercase tracking-wide text-faint flex items-center gap-1.5">
          <FileUp className="w-3.5 h-3.5" aria-hidden="true" />
          How import works
        </h3>
        <ol className="mt-2 space-y-1.5 text-[11px] text-muted leading-relaxed list-decimal pl-4">
          <li>Choose the .xml file Deriv DBot exported to your computer.</li>
          <li>No-touch reads it as text and validates the DBot structure on the server.</li>
          <li>You see a preview: market, contract, stake, conditions and anything unsupported.</li>
          <li>Confirm to store it in My Bots, or cancel to discard the upload.</li>
        </ol>
        <p className="text-[11px] text-muted mt-2.5 leading-relaxed">
          Importing is not execution authorisation. An imported bot is stored as inert configuration;
          no trade is placed, and REAL execution remains disabled.
        </p>
      </Card>
    </div>
  );
}
