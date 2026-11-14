import { randomUUID } from 'node:crypto';

import type { Store } from '../store/store.js';
import type { SignalRecord, SignalDirection, ContractFamily, AccountMode, DerivContractType } from '../execution/types.js';
import { CONTRACT_FAMILY_TYPES } from '../execution/types.js';
import type { MarketDataService } from './marketData.js';
import { isSnapshotFresh } from './marketData.js';

/**
 * Signal creation and validation.
 *
 * A *signal* is a validated directional opinion about a symbol at a point in
 * time. It is not an order. Nothing in this module submits a purchase; it only
 * decides whether a proposed signal is well-formed, fresh and usable, and
 * records it with an expiry so it cannot be replayed later.
 *
 * Two checks matter for safety and are enforced here rather than in a caller:
 *  - a signal must map to a real Deriv contract type (RISE -> CALL, FALL -> PUT
 *    for Rise/Fall; MULTUP/MULTDOWN for Multipliers);
 *  - a signal is single-use. Once an intent references it, `consumedByIntentId`
 *    is set and it can never be consumed again.
 */

export type SignalErrorCode =
  | 'invalid_symbol'
  | 'invalid_direction'
  | 'invalid_confidence'
  | 'no_price'
  | 'stale_price'
  | 'not_found'
  | 'expired'
  | 'already_consumed'
  | 'direction_mismatch';

export class SignalError extends Error {
  readonly code: SignalErrorCode;
  constructor(code: SignalErrorCode, message: string) {
    super(message);
    this.name = 'SignalError';
    this.code = code;
  }
}

/** Maps a directional opinion to a Deriv contract type within a family. */
export function contractTypeFor(direction: SignalDirection, family: ContractFamily): DerivContractType {
  if (family === 'rise_fall') {
    if (direction === 'RISE') return CONTRACT_FAMILY_TYPES.rise_fall[0];
    if (direction === 'FALL') return CONTRACT_FAMILY_TYPES.rise_fall[1];
  }
  if (family === 'multipliers') {
    if (direction === 'RISE') return CONTRACT_FAMILY_TYPES.multipliers[0];
    if (direction === 'FALL') return CONTRACT_FAMILY_TYPES.multipliers[1];
  }
  throw new SignalError('invalid_direction', `Direction ${direction} has no contract in family ${family}.`);
}

export interface SignalInput {
  userId: string;
  accountId: string;
  accountMode: AccountMode;
  symbol: string;
  timeframe: string;
  direction: SignalDirection;
  contractFamily: ContractFamily;
  /** Id of the engine analysis this derives from. */
  analysisId: string;
  zone?: { low: number; high: number } | null;
  confidence?: number | null;
  reason?: string;
}

export interface CreateSignalOptions {
  /** How long the signal stays usable. */
  ttlSeconds?: number;
  /** Minimum confidence required, when a confidence is supplied. */
  minConfidence?: number;
  /** Maximum age of the price snapshot the signal may be built on. */
  maxPriceAgeMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_MAX_PRICE_AGE_MS = 5_000;

function assertFiniteNumber(value: unknown, code: SignalErrorCode, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SignalError(code, message);
  return value;
}

/**
 * Creates a validated, expiring signal. Requires a fresh market snapshot for the
 * symbol, so a signal can never be created against a stale price.
 */
export async function createSignal(
  store: Store,
  market: MarketDataService,
  input: SignalInput,
  options: CreateSignalOptions = {}
): Promise<SignalRecord> {
  const now = options.now ?? (() => Date.now());

  if (!market.isKnownSymbol(input.symbol)) {
    throw new SignalError('invalid_symbol', `Unknown symbol ${input.symbol}.`);
  }
  if (input.direction !== 'RISE' && input.direction !== 'FALL' && input.direction !== 'NONE') {
    throw new SignalError('invalid_direction', `Unsupported direction ${String(input.direction)}.`);
  }
  if (input.direction === 'NONE') {
    throw new SignalError('invalid_direction', 'A NONE signal cannot be recorded as a tradeable signal.');
  }
  // Validate the direction maps to a contract in the family before storing.
  contractTypeFor(input.direction, input.contractFamily);

  const maxAge = options.maxPriceAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS;
  const snapshot = market.getSnapshot(input.symbol);
  if (!snapshot) {
    throw new SignalError('no_price', `No market price available for ${input.symbol}.`);
  }
  if (!isSnapshotFresh(snapshot, maxAge, now())) {
    throw new SignalError('stale_price', `The price for ${input.symbol} is older than ${maxAge}ms.`);
  }

  if (input.confidence !== undefined && input.confidence !== null) {
    const c = assertFiniteNumber(input.confidence, 'invalid_confidence', 'Confidence must be a finite number.');
    if (c < 0 || c > 1) throw new SignalError('invalid_confidence', 'Confidence must be between 0 and 1.');
    if (options.minConfidence !== undefined && c < options.minConfidence) {
      throw new SignalError('invalid_confidence', `Confidence ${c} is below the minimum ${options.minConfidence}.`);
    }
  }

  const createdAt = now();
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const signal: SignalRecord = {
    id: `sig_${randomUUID()}`,
    userId: input.userId,
    accountId: input.accountId,
    accountMode: input.accountMode,
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction: input.direction,
    contractFamily: input.contractFamily,
    analysisId: input.analysisId,
    zone: input.zone ?? null,
    entryPrice: snapshot.quote,
    confidence: input.confidence ?? null,
    reason: input.reason ?? '',
    createdAt,
    expiresAt: createdAt + ttl * 1000,
    consumedByIntentId: null
  };
  await store.putSignal(signal);
  return signal;
}

export interface ValidateSignalOptions {
  /** Freshness window applied on top of the signal's own expiry. */
  freshnessSeconds?: number;
  now?: () => number;
}

/**
 * Validates a stored signal for execution. Enforces: it exists and belongs to
 * the user, it has not expired, it has not already been consumed, and — when a
 * direction is supplied — that the direction matches. Returns the signal.
 */
export function validateSignalForExecution(
  store: Store,
  userId: string,
  signalId: string,
  options: ValidateSignalOptions = {}
): SignalRecord {
  const now = (options.now ?? (() => Date.now()))();
  const signal = store.getSignal(userId, signalId);
  if (!signal) throw new SignalError('not_found', 'Signal not found.');
  if (signal.consumedByIntentId) {
    throw new SignalError('already_consumed', 'Signal has already been used.');
  }
  if (signal.expiresAt <= now) {
    throw new SignalError('expired', 'Signal has expired.');
  }
  if (options.freshnessSeconds !== undefined) {
    const ageSeconds = (now - signal.createdAt) / 1000;
    if (ageSeconds > options.freshnessSeconds) {
      throw new SignalError('expired', `Signal is older than ${options.freshnessSeconds}s.`);
    }
  }
  return signal;
}

/**
 * Marks a signal consumed by an intent. Single-use: a second call for the same
 * signal is refused, so one signal can never drive two trades.
 */
export async function consumeSignal(
  store: Store,
  userId: string,
  signalId: string,
  intentId: string
): Promise<SignalRecord> {
  const signal = store.getSignal(userId, signalId);
  if (!signal) throw new SignalError('not_found', 'Signal not found.');
  if (signal.consumedByIntentId) throw new SignalError('already_consumed', 'Signal has already been used.');
  const updated: SignalRecord = { ...signal, consumedByIntentId: intentId };
  await store.putSignal(updated);
  return updated;
}
