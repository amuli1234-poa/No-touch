import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Blocks,
  CheckCircle2,
  FileWarning,
  Loader2
} from 'lucide-react';

import {
  fetchBotTree,
  deleteBot,
  exportUrl,
  revertBot,
  saveBotTree,
  useBots,
  type BotEditorPayload,
  type BotRecord
} from '../../lib/bots';
import { Card, EmptyState, StatusPill } from '../ui/primitives';
import { BotImporter } from '../bots/BotImporter';
import { ExecutionRail } from '../bots/ExecutionRail';
import { TradingConfigPanel } from '../bots/TradingConfigPanel';
import { WorkspaceToolbar } from '../bots/WorkspaceToolbar';
import { StrategyWorkspace, type EditorControls } from '../bots/editor/StrategyWorkspace';
import { readStrategyConfig } from '../bots/strategyConfig';

/**
 * BOT BUILDER — the block strategy workspace.
 *
 * Flow: import a bot, open it, edit its blocks, save, export or delete.
 *
 * The editor is a view over the stored strategy, never a second source of
 * truth. Blockly renders the XML the server produced and hands XML back on
 * save; the server re-parses it before storing, so nothing unvalidated is ever
 * persisted. The original imported file is kept separately and stays
 * downloadable after an edit.
 *
 * Editing a strategy is not execution authorisation. This view can save,
 * export and delete a bot, but it cannot place a trade.
 */

const STATUS_STYLE: Record<BotRecord['status'], string> = {
  imported: 'bg-accent/10 text-accent border-accent/30',
  paused: 'bg-warning/10 text-warning border-warning/30',
  archived: 'bg-muted/10 text-muted border-line'
};

export function BotBuilderView() {
  const [openBotId, setOpenBotId] = useState<string | null>(null);

  if (openBotId) {
    return (
      <StrategyEditor
        key={openBotId}
        botId={openBotId}
        onClose={() => setOpenBotId(null)}
        onOpenBot={setOpenBotId}
      />
    );
  }
  return <BotLibrary onOpen={setOpenBotId} />;
}

/* -------------------------------------------------------------------------- */
/*  Library                                                                    */
/* -------------------------------------------------------------------------- */

