import type { MarketFamily, SyntheticMarket } from '../types/market';

/**
 * GLOBAL ALL-MARKETS COVERAGE — the single source of truth for "which markets may this app
 * analyse?".
 *
 * Eligibility rule (applied everywhere):
 *  - INCLUDE every standard Volatility Index and every 1-second Volatility Index Deriv
 *    currently publishes (discovered dynamically via `active_symbols`).
 *  - INCLUDE every Jump Index (JD*) and the Step Index (stpRNG*) — they are analysed by
 *    every scanner/AI module with their own market-specific logic.
 *  - EXCLUDE Boom and Crash indices completely.
 *  - EXCLUDE every other synthetic family (Range Break, Daily Reset, Drift/DEX/Trek/Skew,
 *    baskets).
 *
 * The list is never hardcoded: `eligibleMarkets` filters whatever Deriv returned, so a
 * newly listed eligible index is picked up automatically.
 */

const BOOM_CRASH_TOKENS = ['BOOM', 'CRASH'];
/** Families that are analysed. Everything else is structurally excluded. */
const ELIGIBLE_FAMILIES: ReadonlySet<MarketFamily> = new Set<MarketFamily>([
  'VOLATILITY',
  'JUMP',
  'STEP',
]);
/**
 * Non-Volatility name tokens that must NEVER be analysed, even if a record is mislabelled
 * with an eligible family. Jump and Step are intentionally absent — they are eligible.
 */
const EXCLUDED_NAME_TOKENS = [
  'RANGE BREAK',
  'DAILY RESET',
  'DRIFT',
  'TREK',
  'SKEW',
  'MULTI STEP',
];

function haystack(market: SyntheticMarket): string {
  return `${market.symbol} ${market.displayName} ${market.submarket}`.toUpperCase();
}

/** True for Boom / Crash indices — excluded from every analysis path. */
export function isBoomOrCrash(market: SyntheticMarket): boolean {
  const hay = haystack(market);
  return BOOM_CRASH_TOKENS.some((t) => hay.includes(t));
}

/**
 * True for a genuine analysable index: a standard or 1-second Volatility Index, a Jump
 * Index, or the Step Index. Family-based first, then a defensive name/symbol check so
 * Boom/Crash and the other excluded synthetic families can never slip in through a
 * mislabelled record.
 */
export function isEligibleMarket(market: SyntheticMarket): boolean {
  if (isBoomOrCrash(market)) return false;
  if (!ELIGIBLE_FAMILIES.has(market.family)) return false;
  const name = market.displayName.toUpperCase();
  if (EXCLUDED_NAME_TOKENS.some((t) => name.includes(t))) return false;
  return true;
}

/** Jump Index (JD*) or the Step Index. */
export function isJumpMarket(market: SyntheticMarket): boolean {
  return market.family === 'JUMP';
}

export function isStepMarket(market: SyntheticMarket): boolean {
  return market.family === 'STEP';
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

/** Display ordering: standard volatility → 1-second volatility → Jump → Step. */
function familyRank(market: SyntheticMarket): number {
  if (market.family === 'JUMP') return 2;
  if (market.family === 'STEP') return 3;
  return isOneSecondMarket(market) ? 1 : 0;
}

function jumpStepRank(market: SyntheticMarket): number {
  const match = market.displayName.match(/(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Every eligible market — standard and 1-second Volatility Indices first, then Jump
 * Indices, then the Step Index. Pure and deterministic — used by every AI module, the
 * scanner and the analyser.
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
      const rankDiff = familyRank(a) - familyRank(b);
      if (rankDiff !== 0) return rankDiff;
      const diff = volatilityRank(a) - volatilityRank(b);
      if (diff !== 0) return diff;
      const jsDiff = jumpStepRank(a) - jumpStepRank(b);
      if (jsDiff !== 0) return jsDiff;
      return a.displayName.localeCompare(b.displayName, undefined, { numeric: true });
    });
}

/** Eligible markets keyed by symbol, for O(1) lookup when validating a selection. */
export function eligibleMarketMap(
  markets: readonly SyntheticMarket[]
): Map<string, SyntheticMarket> {
  return new Map(eligibleMarkets(markets, { requireOpen: false }).map((m) => [m.symbol, m]));
}
