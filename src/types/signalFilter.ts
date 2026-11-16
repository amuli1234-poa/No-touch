import type { RankedSignalSource, RankedSetup } from './ranking';
import type { ConnectionStatus, TimeframeKey } from './market';

/**
 * The centralized Signal Quality Filter — the single gate every AI strategy submits its
 * candidate setups to BEFORE publication. It lives between the strategies and the display
 * layer; it never generates signals of its own and never rewrites an engine's score, so
 * each AI keeps its independent strategy logic.
 */

export type SignalFilterCheckId =
  | 'DATA' // live Deriv connection + fresh prices
  | 'TREND' // directional trend alignment
  | 'STRUCTURE' // market structure / BOS confirmation
  | 'ZONE' // supply/demand rejection zone
  | 'TRIGGER' // valid entry trigger + momentum (not late)
  | 'NOVELTY' // not a duplicate / correlated repeat
  | 'ROOM'; // sufficient room for the projected move

export interface SignalFilterCheck {
  id: SignalFilterCheckId;
  label: string;
  passed: boolean;
  /** Score contribution achieved for this dimension (0…max). */
  score: number;
  /** Maximum this dimension can contribute. */
  max: number;
  detail: string;
}

export type SignalFilterVerdict = 'ACCEPTED' | 'FILTERED';

export interface FilteredSignal {
  /** Stable identity copied from the source setup (engine + symbol + direction + model). */
  key: string;
  source: RankedSignalSource;
  sourceLabel: string;
  symbol: string;
  displayName: string;
  direction: 'RISE' | 'FALL';
  modelLabel: string;
  /** The filter's 0–100 quality score (independent of the engine's own score). */
  score: number;
  /** The originating engine's own score — preserved, never overwritten. */
  engineScore: number;
  riskRewardRatio: number | null;
  verdict: SignalFilterVerdict;
  checks: SignalFilterCheck[];
  /** Short rejection reasons (empty when accepted). */
  reasons: string[];
  /** The original setup, so downstream ranking keeps every engine field. */
  setup: RankedSetup;
}

export interface SignalFilterConfig {
  /** Minimum filter quality for acceptance (default 80). */
  minQuality: number;
  requireTrendAlignment: boolean;
  requireStructure: boolean;
  requireZone: boolean;
  requireTrigger: boolean;
  rejectConflicts: boolean;
  rejectDuplicates: boolean;
  /** Minimum reward:risk for the projected move (default 0.8). */
  minRoomR: number;
}

export const DEFAULT_SIGNAL_FILTER_CONFIG: SignalFilterConfig = {
  minQuality: 80,
  requireTrendAlignment: true,
  requireStructure: true,
  requireZone: false,
  requireTrigger: true,
  rejectConflicts: true,
  rejectDuplicates: true,
  minRoomR: 0.8,
};

export interface SignalFilterContext {
  /** Current Deriv connection status — the filter withholds signals when not live. */
  connectionStatus: ConnectionStatus;
  /** Fresh candles per symbol on the setup timeframe. */
  candlesBySymbol: ReadonlyMap<string, readonly import('./market').Candle[]>;
  /**
   * The timeframe the supplied candles were fetched on (defaults to M5). The freshness
   * window scales to this — not to each setup's own timeframe — because the data is what
   * the filter actually re-reads.
   */
  dataTimeframe?: TimeframeKey;
  /** Analysis timeframe per setup key (for freshness scaling). Defaults to M5. */
  timeframeByKey?: ReadonlyMap<string, TimeframeKey>;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

export interface SignalFilterResult {
  accepted: FilteredSignal[];
  rejected: FilteredSignal[];
  acceptedCount: number;
  rejectedCount: number;
  config: SignalFilterConfig;
}
