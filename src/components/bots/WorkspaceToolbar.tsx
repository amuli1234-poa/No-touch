import { useState } from 'react';
import {
  ArrowLeft,
  Download,
  Loader2,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Eraser,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-react';

/**
 * The strip above the Blockly canvas.
 *
 * Every control here maps to something that already exists: import opens the
 * existing importer, export hits the existing download route, undo/redo/zoom/
 * clear drive Blockly's own workspace. Nothing is decorative, and nothing
 * claims a capability the build does not have.
 */

export interface WorkspaceToolbarProps {
  name: string;
  subtitle: string;
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  canRevert: boolean;
  /** False until Blockly has mounted, so canvas controls are not clickable early. */
  editorReady: boolean;
  onBack: () => void;
  onImport: () => void;
  onSave: () => void;
  onExport: string;
  onRevert: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onResetWorkspace: () => void;
  toolboxOpen: boolean;
  onToggleToolbox: () => void;
  /** Whether the run panel is showing; drives the labelled toggle. */
  railOpen: boolean;
  onToggleRail: () => void;
}

const iconButton =
  'inline-flex items-center justify-center gap-1.5 h-8 px-2 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:border-line disabled:hover:text-muted';

export function WorkspaceToolbar({
  name,
  subtitle,
  dirty,
  saving,
  canSave,
  canRevert,
  editorReady,
  onBack,
  onImport,
  onSave,
  onExport,
  onRevert,
  onDelete,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onResetWorkspace,
  toolboxOpen,
  onToggleToolbox,
  railOpen,
  onToggleRail
}: WorkspaceToolbarProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 px-2.5 py-2 border-b border-line bg-surface shrink-0">
      <button type="button" onClick={onBack} className={iconButton} title="Back to My Bots">
        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Bots</span>
      </button>

      <div className="min-w-0 flex-1 px-1">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-[13px] font-bold text-ink truncate leading-tight">{name}</p>
          {dirty && (
            <span
              className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-warning/15 text-warning border border-warning/30"
              title="The canvas differs from the saved strategy"
            >
              Unsaved
            </span>
          )}
        </div>
        <p className="text-[10.5px] text-faint truncate leading-tight mt-0.5">{subtitle}</p>
      </div>

      {/* History ------------------------------------------------------- */}
      <div className="flex items-center rounded-lg border border-line overflow-hidden">
        <button
          type="button"
          onClick={onUndo}
          disabled={!editorReady}
          title="Undo"
          aria-label="Undo"
          className="h-8 w-8 inline-flex items-center justify-center text-muted hover:text-ink hover:bg-surface-raised transition-colors disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
        >
          <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <span className="w-px h-5 bg-line" />
        <button
          type="button"
          onClick={onRedo}
          disabled={!editorReady}
          title="Redo"
          aria-label="Redo"
          className="h-8 w-8 inline-flex items-center justify-center text-muted hover:text-ink hover:bg-surface-raised transition-colors disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
        >
          <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Zoom ---------------------------------------------------------- */}
      <div className="flex items-center rounded-lg border border-line overflow-hidden">
        <button
          type="button"
          onClick={onZoomOut}
          disabled={!editorReady}
          title="Zoom out"
          aria-label="Zoom out"
          className="h-8 w-8 inline-flex items-center justify-center text-muted hover:text-ink hover:bg-surface-raised transition-colors disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
        >
          <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <span className="w-px h-5 bg-line" />
        <button
          type="button"
          onClick={onZoomFit}
          disabled={!editorReady}
          title="Fit strategy to screen"
          aria-label="Fit strategy to screen"
          className="h-8 w-8 inline-flex items-center justify-center text-muted hover:text-ink hover:bg-surface-raised transition-colors disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
        >
          <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <span className="w-px h-5 bg-line" />
        <button
          type="button"
          onClick={onZoomIn}
          disabled={!editorReady}
          title="Zoom in"
          aria-label="Zoom in"
          className="h-8 w-8 inline-flex items-center justify-center text-muted hover:text-ink hover:bg-surface-raised transition-colors disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
        >
          <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>

      {confirmReset ? (
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              onResetWorkspace();
              setConfirmReset(false);
            }}
            title="Remove every block from the canvas"
            className="h-8 px-2 rounded-lg bg-warning text-black text-[11px] font-bold cursor-pointer"
          >
            Clear canvas
          </button>
          <button
            type="button"
            onClick={() => setConfirmReset(false)}
            className={iconButton}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          disabled={!editorReady}
          title="Reset the workspace"
          aria-label="Reset the workspace"
          className={`${iconButton} w-8 px-0`}
        >
          <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}

      <span className="hidden md:block w-px h-6 bg-line" />

      <button
        type="button"
        onClick={onToggleToolbox}
        disabled={!editorReady}
        aria-expanded={toolboxOpen}
        aria-label={toolboxOpen ? 'Hide the block toolbox' : 'Show the block toolbox'}
        title={toolboxOpen ? 'Hide the block toolbox' : 'Show the block toolbox'}
        className={`${iconButton} px-2`}
      >
        {toolboxOpen ? (
          <PanelLeftClose className="w-3.5 h-3.5" aria-hidden="true" />
        ) : (
          <PanelLeftOpen className="w-3.5 h-3.5" aria-hidden="true" />
        )}
        <span className="hidden xl:inline">{toolboxOpen ? 'Hide toolbox' : 'Show toolbox'}</span>
      </button>

      <button
        type="button"
        onClick={onToggleRail}
        aria-expanded={railOpen}
        aria-label={railOpen ? 'Hide the run panel' : 'Show the run panel'}
        title={railOpen ? 'Hide the run panel' : 'Show the run panel'}
        className={`${iconButton} px-2`}
      >
        {railOpen ? (
          <PanelRightClose className="w-3.5 h-3.5" aria-hidden="true" />
        ) : (
          <PanelRightOpen className="w-3.5 h-3.5" aria-hidden="true" />
        )}
        <span className="hidden xl:inline">{railOpen ? 'Hide panel' : 'Show panel'}</span>
      </button>

      <button type="button" onClick={onImport} className={iconButton} title="Import a DBot .xml file">
        <Upload className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Import</span>
      </button>

      {canRevert && (
        <button
          type="button"
          onClick={onRevert}
          className={iconButton}
          title="Discard saved edits and restore the imported file"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="hidden lg:inline">Revert</span>
        </button>
      )}

      <a href={onExport} className={iconButton} title="Download this strategy as XML">
        <Download className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Export</span>
      </a>

      <button
        type="button"
        onClick={onSave}
        disabled={!canSave || saving}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-accent text-white text-[11px] font-bold hover:bg-accent-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        title={canSave ? 'Save the strategy' : 'No unsaved changes'}
      >
        {saving ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Save className="w-3.5 h-3.5" aria-hidden="true" />
        )}
        {saving ? 'Saving' : 'Save'}
      </button>

      {confirmDelete ? (
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onDelete}
            className="h-8 px-2 rounded-lg bg-danger text-white text-[11px] font-bold cursor-pointer"
          >
            Delete
          </button>
          <button type="button" onClick={() => setConfirmDelete(false)} className={iconButton}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          title="Delete this bot"
          aria-label="Delete this bot"
          className={`${iconButton} w-8 px-0 hover:text-danger hover:border-danger/50`}
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
