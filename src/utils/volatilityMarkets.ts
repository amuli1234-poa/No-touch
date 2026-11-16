import type { MarketFamily, SyntheticMarket } from '../types/market';
import {
  eligibleMarkets,
  isEligibleMarket,
  isJumpMarket,
  isOneSecondMarket,
  isStepMarket,
} from './eligibleMarkets';

export interface VolatilityGroup {
  id: string;
  label: string;
  subtitle: string;
  markets: SyntheticMarket[];
}

/** 1-second Volatility Index (1HZ*). Delegates to the canonical eligibility module. */
export function isOneSecondVolatility(market: SyntheticMarket): boolean {
  return isOneSecondMarket(market);
}

/**
 * True for a genuine analysable index — a standard or 1-second Volatility Index, a Jump
 * Index, or the Step Index. Delegates to the canonical eligibility rule so every caller
 * shares one definition: Boom, Crash, Range Break and every other synthetic family are
 * rejected. (The name is kept for backwards compatibility; the definition is the canonical
 * eligibility rule.)
 */
export function isVolatilityIndex(market: SyntheticMarket): boolean {
  return isEligibleMarket(market);
}

export { isJumpMarket, isStepMarket };

/** Every eligible index (Volatility standard + 1-second, Jump, Step), ordered for display. */
export function selectVolatilityMarkets(
  markets: readonly SyntheticMarket[]
): SyntheticMarket[] {
  return eligibleMarkets(markets, { requireOpen: false });
}

/** Human label for a market family, used by list rows and badges. */
export function marketFamilyLabel(market: SyntheticMarket): string {
  if (market.family === 'JUMP') return 'Jump';
  if (market.family === 'STEP') return 'Step';
  return isOneSecondVolatility(market) ? 'Volatility · 1s' : 'Volatility';
}

/** Family-only label (no symbol available), e.g. for ranked setups. */
export function familyLabel(family: MarketFamily): string {
  if (family === 'JUMP') return 'Jump';
  if (family === 'STEP') return 'Step';
  if (family === 'RANGE_BREAK') return 'Range Break';
  return 'Volatility';
}

export function groupVolatilityMarkets(
  markets: readonly SyntheticMarket[]
): VolatilityGroup[] {
  const standard: SyntheticMarket[] = [];
  const oneSecond: SyntheticMarket[] = [];
  const jump: SyntheticMarket[] = [];
  const step: SyntheticMarket[] = [];
  for (const market of selectVolatilityMarkets(markets)) {
    if (market.family === 'JUMP') jump.push(market);
    else if (market.family === 'STEP') step.push(market);
    else if (isOneSecondVolatility(market)) oneSecond.push(market);
    else standard.push(market);
  }
  const groups: VolatilityGroup[] = [];
  if (standard.length > 0) {
    groups.push({
      id: 'standard',
      label: 'Volatility Indices',
      subtitle: 'Standard tick-based volatility instruments',
      markets: standard,
    });
  }
  if (oneSecond.length > 0) {
    groups.push({
      id: 'one-second',
      label: '1-Second Volatility',
      subtitle: 'High-frequency 1-second tick instruments',
      markets: oneSecond,
    });
  }
  if (jump.length > 0) {
    groups.push({
      id: 'jump',
      label: 'Jump Indices',
      subtitle: 'Periodic jump instruments — stabilise after spikes',
      markets: jump,
    });
  }
  if (step.length > 0) {
    groups.push({
      id: 'step',
      label: 'Step Index',
      subtitle: 'Fixed-increment trending instrument',
      markets: step,
    });
  }
  return groups;
}
