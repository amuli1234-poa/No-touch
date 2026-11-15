import { createContext, useContext, useEffect } from 'react';
import type { ModuleChartOverlay } from '../types/chartOverlay';

/**
 * Publishes a module's chart overlay into the ONE shared chart. Modules never render a chart
 * of their own — they register their overlay here while mounted and clear it on unmount.
 */
export interface ModuleOverlayValue {
  overlay: ModuleChartOverlay | null;
  setOverlay: (overlay: ModuleChartOverlay | null) => void;
}

const ModuleOverlayContext = createContext<ModuleOverlayValue | null>(null);

export const ModuleOverlayProvider = ModuleOverlayContext.Provider;

export function useModuleOverlay(): ModuleOverlayValue {
  const ctx = useContext(ModuleOverlayContext);
  if (!ctx) throw new Error('useModuleOverlay must be used within a ModuleOverlayProvider');
  return ctx;
}

/**
 * Registers a module overlay with the shared chart. The overlay is intentionally kept out of
 * the workspace context so live-tick updates never re-render the whole application shell.
 */
export function useRegisterModuleOverlay(value: ModuleChartOverlay | null): void {
  const ctx = useContext(ModuleOverlayContext);
  const setOverlay = ctx?.setOverlay;
  useEffect(() => {
    if (!setOverlay) return;
    setOverlay(value);
    return () => setOverlay(null);
    // The overlay object is recreated per render; keying on its identity is intentional so a
    // module can push updated zones without remounting.
  }, [setOverlay, value]);
}
