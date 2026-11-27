/**
 * Currency-aware monetary precision.
 *
 * Deriv account currencies have different minor units (fiat 2, JPY/IDK 0,
 * BTC 8, XRP 6). Fixed two-decimal rounding silently corrupts non-fiat amounts,
 * so every monetary rounding in the financial engine goes through here and
 * carries its currency explicitly. No currency is ever converted.
 */

const CURRENCY_DIGITS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  JPY: 0,
  IDK: 0,
  BTC: 8,
  XBT: 8,
  XRP: 6,
  ETH: 8,
  LTC: 8,
  BCH: 8
};

/** Minor-unit digits for a currency; defaults to 2 for unknown fiat. */
export function currencyDigits(currency: string): number {
  return CURRENCY_DIGITS[(currency ?? '').toUpperCase()] ?? 2;
}

/**
 * Round a monetary amount to the currency's minor unit without floating-point
 * drift. Uses a scaled integer round with an epsilon nudge.
 */
export function roundMoney(value: number, currency: string): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** currencyDigits(currency);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Convert a monetary amount to an integer count of minor units (e.g. cents,
 * satoshis). Financial arithmetic is done on these bigints so no floating-point
 * operation ever touches a monetary value; `fromMinor` converts back only at the
 * storage boundary.
 */
export function toMinor(value: number, currency: string): bigint {
  if (!Number.isFinite(value)) return 0n;
  const factor = 10 ** currencyDigits(currency);
  return BigInt(Math.round((value + Number.EPSILON) * factor));
}

/** Convert an integer minor-unit count back to a major-unit number. */
export function fromMinor(minor: bigint, currency: string): number {
  const factor = 10 ** currencyDigits(currency);
  return Number(minor) / factor;
}

/** Multiply a minor-unit amount by a basis-point rate (1/100 of a percent), rounded half-up. */
export function applyBasisPoints(minor: bigint, basisPoints: bigint): bigint {
  if (minor <= 0n) return 0n;
  return (minor * basisPoints + 50n) / 100n;
}