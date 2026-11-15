import type { TimeframeKey } from './market';
import type { SupplyDemandZone } from './analysis';
import type { FairValueGap, RejectionZone, ValidStructureBreak, WickSweep } from './structure';

/**
 * Major-structure + market-intelligence types.
 *
 * These describe what the market is actually doing (major swings, major trendlines,
 * major support/resistance ZONES, liquidity) BEFORE any opportunity is searched for.
 * Every value is derived from confirmed candles; nothing is ever fabricated.
 */

/** A swing that survived significance filtering (never every local high/low). */
export interface MajorSwing {
  index: number;
  time: number;
  price: number;
  type: 'high' | 'low';
  /** Composite significance 0..1 (displacement + rejection + structural importance). */
  strength: number;
  /** Favourable displacement away from the swing, in ATR. */
  displacementAtr: number;
  /** Wick rejection quality 0..1. */
  rejectionScore: number;
  /** 0..1 — how dominant this pivot is over its surrounding window. */
  structuralImportance: number;
  tier: 'strong' | 'weak';
  label?: 'HH' | 'HL' | 'LH' | 'LL';
  reason: string;
}

/** A trendline anchored on MAJOR swings only, extended right for future reactions. */
export interface MajorTrendline {
  id: string;
  direction: 'bullish' | 'bearish';
  startTime: number;
  startPrice: number;
  endTime: number;
  endPrice: number;
  slopePerSec: number;
  /** The major swing anchors (>= 2). */
  anchors: { time: number; price: number }[];
  touches: number;
  /** A third independent reaction beyond the two anchors validates the line harder. */
  thirdTouchConfirmed: boolean;
  valid: boolean;
  broken: boolean;
  breakTime?: number;
  breakPrice?: number;
  /** Projected line value at the latest confirmed bar. */
  currentPrice: number;
  reason: string;
}

export type MajorZoneFreshness = 'FRESH' | 'TESTED' | 'WEAKENED' | 'INVALIDATED';

/** A rectangular support/resistance ZONE covering the actual reaction area. */
export interface MajorZone {
  id: string;
  /** Original formation type. */
  type: 'support' | 'resistance';
  /** Current role (differs from `type` after a role reversal). */
  role: 'support' | 'resistance';
  upperPrice: number;
  lowerPrice: number;
  originTime: number;
  originIndex: number;
  /** Meaningful reactions that held (not mere touches). */
  reactions: number;
  /** Origin displacement, in ATR. */
  displacementAtr: number;
  freshness: MajorZoneFreshness;
  strength: 'strong' | 'moderate' | 'weak';
  /** True when a broken level is now acting in the opposite role. */
  roleReversed: boolean;
  /** The retest band to watch after a role reversal (null otherwise). */
  retestZone: { upperPrice: number; lowerPrice: number } | null;
  reason: string;
  evidence: string[];
}

/** A resting liquidity pool above a major high (buy-side) or below a major low (sell-side). */
export interface LiquidityPool {
  id: string;
  side: 'above' | 'below';
  price: number;
  time: number;
  kind: 'major-high' | 'major-low';
  swept: boolean;
  distanceAtr: number;
  reason: string;
}

/** One directional scenario with the conditions that would invalidate it. */
export interface IntelligenceScenario {
  direction: 'bullish' | 'bearish';
  summary: string;
  trigger: string;
  targets: number[];
  invalidation: string;
  invalidationPrice: number | null;
}

/** Phase-2 conclusion: the internal market intelligence report. */
export interface IntelligenceReport {
  biasSummary: string;
  structuralLevels: { label: string; price: number; kind: 'support' | 'resistance' }[];
  strongestZones: MajorZone[];
  liquidityObjectives: LiquidityPool[];
  bullishScenario: IntelligenceScenario;
  bearishScenario: IntelligenceScenario;
  /** Bands where no trade should be considered (e.g. mid-range, between opposing zones). */
  noTradeAreas: { upperPrice: number; lowerPrice: number; label: string }[];
}

/** Phase-1 market intelligence: the full independent read of the current market. */
export interface MarketIntelligence {
  symbol: string;
  timeframe: TimeframeKey;
  asOfTime: number;
  price: number;
  atr: number;
  /** 1. Directional bias. */
  bias: 'bullish' | 'bearish' | 'neutral';
  /** 12. Current market condition. */
  condition: 'TRENDING' | 'RANGING' | 'TRANSITIONING';
  conditionExplanation: string;
  /** 2/3/4. Major structure + major & strong swings. */
  majorSwings: MajorSwing[];
  strongHighs: number[];
  strongLows: number[];
  /** 5. BOS / CHOCH. */
  breaks: ValidStructureBreak[];
  /** 11. Trendline validity (major lines only). */
  trendlines: MajorTrendline[];
  /** 6. Major support & resistance zones. */
  zones: MajorZone[];
  /** 7. Supply & demand zones. */
  supplyDemand: SupplyDemandZone[];
  /** 8. Fresh fair value gaps. */
  fvg: FairValueGap[];
  /** 9. Liquidity pools + sweeps. */
  liquidityPools: LiquidityPool[];
  liquiditySweeps: WickSweep[];
  /** 10. Rejection zones + displacement. */
  rejectionZones: RejectionZone[];
  displacement: { direction: 'bullish' | 'bearish'; atr: number } | null;
  /** Phase-2 conclusion. */
  report: IntelligenceReport;
  /** True when the intelligence read supports searching for an opportunity at all. */
  tradeable: boolean;
  noTradeReason: string | null;
}

/** One finding from a single analysis engine (SMC / ICT / price action / technical). */
export interface EngineFinding {
  /** Short label, e.g. "BOS above 1.2345" or "Bullish FVG unmitigated". */
  label: string;
  /** Whether the finding supports the considered direction. */
  supports: boolean | null;
  detail: string;
}

/** The four independent analysis lenses, each reporting what it currently sees. */
export interface EngineFindings {
  smc: EngineFinding[];
  ict: EngineFinding[];
  priceAction: EngineFinding[];
  technical: EngineFinding[];
}

/**
 * TARGET-FIRST reachability estimate. Derived from structural room and the
 * instrument's required room multiple — a descriptive confluence rating, never a
 * claimed win probability.
 */
export interface TargetReachability {
  direction: 'RISE' | 'FALL';
  /** Room to the first objective, in ATR. */
  roomToTp1Atr: number;
  roomToTp2Atr: number;
  /** Instrument-specific room the target must clear to count as reachable. */
  requiredRoomAtr: number;
  tp1Reachable: boolean;
  tp2Reachable: boolean;
  /** True when an opposing level sits too close for the target to be realistic. */
  blocked: boolean;
  reason: string;
}

/** ADVANCED INTELLIGENCE — false-signal / trap detection for the chosen setup. */
export interface FalseSignalReport {
  flagged: boolean;
  /** Trap categories detected (empty when clean). */
  traps: string[];
  reason: string;
}
