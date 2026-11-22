/**
 * Blockly workspace host.
 *
 * Blockly is loaded lazily through `./runtime`, which is the only module that
 * imports it. A session that never opens the editor never downloads Blockly.
 *
 * Division of labour:
 *   * the server owns parsing and validation — it turns XML into a tree and
 *     back, and its round-trip is covered by tests;
 *   * the browser owns rendering — Blockly reads the XML the server produced
 *     and writes XML back on save.
 *
 * No XML is serialised here: `onChange` hands Blockly's own XML to the caller,
 * which posts it to the server for authoritative parsing.
 */

import { useEffect, useRef, useState } from 'react';

import type { EditorControls, MountedEditor } from './runtime';
import type { UnknownBlockSeed } from './types';

export type { UnknownBlockSeed } from './types';
export type { EditorControls } from './runtime';

export interface StrategyWorkspaceProps {
  /** DBot XML to render. The parent remounts to load a different strategy. */
  xml: string;
  /**
   * Unknown block types in this strategy, so a placeholder definition exists
   * before Blockly reads the XML. Without this, Blockly would skip them and a
   * save would delete them.
   */
  unknownBlocks: UnknownBlockSeed[];
  /** Called with Blockly's XML whenever the user changes the strategy. */
  onChange: (xml: string) => void;
  /** Read-only mode, for a bot that cannot be edited. */
  readOnly?: boolean;
  /** Receives the imperative handles so the toolbar can drive the canvas. */
  onReady?: (controls: EditorControls | null) => void;
}

export function StrategyWorkspace({
  xml,
  unknownBlocks,
  onChange,
  readOnly,
  onReady
}: StrategyWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  onChangeRef.current = onChange;
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let mounted: MountedEditor | null = null;

    (async () => {
      try {
        const runtime = await import('./runtime');
        if (disposed) return;
        mounted = runtime.mountEditor(host, {
          xml,
          unknownBlocks,
          readOnly,
          onChange: (next) => onChangeRef.current(next)
        });
        if (disposed) {
          mounted.dispose();
          mounted = null;
          return;
        }
        setReady(true);
        onReadyRef.current?.(mounted.controls);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'The editor could not be loaded.');
        }
      }
    })();

    return () => {
      disposed = true;
      onReadyRef.current?.(null);
      mounted?.dispose();
      mounted = null;
    };
    // Mounted once: a different strategy is a different mount, because the
    // parent keys this component by bot id and revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-sm text-center text-xs leading-relaxed text-danger">{error}</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-deepest/70">
          <p className="text-xs text-muted">Loading editor…</p>
        </div>
      )}
    </div>
  );
}
