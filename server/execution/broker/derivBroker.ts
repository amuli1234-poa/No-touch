import type { ServerConfig } from '../../config.js';
import type { MinimalWebSocket } from '../../lib/balance.js';
import { BrokerError } from './types.js';
import type {
  BrokerAdapter,
  ProposalRequest,
  ProposalResult,
  BuyRequest,
  BuyResult,
  ContractUpdate
} from './types.js';
import type { AccountMode, ContractStatus } from '../types.js';

/**
 * Real Deriv broker adapter.
 *
 * Uses the documented authenticated Options flow, which does NOT use a
 * WS-token handshake:
 *
 *   1. POST /trading/v1/options/accounts/{accountId}/otp   (Authorization: Bearer)
 *      -> { data: { url } }, a one-time WebSocket URL bound to that account
 *   2. connect to that URL
 *   3. send { proposal: ... } then { buy: <proposalId>, price: <askPrice> }
 *
 * The OTP URL already carries the session, so no `authorize` message is sent.
 * A buy is only ever issued with the proposal's own `ask_price`, so Deriv cannot
 * fill at a worse price than was validated.
 *
 * Every socket is created per call and closed afterwards: there is no long-lived
 * authenticated socket to leak, and the account id can never be confused across
 * calls. `uncertain` is set on any failure that may have reached Deriv (a
 * timeout after sending `buy`, or a dropped socket), so the gateway never
 * blindly retries.
 *
 * This adapter performs no risk, ownership or kill-switch checks. Those live in
 * the gateway, which is the only caller.
 */

export type DerivSocketFactory = (url: string) => MinimalWebSocket;

