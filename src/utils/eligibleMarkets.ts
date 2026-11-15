import type { SyntheticMarket } from '../types/market';

/**
 * GLOBAL ALL-MARKETS COVERAGE — the single source of truth for "which markets may this app
 * analyse?".
 *
 * Eligibility rule (applied everywhere):
 *  - INCLUDE every standard Volatility Index and every 1-second Volatility Index that Deriv
 *    currently publishes (discovered dynamically via `active_symbols`, so a newly listed
 *    eligible index is picked up automatically).
 *  - EXCLUDE Boom and Crash indices completely.
 *  - EXCLUDE every non-Volatility synthetic family (Jump, Step, Range Break, Daily Reset,
 *    Drift/DEX/Trek/Skew, baskets).
 *
 * The list is never hardcoded: `eligibleMarkets` filters whatever Deriv returned.
 */

const BOOM_CRASH_TOKENS = ['BOOM', 'CRASH'];
const EXCLUDED_NAME_TOKENS = ['JUMP', 'STEP', 'RANGE BREAK', 'DAILY RESET', 'DRIFT', 'TREK', 'SKEW'];

function haystack(market: SyntheticMarket): string {
  return `${market.symbol} ${market.displayName} ${market.submarket}`.toUpperCase();
}

/** True for Boom / Crash indices — excluded from every analysis path. */
export function isBoomOrCrash(market: SyntheticMarket): boolean {
  const hay = haystack(market);
  return BOOM_CRASH_TOKENS.some((t) => hay.includes(t));
}

/**
 * True for a genuine Volatility Index (standard or 1-second) that the app may analyse.
 * Family-based first, then a defensive name/symbol check so Boom/Crash and other synthetic
 * families can never slip in through a mislabelled record.
 */
export function isEligibleMarket(market: SyntheticMarket): boolean {
  if (isBoomOrCrash(market)) return false;
  if (market.family !== 'VOLATILITY') return false;
  const name = market.displayName.toUpperCase();
  if (EXCLUDED_NAME_TOKENS.some((t) => name.includes(t))) return false;
  return true;
}

/** 1-second Volatility Index (1HZ*). */
export function isOneSecondMarket(market: SyntheticMarket): boolean {
  return isOneSecondSymbol(market.symbol, market.displayName, market.submarket);
}

/**
 * Symbol-level 1-second test. Accepts a bare symbol so list rows and engine readings can be
 * classified without materialising a full `SyntheticMarket`.
 */
export function isOneSecondSymbol(
  symbol: string,
  displayName = '',
  submarket = ''
): boolean {
  const sym = symbol.toUpperCase();
  const name = displayName.toUpperCase();
  const sub = (submarket ?? '').toLowerCase();
  return sym.startsWith('1HZ') || sym.startsWith('1S') || sub.includes('1s') || name.includes('(1S)');
}

function volatilityRank(market: SyntheticMarket): number {
  const match = market.displayName.match(/VOLATILITY\s+(\d+)/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Every eligible market, open first, standard indices before 1-second, then ascending
 * volatility. Pure and deterministic — used by every AI module, the scanner and the analyser.
 */
export function eligibleMarkets(
  markets: readonly SyntheticMarket[],
  options: { include1Sec?: boolean; requireOpen?: boolean } = {}
): SyntheticMarket[] {
  const { include1Sec = true, requireOpen = true } = options;
  return markets
    .filter((m) => isEligibleMarket(m))
    .filter((m) => (requireOpen ? m.isOpen : true))
    .filter((m) => (include1Sec ? true : !isOneSecondMarket(m)))
    .sort((a, b) => {
      const aOne = isOneSecondMarket(a);
      const bOne = isOneSecondMarket(b);
      if (aOne !== bOne) return aOne ? 1 : -1;
      const diff = volatilityRank(a) - volatilityRank(b);
      if (diff !== 0) return diff;
      return a.displayName.localeCompare(b.displayName);
    });
}

/** Eligible markets keyed by symbol, for O(1) lookup when validating a selection. */
export function eligibleMarketMap(
  markets: readonly SyntheticMarket[]
): Map<string, SyntheticMarket> {
  return new Map(eligibleMarkets(markets, { requireOpen: false }).map((m) => [m.symbol, m]));
}