function BotLibrary({ onOpen }: { onOpen: (id: string) => void }) {
  const { bots, status, error, refresh } = useBots();
  const [importing, setImporting] = useState(false);
  const loading = status === 'loading' || status === 'idle';

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-faint">
            Visual strategy builder
          </p>
          <h1 className="text-lg sm:text-xl font-bold text-ink mt-0.5">Bot Builder</h1>
          <p className="text-xs text-muted mt-1 max-w-2xl leading-relaxed">
            Import a Deriv DBot strategy, open it as blocks, edit the logic and save it back. The
            original file is always kept, so an edit never destroys what you imported.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setImporting((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent-strong transition-colors cursor-pointer"
        >
          <Blocks className="w-3.5 h-3.5" aria-hidden="true" />
          {importing ? 'Hide importer' : 'Import strategy'}
        </button>
      </header>

      {importing && (
        <BotImporter
          onImported={(bot) => {
            setImporting(false);
            void refresh();
            if (bot?.id) onOpen(bot.id);
          }}
        />
      )}

      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line-soft">
          <h2 className="text-[13px] font-bold text-ink tracking-tight">Your strategies</h2>
          <span className="text-[11px] text-muted">
            {loading ? 'Loading…' : `${bots.length} saved`}
          </span>
        </div>

        {error && <p className="px-4 py-3 text-xs text-danger">{error}</p>}

        {!loading && !error && bots.length === 0 && (
          <EmptyState
            icon={<Blocks className="w-5 h-5" aria-hidden="true" />}
            title="No strategies yet"
            description="Import a DBot .xml export to open it in the block editor."
          />
        )}

        {bots.length > 0 && (
          <ul className="divide-y divide-line-soft">
            {bots.map((bot) => (
              <li key={bot.id}>
                <button
                  type="button"
                  onClick={() => onOpen(bot.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-raised transition-colors cursor-pointer"
                >
                  <span className="p-2 rounded-lg bg-panel border border-line text-accent shrink-0">
                    <Blocks className="w-4 h-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-ink truncate">{bot.name}</span>
                    <span className="block text-[11px] text-muted truncate">
                      {bot.originalFilename}
                      {bot.edited ? ` · edited (rev ${bot.revision})` : ' · original'}
                    </span>
                  </span>
                  <StatusPill label={bot.status} className={STATUS_STYLE[bot.status]} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Editor                                                                     */
/* -------------------------------------------------------------------------- */
function StrategyEditor({
  botId,
  onClose,
  onOpenBot
}: {
  botId: string;
  onClose: () => void;
  onOpenBot: (id: string) => void;
}) {
  const [payload, setPayload] = useState<BotEditorPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [xml, setXml] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [controls, setControls] = useState<EditorControls | null>(null);
  // The rail is a side panel on desktop and an overlay on small screens, where
  // it would otherwise cover the canvas the moment the bot opens.
  const [railOpen, setRailOpen] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 1024
  );
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await fetchBotTree(botId);
      setPayload(data);
      setXml(data.xml);
      setRevision(data.revision);
      setDirty(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The strategy could not be opened.');
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = useCallback((next: string) => {
    setXml(next);
    setDirty(true);
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveBotTree(botId, xml);
      setRevision(result.revision);
      setDirty(false);
      // Reload so the tree, compatibility and unknown-block list describe what
      // was actually stored rather than what the editor held.
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The strategy could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [botId, xml, load]);

  const handleRevert = useCallback(async () => {
    setSaveError(null);
    try {
      await revertBot(botId);
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The strategy could not be reverted.');
    }
  }, [botId, load]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteBot(botId);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The bot could not be deleted.');
    }
  }, [botId, onClose]);

  const unknownTypes = payload?.unknownBlocks.length ?? 0;
  const unknownNodes = useMemo(() => (payload ? countUnknownNodes(payload) : 0), [payload]);

  // The configuration readout is derived from the strategy tree, so it only
  // reflects saved state. While the canvas is dirty the rail says so rather
  // than showing values that no longer match the blocks on screen.
  const config = useMemo(
    () => (payload ? readStrategyConfig(payload.tree) : null),
    [payload]
  );

  if (loadError) {
    return (
      <div className="p-4">
        <Card className="p-0">
          <EmptyState
            icon={<FileWarning className="w-5 h-5" aria-hidden="true" />}
            title="This strategy could not be opened"
            description={loadError}
            action={
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line text-xs font-semibold text-muted hover:text-ink transition-colors cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                Back to library
              </button>
            }
          />
        </Card>
      </div>
    );
  }

  const subtitle = payload
    ? [
        `Revision ${revision}`,
        payload.edited ? 'edited' : 'original file',
        unknownTypes > 0
          ? `${unknownTypes} unsupported block type${unknownTypes === 1 ? '' : 's'}`
          : null
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Opening…';

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)] min-h-0">
      <WorkspaceToolbar
        name={payload?.name ?? 'Loading…'}
        subtitle={subtitle}
        dirty={dirty}
        saving={saving}
        canSave={dirty}
        canRevert={Boolean(payload?.edited)}
        editorReady={controls !== null}
        onBack={onClose}
        onImport={() => setImporting(true)}
        onSave={() => void handleSave()}
        onExport={exportUrl(botId)}
        onRevert={() => void handleRevert()}
        onDelete={() => void handleDelete()}
        onUndo={() => controls?.undo()}
        onRedo={() => controls?.redo()}
        onZoomIn={() => controls?.zoomIn()}
        onZoomOut={() => controls?.zoomOut()}
        onZoomFit={() => controls?.zoomToFit()}
        onResetWorkspace={() => controls?.clear()}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
      />

      {saveError && (
        <div className="flex items-start gap-2 px-4 py-2 bg-danger/10 border-b border-danger/30 text-[11px] text-danger shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{saveError}</span>
        </div>
      )}

      {unknownNodes > 0 && (
        <div className="flex items-start gap-2 px-4 py-2 bg-warning/10 border-b border-warning/30 text-[11px] text-warning shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {unknownNodes} block{unknownNodes === 1 ? '' : 's'} in this strategy cannot be
            interpreted. They are shown read-only and kept exactly as imported, but the strategy
            cannot be executed until they are removed.
          </span>
        </div>
      )}

      <div className="flex flex-1 min-h-0 relative">
        {/* Workspace — the centre of the experience ---------------------- */}
        <div className="flex-1 min-w-0 relative">
          {payload ? (
            <StrategyWorkspace
              key={`${botId}:${revision}`}
              xml={xml}
              unknownBlocks={payload.unknownBlocks}
              onChange={handleChange}
              onReady={setControls}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-accent" aria-hidden="true" />
            </div>
          )}

          {payload && payload.compatibility !== 'full' && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
              <div className="pointer-events-auto flex items-start gap-2 px-3 py-1.5 border-t border-line bg-surface/95 backdrop-blur-sm text-[10.5px] text-muted">
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                <span className="truncate">
                  <strong className="text-ink capitalize">{payload.compatibility}</strong> —{' '}
                  {payload.compatibilityReason}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Configuration + execution rail --------------------------------- */}
        {payload && (
          <aside
            aria-label="Bot configuration and execution"
            className={`${
              railOpen ? 'lg:flex' : 'lg:hidden'
            } absolute lg:static inset-y-0 right-0 z-30 w-[330px] max-w-[85vw] shrink-0 flex-col border-l border-line bg-canvas overflow-y-auto`}
          >
            <TradingConfigPanel botId={botId} payload={payload} dirty={dirty} />
            <div className="border-t border-line" />
            <ExecutionRail
              botId={botId}
              dirty={dirty}
              symbol={config?.symbol ?? null}
              contractType={config?.contractType ?? null}
            />
          </aside>
        )}

        {/* Rail scrim on small screens ------------------------------------ */}
        {payload && railOpen && (
          <button
            type="button"
            aria-label="Close the configuration rail"
            onClick={() => setRailOpen(false)}
            className="lg:hidden absolute inset-0 z-20 bg-app/60 cursor-pointer"
          />
        )}
      </div>

      {importing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-app/70 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Import a bot"
        >
          <div className="w-full max-w-2xl">
            <div className="flex items-center justify-between px-1 pb-2">
              <h2 className="text-sm font-bold text-ink">Import a strategy</h2>
              <button
                type="button"
                onClick={() => setImporting(false)}
                className="px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
            <BotImporter
              onImported={(bot) => {
                setImporting(false);
                if (bot?.id) onOpenBot(bot.id);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Counts nodes the server flagged as unknown, for the editor banner. */
function countUnknownNodes(payload: BotEditorPayload): number {
  let count = 0;
  const walk = (node: BotEditorPayload['tree']['blocks'][number] | null) => {
    if (!node) return;
    if (node.unknown) count += 1;
    if (node.next) walk(node.next);
    for (const input of node.inputs) walk(input.block);
  };
  for (const block of payload.tree.blocks) walk(block);
  return count;
}
