import type { MomentumAssessment, SupportResistanceLevel, SupplyDemandZone } from '../types/analysis';
import type { EntryModelId } from '../types/engine';
import type { FalseSignalReport, MarketIntelligence, TargetReachability } from '../types/intelligence';
import type { InstrumentProfile } from '../types/instrument';
import type { StructureOverlayData } from '../types/structure';

interface ReachabilityParams {
  direction: 'RISE' | 'FALL';
  entryPrice: number;
  target1: number | null;
  target2: number | null;
  atr: number;
  instrument: InstrumentProfile;
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  intelligence: MarketIntelligence;
}

/**
 * TARGET-FIRST reachability. Measures the room between the entry and each objective,
 * compares it to the instrument's required room multiple, and flags targets that are
 * already reached or blocked by an opposing structure. This is a confluence rating —
 * it is not a claimed win probability.
 */
export function assessTargetReachability(params: ReachabilityParams): TargetReachability {
  const {
    direction,
    entryPrice,
    target1,
    target2,
    atr,
    instrument,
    supportResistance,
    supplyDemand,
    intelligence,
  } = params;
  const isRise = direction === 'RISE';
  const requiredRoomAtr = instrument.targetRoomAtr;
  const safeAtr = atr > 0 ? atr : 1e-6;

  const roomToTp1Atr =
    target1 !== null && Number.isFinite(target1)
      ? Number((Math.abs(target1 - entryPrice) / safeAtr).toFixed(2))
      : 0;
  const roomToTp2Atr =
    target2 !== null && Number.isFinite(target2)
      ? Number((Math.abs(target2 - entryPrice) / safeAtr).toFixed(2))
      : 0;

  const tp1Reachable = roomToTp1Atr >= requiredRoomAtr;
  const tp2Reachable = roomToTp2Atr >= requiredRoomAtr * 1.6;

  const barrier = nearestBarrier(direction, entryPrice, supportResistance, supplyDemand, intelligence);
  const barrierRoomAtr = barrier !== null ? Math.abs(barrier - entryPrice) / safeAtr : Infinity;
  const blocked = barrier !== null && barrierRoomAtr < requiredRoomAtr;

  const reason = blocked
    ? `Opposing structure within ${barrierRoomAtr.toFixed(1)}× ATR — less than the ${requiredRoomAtr.toFixed(1)}× ATR ${instrument.label} needs, so the target is not realistically reachable.`
    : tp1Reachable
      ? `${roomToTp1Atr.toFixed(1)}× ATR of clear room to TP1 (${instrument.label} requires ${requiredRoomAtr.toFixed(1)}×).`
      : `Only ${roomToTp1Atr.toFixed(1)}× ATR of room to TP1 — below the ${requiredRoomAtr.toFixed(1)}× ATR this instrument needs.`;

  return {
    direction,
    roomToTp1Atr,
    roomToTp2Atr,
    requiredRoomAtr,
    tp1Reachable: tp1Reachable && !blocked,
    tp2Reachable: tp2Reachable && !blocked,
    blocked,
    reason,
  };
}

function nearestBarrier(
  direction: 'RISE' | 'FALL',
  entryPrice: number,
  supportResistance: readonly SupportResistanceLevel[],
  supplyDemand: readonly SupplyDemandZone[],
  intelligence: MarketIntelligence
): number | null {
  const isRise = direction === 'RISE';
  const prices: number[] = [];

  for (const l of supportResistance) {
    if (l.status !== 'active') continue;
    if (isRise && l.type === 'resistance' && l.price > entryPrice) prices.push(l.price);
    if (!isRise && l.type === 'support' && l.price < entryPrice) prices.push(l.price);
  }
  for (const z of supplyDemand) {
    if (z.status === 'invalidated') continue;
    if (isRise && z.type === 'supply' && z.lowerPrice > entryPrice) prices.push(z.lowerPrice);
    if (!isRise && z.type === 'demand' && z.upperPrice < entryPrice) prices.push(z.upperPrice);
  }
  for (const zone of intelligence.zones) {
    if (zone.freshness === 'INVALIDATED') continue;
    const near = isRise ? zone.lowerPrice : zone.upperPrice;
    if ((isRise && near > entryPrice) || (!isRise && near < entryPrice)) prices.push(near);
  }

  if (prices.length === 0) return null;
  return isRise ? Math.min(...prices) : Math.max(...prices);
}

interface FalseSignalParams {
  direction: 'RISE' | 'FALL';
  model: EntryModelId;
  instrument: InstrumentProfile;
  momentum: MomentumAssessment;
  intelligence: MarketIntelligence;
  structure: StructureOverlayData | null;
  reachability: TargetReachability;
  condition: string;
}

const TRAP_CHOPPY = 'Choppy regime — breakouts here frequently fail';
const TRAP_OVEREXTENDED = 'Entry is chasing an overextended move';
const TRAP_WEAK_BREAK = 'Structural break lacks displacement (weak breakout)';
const TRAP_NO_ROOM = 'Insufficient room before the opposing level';
const TRAP_DISCOUNTED = 'Preferred model for this instrument was not the selected one';

/**
 * ADVANCED INTELLIGENCE — false-signal detection. Looks for the classic trap patterns
 * (failed breakouts, wick-only structure, exhausted momentum, no room) before a setup
 * is treated as trustworthy. A flagged setup is surfaced but is not published.
 */
export function detectFalseSignal(params: FalseSignalParams): FalseSignalReport {
  const { direction, model, instrument, momentum, intelligence, structure, reachability, condition } =
    params;
  const traps: string[] = [];

  if (condition === 'CHOPPY' || intelligence.condition === 'TRANSITIONING') {
    traps.push(TRAP_CHOPPY);
  }

  if (momentum.isOverextended || momentum.isExhausted) {
    traps.push(TRAP_OVEREXTENDED);
  }

  const breaks = (structure?.breaks ?? intelligence.breaks).filter((b) =>
    direction === 'RISE' ? b.direction === 'bullish' : b.direction === 'bearish'
  );
  if (breaks.length > 0 && breaks[breaks.length - 1].displacementAtr < 0.8) {
    traps.push(TRAP_WEAK_BREAK);
  }

  if (reachability.blocked || !reachability.tp1Reachable) {
    traps.push(TRAP_NO_ROOM);
  }

  if (instrument.discouragedModels.includes(model)) {
    traps.push(TRAP_DISCOUNTED);
  }

  const flagged = traps.length > 0;
  return {
    flagged,
    traps,
    reason: flagged
      ? traps.join('. ') + '.'
      : 'No trap patterns detected — breakout quality, momentum and room all support the setup.',
  };
}
