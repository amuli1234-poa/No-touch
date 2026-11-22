import type { ActiveSymbol, AvailableContract, MarketDataService } from '../services/marketData.js';

/**
 * Synthetic market discovery for the Bots module.
 *
 * This is deliberately NOT WickSentinel's market filter. `src/utils/eligibleMarkets.ts`
 * exists to decide which markets the *scanner* may analyse, and it excludes Boom,
 * Crash, Range Break and others by design. A customer's imported bot is a
 * different product with different needs, so it gets its own catalogue here.
 *
 * The only restriction applied is the one the brief asks for: Synthetic indices
 * only. Everything Deriv returns within that market is listed, including
 * families WickSentinel refuses, so a Boom/Crash or Range Break bot can be
 * matched and run if its blocks are supported.
 *
 * No symbol list is hardcoded. Deriv's `active_symbols` is the source of truth,
 * so a newly listed index appears here without a code change.
 */

/** Deriv's market code for synthetic indices in `active_symbols`. */
const SYNTHETIC_MARKET = 'synthetic_index';

/**
 * How long a discovery call may wait before the caller is told the catalogue is
 * unavailable.
 *
 * `MarketDataService.getActiveSymbols()` resolves only when Deriv's catalogue
 * frame arrives, and on a dead connection that frame never comes. A route must
 * not hang on it, so every Bots discovery call is bounded.
 */
const DISCOVERY_TIMEOUT_MS = 8_000;

function withTimeout<T>(work: Promise<T>, message: string, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BotMarketError('market_data_unavailable', message));
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Human-facing categories, keyed by the tokens Deriv puts in `submarket` and
 * the display name. Ordered: the UI renders them in this order.
 *
 * A symbol that matches no rule lands in `other` rather than being dropped —
 * an unknown new family must stay visible and selectable, because silently
 * hiding it would look like the bot is incompatible when it is not.
 */
const CATEGORY_RULES: ReadonlyArray<{ key: string; label: string; match: RegExp }> = [
  { key: 'volatility_1s', label: 'Volatility 1s Indices', match: /\b1s\b|1-second|1 second/i },
  { key: 'crash_boom', label: 'Crash/Boom Indices', match: /\bboom\b|\bcrash\b/i },
  { key: 'jump', label: 'Jump Indices', match: /\bjump\b/i },
  { key: 'range_break', label: 'Range Break Indices', match: /range\s*break/i },
  { key: 'step', label: 'Step Indices', match: /\bstep\b/i },
  { key: 'volatility', label: 'Volatility Indices', match: /volatility/i },
  { key: 'drift', label: 'Drift/DEX/Trek/Skew Indices', match: /drift|dex|trek|skew/i },
  { key: 'basket', label: 'Baskets', match: /basket/i },
  { key: 'daily_reset', label: 'Daily Reset Indices', match: /daily\s*reset/i }
];

const OTHER_CATEGORY = { key: 'other', label: 'Other Synthetic Indices' };

export interface BotMarketCategory {
  key: string;
  label: string;
}

export interface BotMarketSymbol {
  symbol: string;
  displayName: string;
  category: string;
  categoryLabel: string;
  submarket: string;
  pipSize: number;
  /** Deriv reports the exchange as open and trading not suspended. */
  available: boolean;
  /** Why the symbol is not selectable, when it is not. */
  unavailableReason: string | null;
}

export interface BotMarketCatalog {
  categories: BotMarketCategory[];
  symbols: BotMarketSymbol[];
  /** When this catalogue was assembled from the live connection. */
  fetchedAt: number;
}

export class BotMarketError extends Error {
  readonly code: 'market_data_unavailable' | 'unknown_symbol';
  readonly status: number;
  constructor(code: 'market_data_unavailable' | 'unknown_symbol', message: string, status = 503) {
    super(message);
    this.name = 'BotMarketError';
    this.code = code;
    this.status = status;
  }
}

