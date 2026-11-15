/**
 * Trade panel client.
 *
 * Talks to the same-origin `/api/execution/preferences` endpoints. These record
 * the customer's *intent* (manual or automatic, family, stake, duration) — they
 * never place a trade and can never grant authority. Placing a trade is a
 * separate, explicit flow. The browser holds no Deriv token; the session is an
 * HttpOnly cookie the JS cannot read.
 */

export type ExecutionMode = 'manual' | 'automatic';
export type ContractFamily = 'rise_fall' | 'multipliers';
export type AccountMode = 'demo' | 'real';

export interface ExecutionParameters {
  duration: number;
  durationUnit: 's' | 'm' | 'h' | 'd' | 't';
  multiplier: number | null;
  cancellation: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface ExecutionPreferences {
  mode: ExecutionMode;
  contractFamily: ContractFamily;
  preferredAccountId: Partial<Record<AccountMode, string>>;
  stake: { basis: 'stake' | 'payout'; amount: number; currency: string | null };
  parameters: ExecutionParameters;
  /** Set by the customer on a real account they own; never writable here. */
  realExecutionAuthorised: boolean;
  /** The emergency stop; engaged by risk controls, never cleared by a save. */
  autoStopped: boolean;
}

export interface DurationBounds {
  minMinutes: number;
  maxMinutes: number;
}

export interface PreferencesResponse {
  preferences: ExecutionPreferences;
  durationBounds: DurationBounds;
}

export const DEFAULT_DURATION_BOUNDS: DurationBounds = { minMinutes: 5, maxMinutes: 300 };

/** Converts a duration + unit to whole minutes, or null for tick durations. */
export function toMinutes(duration: number, unit: ExecutionParameters['durationUnit']): number | null {
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

export async function fetchExecutionPreferences(): Promise<PreferencesResponse | null> {
  try {
    const res = await fetch('/api/execution/preferences', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.preferences) return null;
    return {
      preferences: data.preferences as ExecutionPreferences,
      durationBounds: data.durationBounds ?? DEFAULT_DURATION_BOUNDS
    };
  } catch {
    return null;
  }
}

export type SaveResult =
  | { ok: true; preferences: ExecutionPreferences }
  | { ok: false; error: string; message: string };

export async function saveExecutionPreferences(
  body: Partial<ExecutionPreferences>
): Promise<SaveResult> {
  try {
    const res = await fetch('/api/execution/preferences', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data?.error === 'string' ? data.error : 'save_failed',
        message: typeof data?.message === 'string' ? data.message : 'Could not save your trade settings.'
      };
    }
    return { ok: true, preferences: data.preferences as ExecutionPreferences };
  } catch {
    return { ok: false, error: 'network', message: 'The server could not be reached.' };
  }
}
