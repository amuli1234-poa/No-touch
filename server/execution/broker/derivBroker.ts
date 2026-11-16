import type { ServerConfig } from '../../config.js';
import type { MinimalWebSocket } from '../../lib/balance.js';
import { BrokerError } from './types.js';
import type {
  BrokerAdapter,
  ProposalRequest,
  ProposalResult,
  BuyRequest,
  BuyResult,
  SellRequest,
  SellResult,
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
 * Previews use a one-request socket. An actual trade keeps the streaming
 * proposal's socket open just long enough to buy its connection-scoped id, then
 * closes it. `uncertain` is set on any failure that may have reached Deriv (a
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
  private readonly proposals = new Map<string, { socket: MinimalWebSocket; timer: ReturnType<typeof setTimeout> }>();

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
   * Sends one request, resolves with its matching response and closes unless
   * the proposal must stay available for a buy. `uncertainOnTimeout` decides
   * whether a timeout means an unknown outcome or a clean failure.
   */
  private async request<T = any>(
    accessToken: string,
    accountId: string,
    message: Record<string, unknown>,
    opts: { uncertainOnTimeout: boolean; expect: string; retainSocket?: boolean; socket?: MinimalWebSocket }
  ): Promise<{ response: T; socket: MinimalWebSocket | null }> {
    const socketUrl = opts.socket ? null : await this.requestSocketUrl(accessToken, accountId);
    return await new Promise<{ response: T; socket: MinimalWebSocket | null }>((resolve, reject) => {
      let settled = false;
      let socket: MinimalWebSocket | null = opts.socket ?? null;

      const onOpen = () => {
        try {
          socket!.send(JSON.stringify(message));
        } catch {
          finish(() => reject(new BrokerError('socket_failed', 'Could not send the trading request.')));
        }
      };
      const onMessage = (event: any) => {
        let msg: any;
        try {
          msg = typeof event?.data === 'string' ? JSON.parse(event.data) : null;
        } catch {
          return;
        }
        if (!msg) return;
        if (msg.error) {
          finish(() =>
            reject(
              new BrokerError('rejected', msg.error.message || 'Deriv rejected the request.', false, msg.error.code || null)
            )
          );
          return;
        }
        if (msg.msg_type === opts.expect) {
          finish(() => resolve({ response: msg as T, socket: opts.retainSocket ? socket : null }), opts.retainSocket);
        }
      };
      const onError = () => {
        finish(() =>
          reject(new BrokerError('socket_failed', 'The trading socket failed.', opts.uncertainOnTimeout))
        );
      };
      const onClose = () => {
        finish(() =>
          reject(new BrokerError('socket_failed', 'The trading socket closed before a response.', opts.uncertainOnTimeout))
        );
      };
      const detachListeners = () => {
        socket?.removeEventListener?.('open', onOpen);
        socket?.removeEventListener?.('message', onMessage);
        socket?.removeEventListener?.('error', onError);
        socket?.removeEventListener?.('close', onClose);
      };
      const finish = (fn: () => void, retainSocket = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detachListeners();
        if (!retainSocket) {
          try {
            socket?.close();
          } catch {
            /* closing an already-closed socket is not an error */
          }
          if (socket) this.sockets.delete(socket);
        }
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

      if (socket) {
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
        onOpen();
      } else {
        try {
          socket = this.wsFactory(socketUrl!);
          this.sockets.add(socket);
        } catch {
          finish(() => reject(new BrokerError('socket_failed', 'Could not open the trading socket.')));
          return;
        }
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      }
    });
  }

  async requestProposal(req: ProposalRequest): Promise<ProposalResult> {
    const { response: msg, socket } = await this.request<any>(
      req.accessToken,
      req.accountId,
      { proposal: 1, ...req.payload, ...(req.retainForBuy ? { subscribe: 1 } : {}), req_id: req.reqId },
      {
        // A proposal never moves money, so a timeout is a clean failure.
        uncertainOnTimeout: false,
        expect: 'proposal',
        retainSocket: req.retainForBuy
      }
    );
    const p = msg.proposal ?? {};
    const askPrice = toNumber(p.ask_price);
    const proposalId = String(p.id ?? '');
    if (askPrice === null || askPrice <= 0 || !proposalId) {
      if (socket) this.closeSocket(socket);
      throw new BrokerError('rejected', 'Deriv returned a proposal without a usable price.');
    }
    if (req.retainForBuy && socket) {
      const key = this.proposalKey(req.accountId, proposalId);
      const existing = this.proposals.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        this.closeSocket(existing.socket);
      }
      const timer = setTimeout(() => this.releaseProposal(key), this.timeoutMs);
      (timer as any)?.unref?.();
      this.proposals.set(key, { socket, timer });
      socket.addEventListener('close', () => this.releaseProposal(key));
    }
    return {
      proposalId,
      askPrice,
      payout: toNumber(p.payout) ?? 0,
      spot: toNumber(p.spot) ?? 0,
      dateStart: toNumber(p.date_start) ?? 0,
      longcode: String(p.longcode ?? '')
    };
  }

  async buy(req: BuyRequest): Promise<BuyResult> {
    const key = this.proposalKey(req.accountId, req.proposalId);
    const pending = this.proposals.get(key);
    if (!pending) {
      throw new BrokerError('rejected', 'The Deriv proposal session expired before purchase.');
    }
    clearTimeout(pending.timer);
    this.proposals.delete(key);
    const { response: msg } = await this.request<any>(
      req.accessToken,
      req.accountId,
      { buy: req.proposalId, price: req.price, req_id: req.reqId },
      // Reuse the proposal's connection: its streaming id is connection-scoped.
      // The buy may have reached Deriv, so a timeout is an UNKNOWN outcome.
      { uncertainOnTimeout: true, expect: 'buy', socket: pending.socket }
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

  async sell(req: SellRequest): Promise<SellResult> {
    const { response: msg } = await this.request<any>(
      req.accessToken,
      req.accountId,
      { sell: req.contractId, price: req.price, req_id: req.reqId },
      {
        // A sell may have reached Deriv before the response was lost.
        uncertainOnTimeout: true,
        expect: 'sell'
      }
    );
    const sale = msg.sell ?? {};
    const contractId = toNumber(sale.contract_id);
    if (contractId === null) {
      throw new BrokerError('unknown', 'Deriv confirmed a sell response without a contract id.', true);
    }
    if (contractId !== req.contractId) {
      throw new BrokerError('unknown', 'Deriv returned a different contract id for the sale.', true);
    }
    return {
      contractId,
      soldFor: toNumber(sale.sold_for),
      balanceAfter: toNumber(sale.balance_after),
      transactionId: toNumber(sale.transaction_id)
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
    const { response: msg } = await this.request<any>(
      accessToken,
      accountId,
      { portfolio: 1, req_id: 1 },
      { uncertainOnTimeout: false, expect: 'portfolio' }
    );
    const contracts = Array.isArray(msg.portfolio?.contracts) ? msg.portfolio.contracts : [];
    return contracts.map((c: any) => mapContract(c));
  }

  async getBalance(accountId: string, _accountMode: AccountMode, accessToken: string): Promise<number> {
    const { response: msg } = await this.request<any>(accessToken, accountId, { balance: 1, req_id: 1 }, {
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
    for (const pending of this.proposals.values()) clearTimeout(pending.timer);
    this.proposals.clear();
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
  }

  private proposalKey(accountId: string, proposalId: string): string {
    return JSON.stringify([accountId, proposalId]);
  }

  private releaseProposal(key: string): void {
    const pending = this.proposals.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.proposals.delete(key);
    this.closeSocket(pending.socket);
  }

  private closeSocket(socket: MinimalWebSocket): void {
    try {
      socket.close();
    } catch {
      /* closing an already-closed socket is not an error */
    }
    this.sockets.delete(socket);
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
    dateSettlement: toNumber(c.date_settlement),
    soldFor: toNumber(c.sell_price) ?? toNumber(c.sold_for)
  };
}

function normaliseStatus(status: unknown, isSold: boolean): ContractStatus {
  if (status === 'won' || status === 'lost' || status === 'open' || status === 'sold' || status === 'cancelled') {
    return status;
  }
  if (isSold) return 'sold';
  return 'open';
}
