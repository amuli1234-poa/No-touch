import type { Timeframe } from '../../../types/scanner';

/**
 * The immutable, verified market snapshot handed to analysis engines.
 *
 * An engine never reads the live feed directly: it receives this object, which
 * carries its own provenance (source, freshness, completeness) so a result can
 * never be produced from data whose age or completeness is unknown.
 */
export interface MarketSnapshot {
  /** Instrument symbol, e.g. `R_100`. */
  symbol: string;
  /** Display name for the UI. */
  displayName: string;
  /** Timeframe the candles are sampled at. */
  timeframe: Timeframe;
  /** Candle length in seconds. */
  timeframeSeconds: number;
  /** Where the data came from. Always the Deriv feed for live analysis. */
  source: string;
  /** Epoch ms of the newest candle's close. */
  lastCandleEpochMs: number;
  /** Epoch ms the snapshot was taken. */
  capturedAtMs: number;
  /** Age of the newest candle at capture time, in ms. */
  freshnessMs: number;
  /** Whether the bar set is considered complete enough to analyse. */
  complete: boolean;
  /** Reason the snapshot is incomplete, when `complete` is false. */
  incompleteReason?: string;
  /** Candle count actually included. */
  candleCount: number;
  /** Newest close price, for reference. */
  lastPrice: number;
}

export type EngineStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNAVAILABLE';

/** A directional lean an engine may express. `WAIT` is a first-class answer. */
export type EngineDirection = 'RISE' | 'FALL' | 'WAIT';

export interface EngineZone {
  direction: 'RISE' | 'FALL';
  timeframe: Timeframe;
  upperPrice: number;
  lowerPrice: number;
  /** Human-readable reason the zone was identified. */
  reason: string;
  /** Evidence items the engine based the zone on. */
  evidence: string[];
  /** Optional invalidation condition the engine defined for the zone. */
  invalidation?: string;
  /** Zone window start, in candle epoch seconds (chart time coordinate). */
  startEpoch?: number;
  /** Zone window end, in candle epoch seconds (chart time coordinate). */
  endEpoch?: number;
  /** The engine's own confidence, only when the engine actually produces one. */
  confidence?: number;
}

export interface EngineOutput {
  engineId: string;
  engineName: string;
  direction: EngineDirection;
  /** Confluence/score the engine itself produced, when it produces one. */
  score?: number;
  zones: EngineZone[];
  /** Free-text summary from the engine. */
  summary: string;
  /** Epoch ms the engine finished. */
  completedAtMs: number;
}

export interface EngineAvailability {
  available: boolean;
  /** Why the engine is unavailable, when it is (e.g. no provider configured). */
  reason?: string;
}

/**
 * A specialized analysis engine.
 *
 * Implementations must be honest about availability and must never invent an
 * output. `checkAvailability` is consulted before `analyze`, and a `UNAVAILABLE`
 * engine is reported as such rather than being asked to guess.
 */
export interface AnalysisEngine {
  readonly id: string;
  readonly name: string;
  /** Short description of what the engine does, shown in the panel. */
  readonly description: string;
  checkAvailability(): EngineAvailability;
  analyze(snapshot: MarketSnapshot, signal: AbortSignal): Promise<EngineOutput>;
}
