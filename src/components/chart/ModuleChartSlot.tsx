import { useRegisterModuleOverlay } from '../../context/ModuleOverlayContext';
import type { AiChartOverlay } from './AiChartPrimitive';
import type { AiZone } from '../../types/aiModule';
import type { TrendlineChartOverlay } from './TrendlineChartPrimitive';
import type { DsChartOverlay } from './DsChartPrimitive';
import type { StructureChartOverlay } from './StructureChartPrimitive';
import type { DsZone } from '../../types/demandSupply';
import type { FutureReactionZone } from '../../types/structure';


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
export function ModuleChartSlot(props: ModuleChartSlotProps): null {
  useRegisterModuleOverlay({
    aiOverlay: props.aiOverlay ?? null,
    trendlineOverlay: props.trendlineOverlay ?? null,
    dsOverlay: props.dsOverlay ?? null,
    structureOverlay: props.structureOverlay ?? null,
    onAiZoneSelect: props.onAiZoneSelect,
    onDsZoneSelect: props.onDsZoneSelect,
    onStructureZoneSelect: props.onStructureZoneSelect,
  });
  return null;
}
