import { useMemo, useSyncExternalStore } from 'react';
import { DrawingStore, type DrawingState } from './DrawingStore';
import { drawingsToOverlayShapes } from './geometry';
import type { OverlayShape } from '../../components/chart/chartOverlays';

/**
 * React bindings for the drawing store.
 *
 * The store itself is framework-agnostic; this hook is the only place React
 * touches it. It exposes a stable snapshot (so `useSyncExternalStore` does not
 * loop) plus the overlay shapes for the active symbol/timeframe.
 */
export function useDrawings(store: DrawingStore): DrawingState & {
  shapes: (symbol: string, timeframe?: string) => OverlayShape[];
} {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const shapes = useMemo(
    () => (symbol: string, timeframe?: string) =>
      drawingsToOverlayShapes(state.records, { visible: state.visible, symbol, timeframe }),
    [state]
  );

  return { ...state, shapes };
}