export interface DerivBrokerOptions {
  wsFactory?: DerivSocketFactory;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Only ever dial Deriv's own socket — never an arbitrary host. */
function assertDerivSocketUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrokerError('otp_failed', 'Deriv returned an unparseable session URL.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'wss:' || !(host === 'derivws.com' || host.endsWith('.derivws.com'))) {
    throw new BrokerError('otp_failed', 'Deriv returned a session URL on an unexpected origin.');
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class DerivBroker implements BrokerAdapter {
  readonly kind = 'deriv' as const;

  private readonly cfg: ServerConfig;
  private readonly wsFactory: DerivSocketFactory;
  private readonly timeoutMs: number;
  private readonly sockets = new Set<MinimalWebSocket>();

  constructor(cfg: ServerConfig, options: DerivBrokerOptions = {}) {
    this.cfg = cfg;
    this.wsFactory =
      options.wsFactory ?? ((url: string) => new (globalThis as any).WebSocket(url) as MinimalWebSocket);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Requests the one-time, account-bound WebSocket URL. Scope: trade. */
  private async requestSocketUrl(accessToken: string, accountId: string): Promise<string> {
    const url = `${this.cfg.deriv.apiBaseUrl}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
      });
    } catch {
      throw new BrokerError('otp_failed', 'Could not reach Deriv to open a trading session.');
    }
    if (!res.ok) {
      // 401/403 here means the token is bad or lacks `trade`: a definite failure.
      throw new BrokerError('otp_failed', 'Deriv refused to open a trading session.', false, String(res.status));
    }
    const json: any = await res.json().catch(() => null);
    const socketUrl = json?.data?.url;
    if (typeof socketUrl !== 'string' || socketUrl.length === 0) {
      throw new BrokerError('otp_failed', 'Deriv did not return a trading session URL.');
    }
    assertDerivSocketUrl(socketUrl);
    return socketUrl;
  }

  /**
   * Opens a session, sends one request, resolves with the first matching
   * response, then closes. `uncertainOnTimeout` decides whether a timeout means
   * the outcome is unknown (a buy) or a clean failure (a proposal).
   */
  private async request<T = any>(
    accessToken: string,
    accountId: string,
    message: Record<string, unknown>,
    opts: { uncertainOnTimeout: boolean; expect: string }
  ): Promise<T> {
    const socketUrl = await this.requestSocketUrl(accessToken, accountId);
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let socket: MinimalWebSocket | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          /* closing an already-closed socket is not an error */
        }
        if (socket) this.sockets.delete(socket);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new BrokerError(
              'timeout',
              `Timed out waiting for Deriv to answer ${opts.expect}.`,
              opts.uncertainOnTimeout
            )
          )
        );
      }, this.timeoutMs);

      try {
        socket = this.wsFactory(socketUrl);
        this.sockets.add(socket);
      } catch {
        finish(() => reject(new BrokerError('socket_failed', 'Could not open the trading socket.')));
        return;
      }

      socket.addEventListener('open', () => {
        try {
          socket!.send(JSON.stringify(message));
        } catch {
          finish(() => reject(new BrokerError('socket_failed', 'Could not send the trading request.')));
        }
      });

      socket.addEventListener('message', (event: any) => {
        let msg: any;
        try {
          msg = typeof event?.data === 'string' ? JSON.parse(event.data) : null;
        } catch {
          return;
        }
        if (!msg) return;
        if (msg.error) {
          // Deriv answered with a rejection: a definite outcome, not uncertain.
          finish(() =>
            reject(
              new BrokerError('rejected', msg.error.message || 'Deriv rejected the request.', false, msg.error.code || null)
            )
          );
          return;
        }
        if (msg.msg_type === opts.expect) {
          finish(() => resolve(msg as T));
        }
      });

      socket.addEventListener('error', () => {
        // A socket error after we have sent a buy may have reached Deriv.
        finish(() =>
          reject(
            new BrokerError('socket_failed', 'The trading socket failed.', opts.uncertainOnTimeout)
          )
        );
      });

      socket.addEventListener('close', () => {
        // A close without a response, after sending, is an unknown outcome.
        finish(() =>
          reject(
            new BrokerError('socket_failed', 'The trading socket closed before a response.', opts.uncertainOnTimeout)
          )
        );
      });
    });
  }

  async requestProposal(req: ProposalRequest): Promise<ProposalResult> {
    const msg = await this.request<any>(req.accessToken, req.accountId, { proposal: 1, ...req.payload, req_id: req.reqId }, {
      // A proposal never moves money, so a timeout is a clean failure.
      uncertainOnTimeout: false,
      expect: 'proposal'
    });
    const p = msg.proposal ?? {};
    const askPrice = toNumber(p.ask_price);
    if (askPrice === null || askPrice <= 0) {
      throw new BrokerError('rejected', 'Deriv returned a proposal without a usable price.');
    }
    return {
      proposalId: String(p.id ?? ''),
      askPrice,
      payout: toNumber(p.payout) ?? 0,
      spot: toNumber(p.spot) ?? 0,
      dateStart: toNumber(p.date_start) ?? 0,
      longcode: String(p.longcode ?? '')
    };
  }

  async buy(req: BuyRequest): Promise<BuyResult> {
    const msg = await this.request<any>(
      req.accessToken,
      req.accountId,
      { buy: req.proposalId, price: req.price, req_id: req.reqId },
      // The buy may have reached Deriv: a timeout here is an UNKNOWN outcome.
      { uncertainOnTimeout: true, expect: 'buy' }
    );
    const b = msg.buy ?? {};
    const contractId = toNumber(b.contract_id);
    if (contractId === null) {
      throw new BrokerError('rejected', 'Deriv confirmed a purchase without a contract id.');
    }
    return {
      contractId,
      buyPrice: toNumber(b.buy_price) ?? req.price,
      balanceAfter: toNumber(b.balance_after) ?? 0,
      payout: toNumber(b.payout) ?? 0,
      purchaseTime: toNumber(b.purchase_time) ?? 0,
      startTime: toNumber(b.start_time) ?? 0,
      transactionId: toNumber(b.transaction_id) ?? 0,
      longcode: String(b.longcode ?? ''),
      shortcode: String(b.shortcode ?? '')
    };
  }

  /**
   * Subscribes to a contract's lifecycle. Opens a dedicated authenticated
   * socket that stays open for the life of the subscription; the returned
   * function closes it.
   */
  subscribeContract(
    accountId: string,
    _accountMode: AccountMode,
    accessToken: string,
    contractId: number,
    onUpdate: (u: ContractUpdate) => void
  ): () => void {
    let closed = false;
    let socket: MinimalWebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = async () => {
      if (closed) return;
      let socketUrl: string;
      try {
        socketUrl = await this.requestSocketUrl(accessToken, accountId);
      } catch {
        scheduleReconnect();
        return;
      }
      if (closed) return;
      try {
        socket = this.wsFactory(socketUrl);
        this.sockets.add(socket);
      } catch {
        scheduleReconnect();
        return;
      }
      socket.addEventListener('open', () => {
        try {
          socket!.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1, req_id: 1 }));
        } catch {
          scheduleReconnect();
        }
      });
      socket.addEventListener('message', (event: any) => {
        let msg: any;
        try {
          msg = typeof event?.data === 'string' ? JSON.parse(event.data) : null;
        } catch {
          return;
        }
        if (msg?.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
          onUpdate(mapContract(msg.proposal_open_contract));
        }
      });
      socket.addEventListener('close', () => {
        if (socket) this.sockets.delete(socket);
        socket = null;
        scheduleReconnect();
      });
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void open();
      }, 3_000);
      (reconnectTimer as any)?.unref?.();
    };

    void open();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      if (socket) this.sockets.delete(socket);
    };
  }

  /**
   * The account's open contracts, from `portfolio`. Used to reconcile a purchase
   * whose confirmation was lost: the contract exists on Deriv even though its id
   * never reached us, so we find it here instead of retrying the buy.
   */
  async getOpenContracts(
    accountId: string,
    _accountMode: AccountMode,
    accessToken: string
  ): Promise<ContractUpdate[]> {
    const msg = await this.request<any>(
      accessToken,
      accountId,
      { portfolio: 1, req_id: 1 },
      { uncertainOnTimeout: false, expect: 'portfolio' }
    );
    const contracts = Array.isArray(msg.portfolio?.contracts) ? msg.portfolio.contracts : [];
    return contracts.map((c: any) => mapContract(c));
  }

  async getBalance(accountId: string, _accountMode: AccountMode, accessToken: string): Promise<number> {
    const msg = await this.request<any>(accessToken, accountId, { balance: 1, req_id: 1 }, {
      uncertainOnTimeout: false,
      expect: 'balance'
    });
    const body = msg.balance && typeof msg.balance === 'object' ? msg.balance : msg;
    const balance = toNumber(body.balance);
    if (balance === null) {
      throw new BrokerError('rejected', 'Deriv returned a balance without a usable figure.');
    }
    return balance;
  }

  close(): void {
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
  }
}

/** Maps a Deriv `proposal_open_contract` payload to a normalised update. */
export function mapContract(c: any): ContractUpdate {
  const isSold = c.is_sold === 1 || c.is_sold === true;
  const status = normaliseStatus(c.status, isSold);
  return {
    contractId: toNumber(c.contract_id) ?? 0,
    status,
    profit: toNumber(c.profit),
    isExpired: c.is_expired === 1 || c.is_expired === true || isSold,
    entrySpot: toNumber(c.entry_spot),
    exitSpot: toNumber(c.exit_tick) ?? toNumber(c.exit_spot),
    currentSpot: toNumber(c.current_spot),
    payout: toNumber(c.payout),
    dateStart: toNumber(c.date_start),
    dateExpiry: toNumber(c.date_expiry),
    dateSettlement: toNumber(c.date_settlement)
  };
}

function normaliseStatus(status: unknown, isSold: boolean): ContractStatus {
  if (status === 'won' || status === 'lost' || status === 'open') return status;
  if (isSold) return 'unknown';
  return 'open';
}
