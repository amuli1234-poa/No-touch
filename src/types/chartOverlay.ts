import type { AiChartOverlay } from '../components/chart/AiChartPrimitive';
import type { AiZone } from './aiModule';
import type { TrendlineChartOverlay } from '../components/chart/TrendlineChartPrimitive';
import type { DsChartOverlay } from '../components/chart/DsChartPrimitive';
import type { StructureChartOverlay } from '../components/chart/StructureChartPrimitive';
import type { DsZone } from '../types/demandSupply';
import type { FutureReactionZone } from '../types/structure';

/**
 * Overlay bundle pushed by a module into the ONE shared chart. A module never renders its own
 * chart — it publishes an overlay here and the app shell draws it on the single canvas.
 */
export interface ModuleChartOverlay {
  aiOverlay?: AiChartOverlay | null;
  trendlineOverlay?: TrendlineChartOverlay | null;
  dsOverlay?: DsChartOverlay | null;
  structureOverlay?: StructureChartOverlay | null;
  onAiZoneSelect?: (zone: AiZone) => void;
  onDsZoneSelect?: (zone: DsZone) => void;
  onStructureZoneSelect?: (zone: FutureReactionZone) => void;
}
