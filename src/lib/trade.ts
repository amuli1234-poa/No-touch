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

/* ------------------------------- trading -------------------------------- */

export type SignalDirection = 'RISE' | 'FALL';

/** A priced, uncommitted trade. Nothing here is a purchase. */
export interface TradePreview {
  proposalId: string;
  askPrice: number;
  payout: number;
  spot: number;
  longform: string;
}

export interface TradeTicket {
  accountId: string;
  symbol: string;
  timeframe: string;
  direction: SignalDirection;
  contractFamily: ContractFamily;
  stake: number;
  currency: string;
  parameters: ExecutionParameters;
  /** Stable per ticket, so a double-submit is a no-op server-side. */
  idempotencyKey: string;
  analysisId?: string;
  reason?: string;
}

/** Human-readable copy for a server rejection code. */
const REJECTION_COPY: Record<string, string> = {
  execution_disabled: 'Trading is switched off on the server right now.',
  demo_execution_disabled: 'Demo trading is switched off on the server right now.',
  real_execution_disabled: 'Real-money trading is switched off on the server right now.',
  account_not_authorized: 'That account is not linked to your session.',
  account_mode_mismatch: 'The account mode does not match.',
  account_unavailable: 'That account is not available for trading.',
  token_expired: 'Your Deriv session has expired — sign in again.',
  signal_invalid: 'The setup expired before it could be placed.',
  signal_consumed: 'That setup has already been traded.',
  risk_rejected: 'The trade was rejected by risk controls.',
  duplicate: 'This trade was already submitted.',
  broker_rejected: 'Deriv rejected the trade.',
  broker_uncertain: 'The outcome is unknown and needs reconciliation.',
  approval_expired: 'The confirmation timed out — please try again.',
  no_price: 'No live price is available for this market yet.',
  invalid_preview: 'Those trade parameters are not valid.',
  preview_failed: 'Could not get a price from Deriv. Try again.',
  rate_limited: 'Too many requests — slow down for a moment.',
  not_found: 'That trade could not be found.'
};

export function rejectionMessage(code: string, reasons: string[] = []): string {
  const base = REJECTION_COPY[code] ?? 'The trade could not be placed.';
  return reasons.length > 0 ? `${base} (${reasons.join(', ')})` : base;
}

/* ------------------------------- scanner -------------------------------- */

export interface ScannerStatus {
  running: boolean;
  lastPassAt: number | null;
  recent: Array<{
    symbol: string;
    outcome: 'proposed' | 'skipped_cooldown' | 'no_signal' | 'skipped_manual_mode';
    direction: SignalDirection | null;
    confidence: number | null;
    executed: boolean;
  }>;
}

/** The automatic scanner's status for the signed-in user. */
export async function fetchScannerStatus(): Promise<ScannerStatus | null> {
  try {
    const res = await fetch('/api/execution/scanner', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    return {
      running: Boolean(data.running),
      lastPassAt: typeof data.lastPassAt === 'number' ? data.lastPassAt : null,
      recent: Array.isArray(data.recent) ? data.recent : []
    };
  } catch {
    return null;
  }
}

export type PreviewResult =
  | { ok: true; preview: TradePreview }
  | { ok: false; error: string; message: string };

/** Prices a trade. Safe to call repeatedly — it never places anything. */
export async function previewTrade(ticket: {
  accountId: string;
  symbol: string;
  direction: SignalDirection;
  contractFamily: ContractFamily;
  stake: number;
  currency: string;
  parameters: ExecutionParameters;
}): Promise<PreviewResult> {
  try {
    const res = await fetch('/api/execution/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ticket)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data?.error === 'string' ? data.error : 'preview_failed',
        message: rejectionMessage(data?.error ?? 'preview_failed', data?.reasons ?? [])
      };
    }
    return { ok: true, preview: data.preview as TradePreview };
  } catch {
    return { ok: false, error: 'network', message: 'The server could not be reached.' };
  }
}

export type PlaceResult =
  | { ok: true; contractId: number | null; payout: number | null; buyPrice: number | null }
  | { ok: false; error: string; message: string; uncertain: boolean };

/**
 * Places a trade: signal → intent → submit.
 *
 * Each step is explicit and the signal is single-use, so a retry after a partial
 * failure is refused rather than duplicating a purchase. A submission whose
 * outcome is unknown is reported as such and never retried here.
 */
export async function placeTrade(ticket: TradeTicket): Promise<PlaceResult> {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { res, data: await res.json().catch(() => ({})) };
  };

  const signal = await post('/api/execution/signals', {
    accountId: ticket.accountId,
    symbol: ticket.symbol,
    timeframe: ticket.timeframe,
    direction: ticket.direction,
    contractFamily: ticket.contractFamily,
    analysisId: ticket.analysisId ?? '',
    reason: ticket.reason ?? ''
  });
  if (!signal.res.ok || !signal.data?.signal?.id) {
    return {
      ok: false,
      error: signal.data?.error ?? 'signal_failed',
      message: rejectionMessage(signal.data?.error ?? 'signal_failed', signal.data?.reasons ?? []),
      uncertain: false
    };
  }

  const intent = await post('/api/execution/intents', {
    signalId: signal.data.signal.id,
    contractFamily: ticket.contractFamily,
    stake: ticket.stake,
    basis: 'stake',
    currency: ticket.currency,
    parameters: ticket.parameters,
    idempotencyKey: ticket.idempotencyKey
  });
  if (!intent.res.ok || !intent.data?.intent?.id) {
    return {
      ok: false,
      error: intent.data?.error ?? 'intent_failed',
      message: rejectionMessage(intent.data?.error ?? 'intent_failed', intent.data?.reasons ?? []),
      uncertain: false
    };
  }

  const submit = await post(`/api/execution/intents/${intent.data.intent.id}/submit`, {});
  if (!submit.res.ok) {
    const code = submit.data?.error ?? 'submit_failed';
    return {
      ok: false,
      error: code,
      message: rejectionMessage(code, submit.data?.reasons ?? []),
      uncertain: code === 'broker_uncertain'
    };
  }
  return {
    ok: true,
    contractId: submit.data?.contractId ?? null,
    payout: submit.data?.buy?.payout ?? null,
    buyPrice: submit.data?.buy?.buyPrice ?? null
  };
}
