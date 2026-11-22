/**
 * The only module that touches Blockly.
 *
 * Everything Blockly-related is reached through `loadEditor()`, which is
 * dynamically imported by the editor view. That keeps Blockly's ~1 MB out of
 * the main bundle: a session that never opens the block editor never downloads
 * it.
 *
 * Nothing else in the app may import `blockly/core` directly, or the split
 * silently collapses back into the main chunk.
 */

import * as Blockly from 'blockly/core';
import 'blockly/blocks';
// `blockly/core` ships no message catalogue, so every `Blockly.Msg` string is
// undefined until a locale is applied — Blockly's own ARIA setup calls
// `.replace()` on those strings and throws during `inject()`. English is the
// only locale this app ships.
import * as EnMessages from 'blockly/msg/en';

import { registerStrategyBlocks, registerUnknownBlocks, strategyToolbox } from './blocks';
import { strategyTheme } from './theme';
import type { UnknownBlockSeed } from './types';

export interface MountOptions {
  xml: string;
  unknownBlocks: UnknownBlockSeed[];
  readOnly?: boolean;
  onChange: (xml: string) => void;
}

export interface MountedEditor {
  dispose: () => void;
}

/**
 * Injects a Blockly workspace into `host`, loads the strategy, and reports
 * user edits through `onChange`.
 */
export function mountEditor(host: Element, options: MountOptions): MountedEditor {
  // The module's type carries a synthetic `default` that is not a message, so
  // it has to be narrowed to the plain string map `setLocale` expects.
  Blockly.setLocale(EnMessages as unknown as Record<string, string>);
  registerStrategyBlocks();
  registerUnknownBlocks(options.unknownBlocks);

  const ws = Blockly.inject(host, {
    theme: strategyTheme,
    toolbox: strategyToolbox() as never,
    readOnly: Boolean(options.readOnly),
    renderer: 'zelos',
    grid: { spacing: 24, length: 2, colour: '#1a2438', snap: true },
    zoom: {
      controls: true,
      wheel: true,
      startScale: 0.85,
      maxScale: 2,
      minScale: 0.35,
      scaleSpeed: 1.15
    },
    move: { scrollbars: true, drag: true, wheel: !options.readOnly },
    trashcan: !options.readOnly
  });

  if (options.xml.trim()) {
    const doc = new DOMParser().parseFromString(options.xml, 'text/xml');
    if (doc.querySelector('parsererror')) {
      ws.dispose();
      throw new Error('The strategy XML could not be read by the editor.');
    }
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'xml') {
      ws.dispose();
      throw new Error('The strategy XML has no <xml> root element.');
    }
    Blockly.Xml.domToWorkspace(root, ws);
  }
  ws.clearUndo();

  // Blockly keeps firing events after the load returns (layout, viewport,
  // deferred block creation), so a timer is not a reliable "load finished"
  // signal — it marked an untouched strategy as having unsaved changes. Compare
  // against the canonical form of what was just loaded instead: only a real
  // difference is a user edit.
  const baseline = Blockly.Xml.domToPrettyText(Blockly.Xml.workspaceToDom(ws));
  const listener = (event: Blockly.Events.Abstract) => {
    if (event.isUiEvent) return;
    if (event.type === Blockly.Events.VIEWPORT_CHANGE) return;
    const next = Blockly.Xml.domToPrettyText(Blockly.Xml.workspaceToDom(ws));
    if (next === baseline) return;
    options.onChange(next);
  };
  ws.addChangeListener(listener);

  return {
    dispose: () => {
      ws.removeChangeListener(listener);
      try {
        ws.dispose();
      } catch {
        /* disposing twice must not throw */
      }
    }
  };
}
