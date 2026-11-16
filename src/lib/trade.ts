import { expireAuth } from './auth';

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
    if (res.status === 401) expireAuth();
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

/**
 * Copy for a save rejection that arrived without a `message`. The server always
 * sends a code, so map the ones a save can actually hit rather than showing a
 * bare "could not save".
 */
const SAVE_ERROR_COPY: Record<string, string> = {
  unauthorized: 'Your session has expired. Please sign in again.',
  account_suspended: 'Your account is suspended. Contact support.',
  account_not_authorized: 'That account is not linked to your session.',
  invalid_mode: 'That mode is not valid.',
  invalid_contract_family: 'That contract type is not valid.',
  invalid_stake: 'Enter a stake greater than zero.',
  invalid_stake_basis: 'That stake basis is not valid.',
  invalid_currency: 'That currency is not valid.',
  invalid_parameters: 'Those trade parameters are not valid.',
  invalid_duration: 'That duration is not valid.',
  invalid_duration_unit: 'That duration unit is not valid.',
  duration_out_of_range: 'That duration is outside the allowed range.',
  invalid_multiplier: 'Enter a multiplier greater than zero.',
  invalid_preferences: 'Those settings could not be read.',
  rate_limited: 'Too many requests — slow down for a moment.'
};

export function saveErrorMessage(code: string): string {
  return SAVE_ERROR_COPY[code] ?? 'Could not save your trade settings.';
}

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
    if (res.status === 401) expireAuth();
    if (!res.ok) {
      const error = typeof data?.error === 'string' ? data.error : 'save_failed';
      return {
        ok: false,
        error,
        message: typeof data?.message === 'string' ? data.message : saveErrorMessage(error)
      };
    }
    return { ok: true, preferences: data.preferences as ExecutionPreferences };
  } catch {
    return { ok: false, error: 'network', message: 'The server could not be reached.' };
  }
}

export type RiskSessionResetResult =
  | { ok: true; preferences: ExecutionPreferences }
  | { ok: false; error: string; message: string };

