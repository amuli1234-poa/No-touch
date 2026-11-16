import type { AiDirection } from './aiModule';

/**
 * BOS RETRACEMENT & REJECTION AI — types.
 *
 * The core rule this module encodes: **a BOS is a setup detector, never an automatic entry
 * trigger.** Price must break structure with displacement, retrace into the discount /
 * premium of the locked dealing range, sweep liquidity, print a decisive rejection and
 * confirm with a lower-timeframe market-structure shift before any signal exists.
 */

/**
 * The setup's explicit lifecycle. A state is only ever shown for the CURRENT valid setup;
 * `CONFIRMED` is the only state that carries a published trade.
 */
export type BosSetupState =
  | 'BOS_DETECTED'
  | 'WAITING_FOR_PULLBACK'
  | 'IN_ZONE'
  | 'REJECTION'
  | 'CONFIRMATION'
  | 'CONFIRMED'
  | 'INVALIDATED'
  | 'EXPIRED';

export const BOS_SETUP_STATE_LABELS: Record<BosSetupState, string> = {
  BOS_DETECTED: 'BOS Detected',
  WAITING_FOR_PULLBACK: 'Waiting For Pullback',
  IN_ZONE: 'In Zone',
  REJECTION: 'Rejection',
  CONFIRMATION: 'Confirmation',
  CONFIRMED: 'Confirmed',
  INVALIDATED: 'Invalidated',
  EXPIRED: 'Expired',
};

/** Continuation BOS vs reversal CHoCH/MSS — kept distinct, never conflated. */
export type BosEventKind = 'CONTINUATION' | 'REVERSAL';

/** Where price sits inside the locked dealing range. */
export type BosRangePosition = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';

/**
 * The dealing range locked to the protected swing and impulse extreme that produced the
 * BOS. Anchors are computed once from the event and never moved while the setup is alive.
 */
export interface BosDealingRange {
  kind: BosEventKind;
  direction: AiDirection;
  /** Impulse extreme (the high that broke structure for a bullish BOS). */
  high: number;
  /** Protected swing / origin (the low the impulse launched from). */
  low: number;
  /** 50% equilibrium. */
  equilibrium: number;
  /** 62% retracement level (shallow edge of the optimal trade entry). */
  ote62: number;
  /** 79% retracement level (deep edge of the optimal trade entry). */
  ote79: number;
  /** The swing level whose break produced the BOS. */
  brokenLevel: number;
  /** Bar time of the origin swing. */
  originTime: number;
  /** Bar time of the impulse extreme. */
  extremeTime: number;
  /** Bar time of the decisive break candle. */
  breakTime: number;
  /** Range height (high − low). */
  height: number;
}

/** One pass/fail condition with its human explanation — the setup's evidence trail. */
export interface BosEvidenceItem {
  label: string;
  detail: string;
  satisfied: boolean;
}

/** The retracement entry zone (discount/premium + preferred OTE overlap). */
export interface BosEntryZone {
  low: number;
  high: number;
  /** True when the zone sits inside the preferred 62–79% OTE band. */
  inOte: boolean;
  /** True when a fresh order block or FVG overlaps the zone. */
  orderBlockOverlap: boolean;
  fvgOverlap: boolean;
}

/** A genuine liquidity sweep of the zone extreme. */
export interface BosSweep {
  time: number;
  extremePrice: number;
  level: number;
  reason: string;
}

/** A decisive rejection candle at the zone. */
export interface BosRejection {
  time: number;
  price: number;
  /** 0–1 candle close conviction in the trade direction. */
  strength: number;
  bodyAtr: number;
  reason: string;
}

/** The lower-timeframe market-structure shift that confirms the reversal. */
export interface BosLtfConfirmation {
  timeframe: string;
  level: number;
  time: number;
  displacementAtr: number;
  reason: string;
}

/** The confirmation-FVG retest the entry prefers (null when none formed). */
export interface BosEntryRetest {
  low: number;
  high: number;
  time: number;
}

/** The full readout the UI/chart renders — the current valid setup and its evidence. */
export interface BosRetracementReadout {
  state: BosSetupState;
  kind: BosEventKind;
  direction: AiDirection;
  range: BosDealingRange;
  position: BosRangePosition;
  entryZone: BosEntryZone | null;
  sweep: BosSweep | null;
  rejection: BosRejection | null;
  ltf: BosLtfConfirmation | null;
  retest: BosEntryRetest | null;
  /** Estimated reward-to-risk of the confirmed trade (null before confirmation). */
  rr: number | null;
  /** Every mandatory condition, with pass/fail and its explanation. */
  evidence: BosEvidenceItem[];
  /** Reason the setup was invalidated / expired (state-specific). */
  outcomeReason: string | null;
  /** Bars elapsed since the BOS event. */
  barsSinceBos: number;
}
