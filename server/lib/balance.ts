import type { ServerConfig } from '../config.js';

/**
 * Server-side Deriv balance reader.
 *
 * Balances are only readable over an authenticated WebSocket session, not a
 * REST call. The documented flow (developers.deriv.com "Options Setup ->
 * WebSockets" and "Account Management -> Balance") is:
 *
 *   1. POST /trading/v1/options/accounts/{accountId}/otp   (OAuth2 scope: trade)
 *      -> a one-time WebSocket URL bound to that specific account
 *   2. connect and send { "balance": 1 }
 *   3. read the pushed balance message
 *
 * Scope: `trade`. WickSentinel already requests `trade` (to list the user's
 * accounts), so reading a balance needs NO additional permission and no write
 * scope. `account_manage` is deliberately not requested: Deriv documents it as
 * "Write access for account creation and management".
 *
 * The account id appears in the OTP URL, and Deriv returns the balance for that
 * account. The caller must therefore have already proven the account belongs to
 * the session user before calling in here.
 */

export interface DerivBalance {
  /**
   * Balance as reported by Deriv. Always a finite number: a payload with no
   * usable figure is rejected as `balance_failed`, never resolved as null, so a
   * parse failure can never be mistaken for a real (or zero) balance.
   */
  balance: number;
  currency: string | null;
  loginId: string | null;
}

export type DerivBalanceErrorCode = 'otp_failed' | 'ws_failed' | 'balance_failed' | 'timeout';

export class DerivBalanceError extends Error {
  readonly code: DerivBalanceErrorCode;
  readonly status: number | null;
  constructor(code: DerivBalanceErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'DerivBalanceError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Minimal structural view of the WebSocket we use. Node 24 exposes a global
 * `WebSocket`; tests inject a deterministic stand-in, so we depend on the shape
 * rather than the DOM/undici class.
 */
export interface MinimalWebSocket {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export interface FetchBalanceOptions {
  /** WebSocket constructor; defaults to the Node global. */
  wsFactory?: WebSocketFactory;
  /** Hard cap on the whole OTP + connect + read sequence. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Only ever dial Deriv's own balance socket — never an arbitrary host. */
function assertDerivSocketUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DerivBalanceError('otp_failed', 'Deriv returned an unparseable balance session URL.');
  }
  const host = url.hostname.toLowerCase();
  const schemeOk = url.protocol === 'wss:';
  const hostOk = host === 'derivws.com' || host.endsWith('.derivws.com');
  if (!schemeOk || !hostOk) {
    throw new DerivBalanceError('otp_failed', 'Deriv returned a balance session URL on an unexpected origin.');
  }
}

/** Requests the one-time, account-bound WebSocket URL. Requires scope `trade`. */
async function requestBalanceSocketUrl(
  cfg: ServerConfig,
  accessToken: string,
  accountId: string
): Promise<string> {
  const url = `${cfg.deriv.apiBaseUrl}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
  } catch {
    throw new DerivBalanceError('otp_failed', 'Could not reach Deriv to open a balance session.');
  }
  if (!res.ok) {
    throw new DerivBalanceError('otp_failed', 'Deriv refused to open a balance session.', res.status);
  }
  const json: any = await res.json().catch(() => null);
  const socketUrl = json?.data?.url;
  if (typeof socketUrl !== 'string' || socketUrl.length === 0) {
    throw new DerivBalanceError('otp_failed', 'Deriv did not return a balance session URL.');
  }
  assertDerivSocketUrl(socketUrl);
  return socketUrl;
}

/** Coerces a Deriv balance payload field to a finite number, else null. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Extracts the balance fields from a `balance` message.
 *
 * Deriv nests them under a `balance` object:
 *   { "balance": { "balance": 10092.59, "currency": "USD", "loginid": "VRTC…" },
 *     "msg_type": "balance" }
 * Older/flat payloads carry the fields at the top level, so we accept both.
 */
function readBalanceFields(msg: any): DerivBalance {
  const body = msg.balance && typeof msg.balance === 'object' ? msg.balance : msg;
  const balance = toNumber(body.balance);
  if (balance === null) {
    // Never resolve an unusable payload: it would surface as a valid-but-null
    // balance and get cached as `ok`.
    throw new DerivBalanceError('balance_failed', 'Deriv returned a balance message without a usable figure.');
  }
  return {
    balance,
    currency: typeof body.currency === 'string' ? body.currency : null,
    loginId: typeof body.loginid === 'string' ? body.loginid : null
  };
}

/**
 * Reads one account's balance. `accountId` MUST already have been validated
 * against the session user's account list by the caller.
 */
export async function fetchBalance(
  cfg: ServerConfig,
  accessToken: string,
  accountId: string,
  opts: FetchBalanceOptions = {}
): Promise<DerivBalance> {
  const socketUrl = await requestBalanceSocketUrl(cfg, accessToken, accountId);
  const factory: WebSocketFactory =
    opts.wsFactory ?? ((url: string) => new (globalThis as any).WebSocket(url) as MinimalWebSocket);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await new Promise<DerivBalance>((resolve, reject) => {
    let settled = false;
    let socket: MinimalWebSocket | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Closing an already-closed socket is not an error worth surfacing.
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new DerivBalanceError('timeout', 'Timed out reading the balance from Deriv.')));
    }, timeoutMs);

    try {
      socket = factory(socketUrl);
    } catch {
      finish(() => reject(new DerivBalanceError('ws_failed', 'Could not open the balance socket.')));
      return;
    }

    socket.addEventListener('open', () => {
      try {
        socket!.send(JSON.stringify({ balance: 1, req_id: 1 }));
      } catch {
        finish(() => reject(new DerivBalanceError('ws_failed', 'Could not request the balance.')));
      }
    });

    socket.addEventListener('message', (event: any) => {
      let msg: any;
      try {
        msg = typeof event?.data === 'string' ? JSON.parse(event.data) : null;
      } catch {
        return;
      }
      if (!msg || msg.msg_type !== 'balance') return;
      if (msg.error) {
        finish(() =>
          reject(new DerivBalanceError('balance_failed', msg.error?.message || 'Deriv rejected the balance request.'))
        );
        return;
      }
      let parsed: DerivBalance;
      try {
        parsed = readBalanceFields(msg);
      } catch (err) {
        finish(() => reject(err));
        return;
      }
      finish(() => resolve(parsed));
    });

    socket.addEventListener('error', () => {
      finish(() => reject(new DerivBalanceError('ws_failed', 'The balance socket reported an error.')));
    });

    socket.addEventListener('close', () => {
      // A close before a balance message means we never got the value.
      finish(() => reject(new DerivBalanceError('ws_failed', 'The balance socket closed before a balance arrived.')));
    });
  });
}
