import type { MarketFamily } from './market';
import type { EntryModelId } from './engine';

/**
 * Per-instrument intelligence. Each Deriv index has its own volatility, structure,
 * trend, range and breakout behaviour, so the engine never assumes one strategy works
 * on every index. This describes WHAT an instrument is and HOW it behaves, so the
 * analysis and entry selection can adapt to it.
 *
 * Boom and Crash indices are intentionally excluded from this system.
 */

export type InstrumentKind =
  | 'STANDARD_VOLATILITY'
  | 'VOLATILITY_1S'
  | 'STEP'
  | 'JUMP'
  | 'RANGE_BREAK'
  | 'DRIFT_SWITCHING'
  | 'DEX'
  | 'TREK'
  | 'SKEW_STEP'
  | 'MULTI_STEP'
  | 'DAILY_RESET'
  | 'OTHER';

/** How the instrument's price actually behaves. */
export interface InstrumentBehaviour {
  /** Relative volatility band (1 = calmest, 5 = wildest) for position/space sizing. */
  volatilityTier: 1 | 2 | 3 | 4 | 5;
  /** Tendency to trend cleanly vs. chop (0 = pure chop, 1 = clean trend). */
  trendTendency: number;
  /** Tendency to respect range boundaries (0 = ignores them, 1 = respects them). */
  rangeTendency: number;
  /** Tendency to produce sharp displacement / abnormal spikes (0..1). */
  spikeRisk: number;
  /** Tendency to break structure decisively rather than wick-fake (0..1). */
  breakoutQuality: number;
  /** True when the instrument can produce abnormal, non-stationary movement. */
  abnormalVolatilityCapable: boolean;
}

/** The full profile that drives adaptive analysis and entry selection. */
export interface InstrumentProfile {
  kind: InstrumentKind;
  label: string;
  family: MarketFamily;
  behaviour: InstrumentBehaviour;
  /**
   * Preferred entry models for this instrument, best first. The engine still validates
   * every model, but the preference orders and weights them.
   */
  preferredModels: EntryModelId[];
  /** Models this instrument must NOT trade (e.g. breakout traps on spiky indices). */
  discouragedModels: EntryModelId[];
  /** Extra ATR multiple of room required before a target counts as reachable. */
  targetRoomAtr: number;
  /** When true, wait for abnormal movement to settle before accepting a setup. */
  requiresStabilisation: boolean;
  notes: string;
}
