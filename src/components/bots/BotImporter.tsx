import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Upload, X } from 'lucide-react';
import {
  BotApiError,
  confirmImport,
  previewBot,
  type BotPreview,
  type BotRecord
} from '../../lib/bots';
import { Card, SectionCard } from '../ui/primitives';
import { ImportPreview } from './ImportPreview';

/**
 * BOT IMPORTER — import an existing Deriv DBot strategy from local disk.
 *
 * Flow: pick a file -> read it as text -> server parses and validates ->
 * preview -> confirm. The file is read in the browser but parsed only on the
 * server, so a hostile document never reaches a parser inside the app.
 *
 * Nothing here executes a bot. Confirming an import writes an inert record.
 */

/** Matches the server ceiling; checked here too so oversized files fail fast. */
const MAX_BYTES = 2 * 1024 * 1024;

type Stage = 'idle' | 'reading' | 'validating' | 'preview' | 'saving' | 'done';

interface SelectedFile {
  name: string;
  size: number;
  content: string;
}

export interface BotImporterProps {
  /** Called after a successful import so the manager can refresh. */
  onImported?: (bot: BotRecord, duplicate: boolean) => void;
}

export function BotImporter({ onImported }: BotImporterProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [file, setFile] = useState<SelectedFile | null>(null);
  const [preview, setPreview] = useState<BotPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ bot: BotRecord; duplicate: boolean } | null>(null);

  const reset = useCallback(() => {
    setStage('idle');
    setFile(null);
    setPreview(null);
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const handleFile = useCallback(async (selected: File) => {
    setError(null);
    setResult(null);
    setPreview(null);

    if (!selected.name.toLowerCase().endsWith('.xml')) {
      setFile(null);
      setStage('idle');
      setError('Only .xml files exported from Deriv DBot can be imported.');
      return;
    }
    if (selected.size > MAX_BYTES) {
      setFile(null);
      setStage('idle');
      setError(
        `That file is ${Math.round(selected.size / 1024)} KB. The limit is ${MAX_BYTES / 1024} KB.`
      );
      return;
    }

    setStage('reading');
    let text: string;
    try {
      text = await selected.text();
    } catch {
      setStage('idle');
      setError('The file could not be read from disk.');
      return;
    }

    setFile({ name: selected.name, size: selected.size, content: text });
    setStage('validating');
    try {
      const analysed = await previewBot(selected.name, text);
      setPreview(analysed);
      setStage('preview');
    } catch (e) {
      setStage('idle');
      setError(e instanceof BotApiError ? e.message : 'The file could not be validated.');
    }
  }, []);

  const onConfirm = useCallback(async () => {
    if (!file) return;
    setStage('saving');
    setError(null);
    try {
      const imported = await confirmImport(file.name, file.content);
      setResult(imported);
      setStage('done');
      onImported?.(imported.bot, imported.duplicate);
    } catch (e) {
      setStage('preview');
      setError(e instanceof BotApiError ? e.message : 'The import could not be saved.');
    }
  }, [file, onImported]);

  const busy = stage === 'reading' || stage === 'validating' || stage === 'saving';

  return (
    <SectionCard
      title="Import a bot"
      subtitle="Bring an existing Deriv DBot strategy in from your computer"
      icon={<FileUp className="w-4 h-4" aria-hidden="true" />}
      right={
        file && stage !== 'done' ? (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-muted hover:text-ink border border-line hover:border-accent/50 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            Cancel
          </button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {/* File picker ---------------------------------------------------- */}
        <input
          ref={inputRef}
          type="file"
          accept=".xml,application/xml,text/xml"
          className="hidden"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) void handleFile(selected);
          }}
        />

        {!file && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line hover:border-accent/60 bg-panel/50 hover:bg-panel transition-colors py-8 px-4 cursor-pointer"
          >
            <span className="w-10 h-10 rounded-full bg-surface border border-line text-accent flex items-center justify-center">
              <Upload className="w-5 h-5" aria-hidden="true" />
            </span>
            <span className="text-sm font-bold text-ink">Choose a .xml bot file</span>
            <span className="text-[11px] text-muted">
              Select the file Deriv DBot saved to your computer
            </span>
          </button>
        )}

        {/* Selected file + progress --------------------------------------- */}
        {file && (
          <Card className="p-3">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-surface border border-line text-accent flex items-center justify-center shrink-0">
                <FileUp className="w-4 h-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-ink truncate">{file.name}</p>
                <p className="text-[11px] text-faint">
                  {(file.size / 1024).toFixed(1)} KB · XML
                </p>
              </div>
              {busy && <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" aria-hidden="true" />}
            </div>
            <p className="text-[11px] text-muted mt-2" role="status" aria-live="polite">
              {stage === 'reading' && 'Reading the file…'}
              {stage === 'validating' && 'Validating the DBot structure…'}
              {stage === 'preview' && 'Validated. Review the interpretation below.'}
              {stage === 'saving' && 'Saving the imported bot…'}
              {stage === 'done' && 'Import complete.'}
            </p>
          </Card>
        )}

        {/* Errors --------------------------------------------------------- */}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" aria-hidden="true" />
            <p className="text-xs text-rose-300 leading-relaxed">{error}</p>
          </div>
        )}

        {/* Result --------------------------------------------------------- */}
        {stage === 'done' && result && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-emerald-300">
                {result.duplicate ? 'This bot was already imported' : `Imported "${result.bot.name}"`}
              </p>
              <p className="text-[11px] text-emerald-200/70 mt-0.5 leading-relaxed">
                {result.duplicate
                  ? 'An identical file already exists in My Bots, so no duplicate was created.'
                  : 'It now appears in My Bots. Importing does not authorise execution.'}
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="ml-auto text-[11px] font-semibold text-emerald-300 hover:text-emerald-200 shrink-0 cursor-pointer"
            >
              Import another
            </button>
          </div>
        )}

        {/* Preview -------------------------------------------------------- */}
        {preview && (stage === 'preview' || stage === 'saving') && (
          <>
            <ImportPreview preview={preview} />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onConfirm()}
                disabled={preview.compatibility === 'invalid' || stage === 'saving'}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-white text-xs font-bold hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {stage === 'saving' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {stage === 'saving' ? 'Importing…' : 'Confirm import'}
              </button>
              <button
                type="button"
                onClick={reset}
                disabled={stage === 'saving'}
                className="px-3.5 py-2 rounded-lg border border-line text-xs font-semibold text-muted hover:text-ink hover:border-accent/50 disabled:opacity-50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
            {preview.compatibility === 'invalid' && (
              <p className="text-[11px] text-rose-400">
                This file cannot be imported because it is not a valid DBot strategy.
              </p>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
