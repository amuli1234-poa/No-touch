import { useMemo } from 'react';
import { useRegisterModuleOverlay } from '../../context/ModuleOverlayContext';
import type { AiChartOverlay } from './AiChartPrimitive';
import type { AiZone } from '../../types/aiModule';
import type { TrendlineChartOverlay } from './TrendlineChartPrimitive';
import type { DsChartOverlay } from './DsChartPrimitive';
import type { StructureChartOverlay } from './StructureChartPrimitive';
import type { DsZone } from '../../types/demandSupply';
import type { FutureReactionZone } from '../../types/structure';
import type { ModuleChartOverlay } from '../../types/chartOverlay';


interface ModuleChartSlotProps {
  aiOverlay?: AiChartOverlay | null;
  trendlineOverlay?: TrendlineChartOverlay | null;
  dsOverlay?: DsChartOverlay | null;
  structureOverlay?: StructureChartOverlay | null;
  onAiZoneSelect?: (zone: AiZone) => void;
  onDsZoneSelect?: (zone: DsZone) => void;
  onStructureZoneSelect?: (zone: FutureReactionZone) => void;
}

/**
 * A module's window onto the ONE shared chart. It renders NO canvas — it only publishes the
 * module's overlay into the shared chart and wires tap-to-inspect callbacks. This is what
 * guarantees exactly one candlestick chart exists in the entire application.
 */
export function ModuleChartSlot({
  aiOverlay,
  trendlineOverlay,
  dsOverlay,
  structureOverlay,
  onAiZoneSelect,
  onDsZoneSelect,
  onStructureZoneSelect,
}: ModuleChartSlotProps): null {
  // Memoised on the overlay contents: the registration effect keys on this object's
  // identity, so a fresh literal every render would push a new overlay each render and
  // loop (setOverlay -> App re-render -> new literal -> ...).
  const overlay = useMemo<ModuleChartOverlay>(
    () => ({
      aiOverlay: aiOverlay ?? null,
      trendlineOverlay: trendlineOverlay ?? null,
      dsOverlay: dsOverlay ?? null,
      structureOverlay: structureOverlay ?? null,
      onAiZoneSelect,
      onDsZoneSelect,
      onStructureZoneSelect,
    }),
    [
      aiOverlay,
      trendlineOverlay,
      dsOverlay,
      structureOverlay,
      onAiZoneSelect,
      onDsZoneSelect,
      onStructureZoneSelect,
    ]
  );
  useRegisterModuleOverlay(overlay);
  return null;
}
