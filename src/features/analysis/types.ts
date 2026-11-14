import type { Timeframe } from '../../types/scanner';
import type {
  EngineDirection,
  EngineStatus,
  EngineZone,
  MarketSnapshot
} from './engines/types';

/**
 * Analysis result contract.
 *
 * The shape makes fabrication structurally hard: a result always carries the
 * snapshot it was computed from, the real status of every engine, and an
 * explicit `WAIT`/`FAILED` state. There is no field for a made-up probability,
 * and `zone` is null whenever validation did not produce one.
 */

export type AnalysisStageId =
  | 'market-data'
  | 'technical'
  | 'ai-engines'
  | 'comparison'
  | 'validation';

export type AnalysisStageStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface AnalysisStage {
  id: AnalysisStageId;
  label: string;
  status: AnalysisStageStatus;
  detail?: string;
}

export type AnalysisStatus = 'RUNNING' | 'COMPLETED' | 'WAIT' | 'FAILED';

export interface EngineRunRecord {
  engineId: string;
  engineName: string;
  status: EngineStatus;
  /** Why the engine is unavailable / failed, when applicable. */
  reason?: string;
  /** Real completion time; absent unless the engine actually ran to completion. */
  completedAtMs?: number;
  direction?: EngineDirection;
  score?: number;
  summary?: string;
  zoneCount?: number;
}

export interface AnalysisResult {
  id: string;
  symbol: string;
  displayName: string;
  timeframe: Timeframe;
  status: AnalysisStatus;
  direction: EngineDirection;
  /** The verified snapshot the result was computed from. */
  snapshot: MarketSnapshot;
  engines: EngineRunRecord[];
  /** The single validated zone, or null when none was validated. */
  zone: EngineZone | null;
  /** Honest notes: why it is WAIT, what disagreed, what was missing. */
  notes: string[];
  startedAtMs: number;
  completedAtMs: number;
  error?: string;
}

export interface RunAnalysisInput {
  symbol: string;
  displayName: string;
  timeframe: Timeframe;
  /** Candles for the active timeframe, from the market-data service. */
  candles: readonly { epoch: number; open: number; high: number; low: number; close: number }[];
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  /** True when the feed has flagged the symbol's data as stale. */
  isStale?: boolean;
  engines: import('./engines/types').AnalysisEngine[];
  /** Called as stages actually transition, so the UI shows real progress. */
  onProgress?: (stages: AnalysisStage[]) => void;
  /** Injectable clock/id for deterministic tests. */
  now?: () => number;
  id?: string;
  /** Milliseconds before the run is abandoned. */
  timeoutMs?: number;
}

export interface AnalysisPrerequisites {
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  hasSymbol: boolean;
  hasTimeframe: boolean;
  candleCount: number;
  /** Minimum candles required before analysis is meaningful. */
  minCandles: number;
  isStale?: boolean;
}

/**
 * Whether RUN ANALYSIS may proceed. The UI disables the button on `ok === false`
 * and shows the reason, so the user is never invited to run an analysis that
 * cannot succeed.
 */
export function checkPrerequisites(p: AnalysisPrerequisites): { ok: boolean; reason?: string } {
  if (p.connectionState !== 'CONNECTED') {
    return { ok: false, reason: 'Market feed is not connected.' };
  }
  if (!p.hasSymbol) return { ok: false, reason: 'No instrument selected.' };
  if (!p.hasTimeframe) return { ok: false, reason: 'No timeframe selected.' };
  if (p.candleCount < p.minCandles) {
    return { ok: false, reason: `Waiting for candle history (${p.candleCount}/${p.minCandles}).` };
  }
  if (p.isStale) return { ok: false, reason: 'Market data is stale.' };
  return { ok: true };
}