function categoryFor(symbol: ActiveSymbol): { key: string; label: string } {
  // Match against both fields: Deriv's submarket strings vary between families,
  // while the display name is consistently human-readable.
  const haystack = `${symbol.submarket} ${symbol.displayName}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(haystack)) return { key: rule.key, label: rule.label };
  }
  return OTHER_CATEGORY;
}

/** True when Deriv reports the symbol as open and not suspended. */
function isAvailable(symbol: ActiveSymbol): boolean {
  return symbol.exchangeOpen && !symbol.tradingSuspended;
}

function unavailableReason(symbol: ActiveSymbol): string | null {
  if (symbol.tradingSuspended) return 'Deriv has suspended trading on this market.';
  if (!symbol.exchangeOpen) return 'Deriv reports this market as closed.';
  return null;
}

/**
 * Loads every Synthetic symbol Deriv currently publishes.
 *
 * Throws `market_data_unavailable` rather than returning an empty list, so the
 * UI can distinguish "Deriv has nothing right now" from "the connection is
 * down" — an empty catalogue must never be presented as authoritative.
 */
export async function loadBotMarkets(
  market: MarketDataService,
  options: { timeoutMs?: number } = {}
): Promise<BotMarketCatalog> {
  let symbols: ActiveSymbol[];
  try {
    symbols = await withTimeout(
      market.getActiveSymbols(),
      'Deriv did not return its market catalogue in time. Retry shortly.',
      options.timeoutMs
    );
  } catch {
    throw new BotMarketError(
      'market_data_unavailable',
      'Could not load the Deriv market catalogue. Check the market data connection and retry.'
    );
  }

  const synthetic = symbols.filter((s) => s.market === SYNTHETIC_MARKET);
  if (synthetic.length === 0) {
    throw new BotMarketError(
      'market_data_unavailable',
      'Deriv returned no Synthetic markets. The catalogue may still be loading; retry shortly.'
    );
  }

  const rows: BotMarketSymbol[] = synthetic
    .map((s) => {
      const category = categoryFor(s);
      return {
        symbol: s.symbol,
        displayName: s.displayName,
        category: category.key,
        categoryLabel: category.label,
        submarket: s.submarket,
        pipSize: s.pipSize,
        available: isAvailable(s),
        unavailableReason: unavailableReason(s)
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Only advertise categories that actually contain a symbol, so the selector
  // never shows an empty tab.
  const present = new Set(rows.map((r) => r.category));
  const categories: BotMarketCategory[] = CATEGORY_RULES.filter((r) => present.has(r.key)).map(
    (r) => ({ key: r.key, label: r.label })
  );
  if (present.has(OTHER_CATEGORY.key)) categories.push({ ...OTHER_CATEGORY });

  return { categories, symbols: rows, fetchedAt: Date.now() };
}

/**
 * The contract types Deriv offers for one symbol.
 *
 * Symbol-scoped by construction: the caller cannot ask "all contracts", only
 * "what may this symbol trade", which is the question the compatibility engine
 * and the selector actually need.
 */
export async function loadSymbolContracts(
  market: MarketDataService,
  symbol: string
): Promise<{ symbol: string; contracts: AvailableContract[] }> {
  if (!symbol) {
    throw new BotMarketError('unknown_symbol', 'A symbol is required.', 400);
  }
  if (!market.isKnownSymbol(symbol)) {
    throw new BotMarketError('unknown_symbol', `Deriv does not list ${symbol}.`, 404);
  }
  try {
    const contracts = await withTimeout(
      market.contractsFor(symbol),
      `Deriv did not return contract availability for ${symbol} in time. Retry shortly.`
    );
    return { symbol, contracts };
  } catch (e) {
    if (e instanceof BotMarketError) throw e;
    throw new BotMarketError(
      'market_data_unavailable',
      `Could not load contract availability for ${symbol}. Retry shortly.`
    );
  }
}

/** Contract types present in a catalogue, for quick membership tests. */
export function contractTypesOf(contracts: readonly AvailableContract[]): Set<string> {
  return new Set(contracts.map((c) => c.contractType));
}
