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

import {
  isUnknownBlockType,
  originalBlockType,
  registerBlocksMissingFromXml,
  registerStrategyBlocks,
  registerUnknownBlocks,
  strategyToolbox,
  unknownBlockType
} from './blocks';
import { strategyTheme } from './theme';
import type { UnknownBlockSeed } from './types';

export interface MountOptions {
  xml: string;
  unknownBlocks: UnknownBlockSeed[];
  readOnly?: boolean;
  toolboxVisible?: boolean;
  onChange: (xml: string) => void;
}

/**
 * Imperative handles the toolbar drives. They only move the viewport or the
 * undo stack — never the stored strategy — so a control cannot mutate XML
 * behind the caller's back.
 */
export interface EditorControls {
  undo: () => void;
  redo: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToFit: () => void;
  setToolboxVisible: (visible: boolean) => void;
  resize: () => void;
  /** Empties the canvas. The caller decides whether that is confirmed. */
  clear: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

export interface MountedEditor {
  controls: EditorControls;
  dispose: () => void;
}

function restoreOriginalTypes(root: Element): void {
  const nodes = [root, ...Array.from(root.querySelectorAll('block, shadow'))];
  for (const node of nodes) {
    const type = node.getAttribute('type');
    if (type && isUnknownBlockType(type)) {
      node.setAttribute('type', originalBlockType(type));
    }
  }
}

/**
 * Injects a Blockly workspace into `host`, loads the strategy, and reports
 * user edits through `onChange`.
 */
export function mountEditor(host: Element, options: MountOptions): MountedEditor {
  // The module's type carries a synthetic `default` that is not a message, so
  // it has to be narrowed to the plain string map `setLocale` expects.
  Blockly.setLocale(EnMessages as unknown as Record<string, string>);
  let root: Element | null = null;
  const observed = new Map<string, Set<string>>();
  if (options.xml.trim()) {
    const doc = new DOMParser().parseFromString(options.xml, 'text/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('The strategy XML could not be read by the editor.');
    }
    root = doc.documentElement;
    if (!root || root.nodeName !== 'xml') {
      throw new Error('The strategy XML has no <xml> root element.');
    }
    for (const field of Array.from(root.querySelectorAll('field[name]'))) {
      const name = field.getAttribute('name');
      if (!name) continue;
      let values = observed.get(name);
      if (!values) {
        values = new Set<string>();
        observed.set(name, values);
      }
      values.add(field.textContent ?? '');
    }
  }
  registerStrategyBlocks(observed);
  registerUnknownBlocks(options.unknownBlocks);
  // The server only seeds types it reports as unsupported, so a type the engine
  // executes but the editor never declared gets neither a declaration nor a
  // placeholder — and one undefined type aborts the whole load. Scanning the
  // document closes that gap: any undeclared type becomes a placeholder.
  const unregistered = root ? registerBlocksMissingFromXml(root) : new Set<string>();

  const toolbox = strategyToolbox() as never;
  const ws = Blockly.inject(host, {
    theme: strategyTheme,
    toolbox: options.toolboxVisible === false ? undefined : toolbox,
    toolboxPosition: 'left',
    readOnly: Boolean(options.readOnly),
    renderer: 'zelos',
    grid: { spacing: 24, length: 2, colour: '#1a2438', snap: true },
    zoom: {
      controls: false,
      wheel: true,
      startScale: 0.85,
      maxScale: 2,
      minScale: 0.35,
      scaleSpeed: 1.15
    },
    move: { scrollbars: true, drag: true, wheel: !options.readOnly },
    trashcan: !options.readOnly
  });

  if (root) {
    const placeholderTypes = new Set([
      ...options.unknownBlocks.map((block) => `${block.type}\0${block.shape}`),
      ...unregistered
    ]);
    const nodes = [root, ...Array.from(root.querySelectorAll('block, shadow'))];
    for (const node of nodes) {
      const type = node.getAttribute('type');
      const shape = node.parentElement?.nodeName === 'value' ? 'value' : 'stack';
      if (type && placeholderTypes.has(`${type}\0${shape}`)) {
        node.setAttribute('type', unknownBlockType(type, shape));
      }
    }
    Blockly.Xml.domToWorkspace(root, ws);
  }
  ws.clearUndo();

  // Blockly keeps firing events after the load returns (layout, viewport,
  // deferred block creation), so a timer is not a reliable "load finished"
  // signal — it marked an untouched strategy as having unsaved changes. Compare
  // against the canonical form of what was just loaded instead: only a real
  // difference is a user edit.
  const serializeWorkspace = () => {
    const dom = Blockly.Xml.workspaceToDom(ws);
    restoreOriginalTypes(dom);
    return Blockly.Xml.domToPrettyText(dom);
  };
  const baseline = serializeWorkspace();
  const listener = (event: Blockly.Events.Abstract) => {
    if (event.isUiEvent) return;
    if (event.type === Blockly.Events.VIEWPORT_CHANGE) return;
    const next = serializeWorkspace();
    if (next === baseline) return;
    options.onChange(next);
  };
  ws.addChangeListener(listener);

  const controls: EditorControls = {
    undo: () => ws.undo(false),
    redo: () => ws.undo(true),
    zoomIn: () => ws.zoomCenter(1),
    zoomOut: () => ws.zoomCenter(-1),
    zoomToFit: () => ws.zoomToFit(),
    setToolboxVisible: (visible) => {
      const currentToolbox = ws.getToolbox();
      if (!currentToolbox) throw new Error('The Blockly toolbox is unavailable.');
      currentToolbox.setVisible(visible);
      Blockly.svgResize(ws);
    },
    resize: () => Blockly.svgResize(ws),
    clear: () => {
      // Cleared through the same event path as a manual delete, so the caller's
      // change handler observes the emptied workspace and can mark it dirty.
      Blockly.Events.setGroup('ws-reset');
      ws.clear();
      Blockly.Events.setGroup(false);
    },
    canUndo: () => ws.getUndoStack().length > 0,
    canRedo: () => ws.getRedoStack().length > 0
  };

  return {
    controls,
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