export async function resetDemoRiskSession(accountId: string): Promise<RiskSessionResetResult> {
  try {
    const res = await fetch('/api/execution/risk-session/reset', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) expireAuth();
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data?.error === 'string' ? data.error : 'risk_session_reset_failed',
        message:
          (typeof data?.message === 'string' && data.message) ||
          'Could not start a new risk session.'
      };
    }
    if (!data?.preferences || typeof data.preferences !== 'object') {
      return { ok: false, error: 'invalid_response', message: 'The reset response was invalid.' };
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

export interface ExecutionContract {
  id: string;
  accountId: string;
  accountMode: AccountMode;
  contractType: 'CALL' | 'PUT' | 'MULTUP' | 'MULTDOWN';
  symbol: string;
  stake: number;
  currency: string;
  purchaseTime: number;
  startTime: number;
  expiryTime: number | null;
  settlementTime: number | null;
  status: 'open' | 'sold' | 'won' | 'lost' | 'cancelled' | 'unknown';
  profit: number | null;
  closePending: boolean;
}

export type ExecutionContractsResult =
  | { ok: true; contracts: ExecutionContract[] }
  | { ok: false; error: string; message: string };

function isExecutionContract(value: unknown): value is ExecutionContract {
  if (!value || typeof value !== 'object') return false;
  const contract = value as Record<string, unknown>;
  const finiteNumber = (field: unknown) => typeof field === 'number' && Number.isFinite(field);
  const nullableNumber = (field: unknown) => field === null || finiteNumber(field);
  return (
    typeof contract.id === 'string' &&
    typeof contract.accountId === 'string' &&
    (contract.accountMode === 'demo' || contract.accountMode === 'real') &&
    (contract.contractType === 'CALL' ||
      contract.contractType === 'PUT' ||
      contract.contractType === 'MULTUP' ||
      contract.contractType === 'MULTDOWN') &&
    typeof contract.symbol === 'string' &&
    finiteNumber(contract.stake) &&
    typeof contract.currency === 'string' &&
    finiteNumber(contract.purchaseTime) &&
    finiteNumber(contract.startTime) &&
    nullableNumber(contract.expiryTime) &&
    nullableNumber(contract.settlementTime) &&
    (contract.status === 'open' ||
      contract.status === 'sold' ||
      contract.status === 'won' ||
      contract.status === 'lost' ||
      contract.status === 'cancelled' ||
      contract.status === 'unknown') &&
    nullableNumber(contract.profit) &&
    typeof contract.closePending === 'boolean'
  );
}

const CONTRACTS_ERROR_COPY: Record<string, string> = {
  unauthorized: 'Sign in again to view your account positions.',
  network: 'The server could not be reached. Your positions were not refreshed.',
  invalid_contracts: 'The server returned invalid position data.'
};

/** Loads this signed-in user's persisted Deriv contracts, without a token in the browser. */
export async function fetchExecutionContracts(): Promise<ExecutionContractsResult> {
  try {
    const res = await fetch('/api/execution/contracts', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) expireAuth();
    if (!res.ok) {
      const error = typeof data?.error === 'string' ? data.error : 'contracts_failed';
      return {
        ok: false,
        error,
        message:
          (typeof data?.message === 'string' && data.message) ||
          CONTRACTS_ERROR_COPY[error] ||
          'Could not load your account positions.'
      };
    }
    if (!Array.isArray(data?.contracts) || !data.contracts.every(isExecutionContract)) {
      return {
        ok: false,
        error: 'invalid_contracts',
        message: CONTRACTS_ERROR_COPY.invalid_contracts
      };
    }
    return { ok: true, contracts: data.contracts };
  } catch {
    return {
      ok: false,
      error: 'network',
      message: CONTRACTS_ERROR_COPY.network
    };
  }
}

export type CloseContractResult =
  | { ok: true }
  | { ok: false; error: string; message: string; pending: boolean };

const CLOSE_ERROR_COPY: Record<string, string> = {
  unauthorized: 'Your session has expired. Sign in again before closing a position.',
  token_expired: 'Your Deriv session has expired. Sign in again before closing a position.',
  contract_not_open: 'This position is no longer open. Refresh your positions.',
  close_pending: 'Deriv has not confirmed the close yet. Wait for the position status to update before trying again.',
  close_rejected: 'Deriv rejected the close request. This position may not be sellable right now.',
  close_unavailable: 'Position closing is not available on this server.',
  lock_timeout: 'Another action is running for this account. Try closing the position again shortly.',
  rate_limited: 'Too many requests — wait a moment before closing another position.',
  network: 'The server could not be reached. Refresh your positions before trying again.'
};

/** Requests an explicit server-side sell at market for one owned position. */
export async function closeExecutionContract(contractId: string): Promise<CloseContractResult> {
  try {
    const res = await fetch(`/api/execution/contracts/${encodeURIComponent(contractId)}/close`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) expireAuth();
    if (!res.ok) {
      const error = typeof data?.error === 'string' ? data.error : 'close_failed';
      return {
        ok: false,
        error,
        message:
          (typeof data?.message === 'string' && data.message) ||
          CLOSE_ERROR_COPY[error] ||
          'The position could not be closed.',
        pending: error === 'close_pending'
      };
    }
    const status = data?.contract?.status;
    if (
      data?.contract?.id !== contractId ||
      !['sold', 'won', 'lost', 'cancelled'].includes(status)
    ) {
      return {
        ok: false,
        error: 'close_pending',
        message: 'Deriv has not confirmed the final position status yet. Refresh before trying again.',
        pending: true
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'network',
      message: CLOSE_ERROR_COPY.network,
      pending: false
    };
  }
}

/** Human-readable copy for a server rejection code. */
const REJECTION_COPY: Record<string, string> = {
  unauthorized: 'Your session has expired. Sign in again before trading.',
  execution_disabled: 'Trading is switched off on the server right now.',
  automatic_disabled: 'Automatic trading is switched off. Place this trade manually.',
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
  no_valid_signal: 'The scanner has no valid setup for this market right now. Wait for a signal.',
  invalid_preview: 'Those trade parameters are not valid.',
  preview_failed: 'Could not get a price from Deriv. Try again.',
  rate_limited: 'Too many requests — slow down for a moment.',
  not_found: 'That trade could not be found.'
};

export function rejectionMessage(code: string, reasons: string[] = []): string {
  if (code === 'risk_rejected' && reasons.includes('max_open_contracts')) {
    const otherReasons = reasons.filter((reason) => reason !== 'max_open_contracts');
    const message = 'Maximum open trades reached. Wait for an open position to settle before placing another.';
    return otherReasons.length > 0
      ? `${message} Other risk checks also failed: ${otherReasons.join(', ')}.`
      : message;
  }
  const base = REJECTION_COPY[code] ?? 'The trade could not be placed.';
  return reasons.length > 0 ? `${base} (${reasons.join(', ')})` : base;
}

function responseRejectionMessage(
  data: { error?: unknown; message?: unknown; reasons?: unknown },
  fallbackCode: string
): string {
  if (typeof data.message === 'string') return data.message;
  const code = typeof data.error === 'string' ? data.error : fallbackCode;
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  return rejectionMessage(code, reasons);
}

/* ------------------------------- scanner -------------------------------- */

export interface ScannerStatus {
  running: boolean;
  /** Whether the master kill switch allows execution. */
  executionEnabled: boolean;
  /** Whether the DEMO kill switch allows execution. */
  demoEnabled: boolean;
  /** Whether the server permits automatic (scanner-driven) trading at all. */
  automaticEnabled: boolean;
  /** Why the scanner is off: 'execution_disabled' | 'demo_execution_disabled' | 'automatic_disabled' | null. */
  reason: 'execution_disabled' | 'demo_execution_disabled' | 'automatic_disabled' | null;
  lastPassAt: number | null;
  watchedMarkets: Array<{ symbol: string; displayName: string }>;
  recent: Array<{
    symbol: string;
    outcome: 'proposed' | 'skipped_cooldown' | 'no_signal' | 'skipped_manual_mode';
    direction: SignalDirection | null;
    confidence: number | null;
    executed: boolean;
  }>;
  /** The live directional setups the scanner will trade right now. */
  setups: Array<{
    symbol: string;
    displayName: string;
    direction: SignalDirection;
    confidence: number;
    reason: string;
  }>;
}

/** The automatic scanner's status for the signed-in user. */
export async function fetchScannerStatus(): Promise<ScannerStatus | null> {
  try {
    const res = await fetch('/api/execution/scanner', { credentials: 'same-origin' });
    if (res.status === 401) expireAuth();
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    return {
      running: Boolean(data.running),
      executionEnabled: data.executionEnabled !== false,
      demoEnabled: data.demoEnabled !== false,
      automaticEnabled: data.automaticEnabled !== false,
      reason:
        data.reason === 'execution_disabled' ||
        data.reason === 'demo_execution_disabled' ||
        data.reason === 'automatic_disabled'
          ? data.reason
          : null,
      lastPassAt: typeof data.lastPassAt === 'number' ? data.lastPassAt : null,
      watchedMarkets: Array.isArray(data.watchedMarkets)
        ? data.watchedMarkets.filter(
            (market: any) =>
              market &&
              typeof market.symbol === 'string' &&
              typeof market.displayName === 'string'
          )
        : [],
      recent: Array.isArray(data.recent) ? data.recent : [],
      setups: Array.isArray(data.setups)
        ? data.setups.filter(
            (s: any) =>
              s &&
              typeof s.symbol === 'string' &&
              (s.direction === 'RISE' || s.direction === 'FALL')
          )
        : []
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
    if (res.status === 401) expireAuth();
    if (!res.ok) {
      const error = typeof data?.error === 'string' ? data.error : 'preview_failed';
      return {
        ok: false,
        error,
        message: responseRejectionMessage(data, error)
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
 * Places a trade in a single request.
 *
 * The server runs the whole sequence — signal → intent → submit — behind one
 * route, so the customer pays one network round-trip instead of three. The
 * guarantees are unchanged: the signal is single-use, the manual gate and the
 * risk engine still run, and a submission whose outcome is unknown is reported
 * as such and never retried here.
 */
export async function placeTrade(ticket: TradeTicket): Promise<PlaceResult> {
  let res: Response;
  let data: any;
  try {
    res = await fetch('/api/execution/place', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: ticket.accountId,
        symbol: ticket.symbol,
        timeframe: ticket.timeframe,
        direction: ticket.direction,
        contractFamily: ticket.contractFamily,
        stake: ticket.stake,
        currency: ticket.currency,
        parameters: ticket.parameters,
        idempotencyKey: ticket.idempotencyKey,
        analysisId: ticket.analysisId ?? '',
        reason: ticket.reason ?? ''
      })
    });
    data = await res.json().catch(() => ({}));
  } catch {
    return { ok: false, error: 'network', message: 'The server could not be reached.', uncertain: false };
  }

  if (res.status === 401) expireAuth();
  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : 'submit_failed';
    return {
      ok: false,
      error: code,
      message: responseRejectionMessage(data, code),
      uncertain: code === 'broker_uncertain'
    };
  }
  return {
    ok: true,
    contractId: data?.contractId ?? null,
    payout: data?.buy?.payout ?? null,
    buyPrice: data?.buy?.buyPrice ?? null
  };
}
