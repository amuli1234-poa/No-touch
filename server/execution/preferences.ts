import type {
  AccountMode,
  ContractFamily,
  ExecutionMode,
  ExecutionPreferencesRecord
} from './types.js';

/**
 * Execution preference validation.
 *
 * The Trade panel lets a customer express *intent*: manual or automatic, the
 * contract family, the stake and the duration. This module turns that request
 * body into a typed `ExecutionPreferencesRecord`, or explains why it cannot.
 *
 * Two fields are deliberately not writable here:
 *  - `realExecutionAuthorised` — a one-way switch the customer sets on a real
 *    account they own; a preferences PUT must never flip it on.
 *  - `autoStopped` — the emergency stop. It is engaged by the risk engine and
 *    only ever cleared through its own explicit path, never as a side effect of
 *    saving a stake.
 *
 * A preference can never grant authority. The gateway re-derives every
 * permission from the session, the account record and the server-side flags on
 * each purchase, so nothing here is a security boundary.
 */

/** The platform trades durations between 5 and 300 minutes. */
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 300;

const DURATION_UNITS = ['s', 'm', 'h', 'd', 't'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export interface PreferenceError {
  code: string;
  message: string;
}

export type NormaliseResult =
  | { ok: true; value: ExecutionPreferencesRecord }
  | { ok: false; error: PreferenceError };

/** Duration in minutes for a convertible unit; null for ticks, which are not. */
export function durationMinutes(duration: number, unit: DurationUnit): number | null {
  switch (unit) {
    case 's':
      return duration / 60;
    case 'm':
      return duration;
    case 'h':
      return duration * 60;
    case 'd':
      return duration * 1440;
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validates a preferences body and merges it over the existing record. Absent
 * fields keep their stored value, so a partial save never silently resets a
 * field the customer did not touch. Safety fields are always carried over.
 */
export function normalisePreferences(
  raw: unknown,
  existing: ExecutionPreferencesRecord | null,
  userId: string
): NormaliseResult {
  const body = asRecord(raw);
  if (!body) return { ok: false, error: { code: 'invalid_preferences', message: 'Expected an object.' } };

  const base: ExecutionPreferencesRecord = existing ?? {
    userId,
    mode: 'manual',
    contractFamily: 'rise_fall',
    preferredAccountId: {},
    stake: { basis: 'stake', amount: 1, currency: null },
    parameters: {
      duration: 5,
      durationUnit: 'm',
      multiplier: null,
      cancellation: null,
      stopLoss: null,
      takeProfit: null
    },
    realExecutionAuthorised: false,
    autoStopped: false,
    updatedAt: 0
  };

  /* ------------------------------- mode ------------------------------- */
  let mode: ExecutionMode = base.mode;
  if (body.mode !== undefined) {
    if (body.mode !== 'manual' && body.mode !== 'automatic') {
      return { ok: false, error: { code: 'invalid_mode', message: 'mode must be manual or automatic.' } };
    }
    mode = body.mode;
  }

  /* --------------------------- contract family ------------------------ */
  let contractFamily: ContractFamily = base.contractFamily;
  if (body.contractFamily !== undefined) {
    if (body.contractFamily !== 'rise_fall' && body.contractFamily !== 'multipliers') {
      return {
        ok: false,
        error: { code: 'invalid_contract_family', message: 'Unsupported contract family.' }
      };
    }
    contractFamily = body.contractFamily;
  }

  /* ------------------------------ stake ------------------------------- */
  let stake = base.stake;
  if (body.stake !== undefined) {
    const s = asRecord(body.stake);
    if (!s) return { ok: false, error: { code: 'invalid_stake', message: 'stake must be an object.' } };
    const amount = finite(s.amount);
    if (amount === null || amount <= 0) {
      return { ok: false, error: { code: 'invalid_stake', message: 'Stake must be a positive number.' } };
    }
    if (s.basis !== undefined && s.basis !== 'stake' && s.basis !== 'payout') {
      return { ok: false, error: { code: 'invalid_stake_basis', message: 'basis must be stake or payout.' } };
    }
    if (s.currency !== undefined && s.currency !== null && typeof s.currency !== 'string') {
      return { ok: false, error: { code: 'invalid_currency', message: 'currency must be a string.' } };
    }
    stake = {
      basis: (s.basis as 'stake' | 'payout' | undefined) ?? base.stake.basis,
      amount,
      currency: (s.currency as string | null | undefined) ?? base.stake.currency
    };
  }

  /* ---------------------------- parameters ---------------------------- */
  let parameters = base.parameters;
  if (body.parameters !== undefined) {
    const p = asRecord(body.parameters);
    if (!p) return { ok: false, error: { code: 'invalid_parameters', message: 'parameters must be an object.' } };

    const duration = finite(p.duration) ?? base.parameters.duration;
    const unit = (p.durationUnit as DurationUnit | undefined) ?? (base.parameters.durationUnit as DurationUnit);
    if (!(DURATION_UNITS as readonly string[]).includes(unit)) {
      return { ok: false, error: { code: 'invalid_duration_unit', message: 'Unsupported duration unit.' } };
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: { code: 'invalid_duration', message: 'Duration must be positive.' } };
    }
    const minutes = durationMinutes(duration, unit);
    if (minutes !== null && (minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES)) {
      return {
        ok: false,
        error: {
          code: 'duration_out_of_range',
          message: `Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`
        }
      };
    }
    const multiplier = finite(p.multiplier);
    if (p.multiplier !== undefined && p.multiplier !== null && (multiplier === null || multiplier <= 0)) {
      return { ok: false, error: { code: 'invalid_multiplier', message: 'Multiplier must be positive.' } };
    }
    parameters = {
      duration,
      durationUnit: unit,
      multiplier: multiplier ?? (p.multiplier === null ? null : base.parameters.multiplier),
      cancellation: typeof p.cancellation === 'string' ? p.cancellation : base.parameters.cancellation,
      stopLoss: finite(p.stopLoss) ?? base.parameters.stopLoss,
      takeProfit: finite(p.takeProfit) ?? base.parameters.takeProfit
    };
  }

  /* ------------------------- preferred accounts ----------------------- */
  let preferredAccountId = base.preferredAccountId;
  if (body.preferredAccountId !== undefined) {
    const raw = asRecord(body.preferredAccountId);
    if (!raw) {
      return { ok: false, error: { code: 'invalid_preferred_account', message: 'preferredAccountId must be an object.' } };
    }
    const next: Partial<Record<AccountMode, string>> = { ...base.preferredAccountId };
    for (const mode of ['demo', 'real'] as const) {
      const value = raw[mode];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        return { ok: false, error: { code: 'invalid_preferred_account', message: 'Account ids must be strings.' } };
      }
      next[mode] = value;
    }
    preferredAccountId = next;
  }

  return {
    ok: true,
    value: {
      userId,
      mode,
      contractFamily,
      preferredAccountId,
      stake,
      parameters,
      // Safety fields are never settable through this path.
      realExecutionAuthorised: base.realExecutionAuthorised,
      autoStopped: base.autoStopped,
      lossStreakResetAtByAccount: base.lossStreakResetAtByAccount,
      updatedAt: Date.now()
    }
  };
}
