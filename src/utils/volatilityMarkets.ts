import type { SyntheticMarket } from '../types/market';
import { eligibleMarkets, isEligibleMarket, isOneSecondMarket } from './eligibleMarkets';

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
 * Returns true for genuine eligible Volatility indices only (standard + 1-second).
 * Delegates to the canonical eligibility rule so every caller shares one definition:
 * Boom, Crash, Jump, Step, Range Break and every other synthetic family are rejected.
 */
export function isVolatilityIndex(market: SyntheticMarket): boolean {
  return isEligibleMarket(market);
}

/** Every eligible Volatility Index (standard + 1-second), ordered for display. */
export function selectVolatilityMarkets(
  markets: readonly SyntheticMarket[]
): SyntheticMarket[] {
  return eligibleMarkets(markets, { requireOpen: false });
}

export function groupVolatilityMarkets(
  markets: readonly SyntheticMarket[]
): VolatilityGroup[] {
  const standard: SyntheticMarket[] = [];
  const oneSecond: SyntheticMarket[] = [];
  for (const market of selectVolatilityMarkets(markets)) {
    (isOneSecondVolatility(market) ? oneSecond : standard).push(market);
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
  return groups;
}
