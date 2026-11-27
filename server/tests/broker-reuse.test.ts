import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { DerivBroker } from '../execution/broker/derivBroker.js';
import { BrokerError } from '../execution/broker/types.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/**
 * Persistent-socket reuse (`reuseSockets: true`).
 *
 * A factory that mints a NEW fake socket per connection lets these prove that
 * one account-bound socket is reused across requests, that responses are
 * correlated by `req_id` (out-of-order and stale replies never cross-talk), and
 * that a dropped socket is replaced on the next request. The default
 * (per-request socket) path is covered by `broker.test.ts`.
 */

function makeConfig(): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir: os.tmpdir(),
    storageEngine: 'auto',
    telemetry: { retentionDays: 30, scannerSessionTtlSeconds: 120 },
    deriv: {
      appId: 'test-app',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'trade',
      authorizationEndpoint: 'http://127.0.0.1:1/oauth2/auth',
      tokenEndpoint: 'http://127.0.0.1:1/oauth2/token',
      userinfoEndpoint: 'http://127.0.0.1:1/userinfo',
      revocationEndpoint: 'http://127.0.0.1:1/oauth2/revoke',
      apiBaseUrl: 'https://api.derivws.com'
    },
    session: {
      secret: 'test_session_secret_at_least_32_characters_long_000',
      ttlSeconds: 3600,
      cookieName: 'ws_session',
      oauthCookieName: 'ws_oauth',
      oauthCookieTtlSeconds: 600
    },
    admin: {
      cookieName: 'ws_admin_session',
      sessionTtlSeconds: 3600,
      mfaPendingTtlSeconds: 300,
      invitationTtlSeconds: 3600,
      resetTtlSeconds: 3600,
      allowedOrigins: [],
      maxFailedLogins: 5,
      lockoutSeconds: 60
    },
    appOrigin: 'http://localhost:8787'
  };
}

function fakeSocket() {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const sent: any[] = [];
  let closed = false;
  let opened = false;
  return {
    addEventListener: (t: string, fn: (e: any) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    removeEventListener: (t: string, fn: (e: any) => void) => {
      listeners[t] = (listeners[t] || []).filter((listener) => listener !== fn);
    },
    send: (d: string) => sent.push(JSON.parse(d)),
    close: () => {
      closed = true;
      (listeners['close'] || []).forEach((fn) => fn({}));
    },
    isClosed: () => closed,
    isOpened: () => opened,
    emit: (t: string, e: any = {}) => {
      if (t === 'open') opened = true;
      (listeners[t] || []).forEach((fn) => fn(e));
    },
    sent
  };
}

/** A factory that records every connection it mints. */
function makeFactory() {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const factory = () => {
    const s = fakeSocket();
    sockets.push(s);
    return s as unknown as MinimalWebSocket;
  };
  return { factory, sockets };
}

const OTP_URL = 'wss://api.derivws.com/trading/v1/options/ws/real?otp=abc';
const tick = () => new Promise((r) => setImmediate(r));

function stubOtp(otpUrl = OTP_URL, ok = true) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: string) => {
    calls.push(String(url));
    return { ok, status: ok ? 200 : 401, json: async () => ({ data: { url: otpUrl } }) } as any;
  };
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = original;
    }
  };
}

function proposalRequest(reqId = 1, retainForBuy = false) {
  return {
    accountId: 'VRTC1',
    accessToken: 'tok',
    accountMode: 'demo' as const,
    payload: {
      amount: 1,
      basis: 'stake' as const,
      contract_type: 'CALL' as const,
      currency: 'USD',
      underlying_symbol: 'R_100',
      duration: 5,
      duration_unit: 'm'
    },
    reqId,
    retainForBuy
  };
}

test('proposal and buy reuse one persistent connection', async () => {
  const otp = stubOtp();
  const { factory, sockets } = makeFactory();
  const broker = new DerivBroker(makeConfig(), { wsFactory: factory, timeoutMs: 200, reuseSockets: true });
  try {
    const p = broker.requestProposal(proposalRequest(1, true));
    await tick();
    assert.equal(sockets.length, 1, 'one connection opened');
    sockets[0].emit('open');
    assert.equal(sockets[0].sent[0].proposal, 1);
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 1,
        proposal: { id: 'prop-1', ask_price: 1.23, payout: 2.4, spot: 100, date_start: 1, longcode: 'x' }
      })
    });
    const proposal = await p;
    assert.equal(proposal.proposalId, 'prop-1');
    assert.equal(sockets[0].isClosed(), false, 'socket stays open after a proposal');

    const b = broker.buy({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      proposalId: proposal.proposalId,
      price: proposal.askPrice,
      reqId: 2
    });
    assert.equal(sockets.length, 1, 'buy reuses the same connection');
    assert.equal(sockets[0].sent.length, 2);
    assert.equal(sockets[0].sent[1].buy, 'prop-1');
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'buy',
        req_id: 2,
        buy: {
          contract_id: 999,
          buy_price: 1.23,
          balance_after: 998.77,
          payout: 2.4,
          purchase_time: 1,
          start_time: 1,
          transaction_id: 555,
          longcode: 'x',
          shortcode: 'y'
        }
      })
    });
    const result = await b;
    assert.equal(result.contractId, 999);
    assert.equal(otp.calls.length, 1, 'only one OTP exchange for both requests');
  } finally {
    broker.close();
    otp.restore();
  }
});

test('out-of-order responses resolve to the correct request', async () => {
  const otp = stubOtp();
  const { factory, sockets } = makeFactory();
  const broker = new DerivBroker(makeConfig(), { wsFactory: factory, timeoutMs: 200, reuseSockets: true });
  try {
    const p1 = broker.requestProposal(proposalRequest(1));
    await tick();
    const p2 = broker.requestProposal(proposalRequest(2));
    await tick();
    sockets[0].emit('open');
    assert.equal(sockets[0].sent.length, 2, 'both requests sent on one socket');

    // Reply to the second request first, then the first.
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 2,
        proposal: { id: 'prop-2', ask_price: 2.0, payout: 3, spot: 1, date_start: 1, longcode: 'b' }
      })
    });
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 1,
        proposal: { id: 'prop-1', ask_price: 1.0, payout: 2, spot: 1, date_start: 1, longcode: 'a' }
      })
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.proposalId, 'prop-1');
    assert.equal(r2.proposalId, 'prop-2');
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a stale req_id reply is ignored', async () => {
  const otp = stubOtp();
  const { factory, sockets } = makeFactory();
  const broker = new DerivBroker(makeConfig(), { wsFactory: factory, timeoutMs: 200, reuseSockets: true });
  try {
    const p = broker.requestProposal(proposalRequest(1));
    await tick();
    sockets[0].emit('open');
    // A reply for a request id nobody is waiting on must not settle anything.
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 99,
        proposal: { id: 'ghost', ask_price: 9, payout: 9, spot: 1, date_start: 1, longcode: 'z' }
      })
    });
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 1,
        proposal: { id: 'prop-1', ask_price: 1.0, payout: 2, spot: 1, date_start: 1, longcode: 'a' }
      })
    });
    const r = await p;
    assert.equal(r.proposalId, 'prop-1');
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a buy timeout on the persistent socket is uncertain', async () => {
  const otp = stubOtp();
  const { factory, sockets } = makeFactory();
  const broker = new DerivBroker(makeConfig(), { wsFactory: factory, timeoutMs: 30, reuseSockets: true });
  try {
    const p = broker.requestProposal(proposalRequest(1, true));
    await tick();
    sockets[0].emit('open');
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 1,
        proposal: { id: 'prop-1', ask_price: 1.23, payout: 2.4, spot: 100, date_start: 1, longcode: 'x' }
      })
    });
    const proposal = await p;
    const b = broker.buy({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      proposalId: proposal.proposalId,
      price: proposal.askPrice,
      reqId: 2
    });
    await assert.rejects(b, (err: any) => {
      assert.ok(err instanceof BrokerError);
      assert.equal(err.code, 'timeout');
      assert.equal(err.uncertain, true, 'a buy timeout may have reached Deriv');
      return true;
    });
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a dropped socket is replaced on the next request', async () => {
  const otp = stubOtp();
  const { factory, sockets } = makeFactory();
  const broker = new DerivBroker(makeConfig(), { wsFactory: factory, timeoutMs: 200, reuseSockets: true });
  try {
    const p1 = broker.requestProposal(proposalRequest(1));
    await tick();
    sockets[0].emit('open');
    sockets[0].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 1,
        proposal: { id: 'prop-1', ask_price: 1.0, payout: 2, spot: 1, date_start: 1, longcode: 'a' }
      })
    });
    await p1;

    // The connection drops.
    sockets[0].emit('close');

    const p2 = broker.requestProposal(proposalRequest(2));
    await tick();
    assert.equal(sockets.length, 2, 'a new connection is opened after the drop');
    sockets[1].emit('open');
    sockets[1].emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 2,
        proposal: { id: 'prop-2', ask_price: 2.0, payout: 3, spot: 1, date_start: 1, longcode: 'b' }
      })
    });
    const r2 = await p2;
    assert.equal(r2.proposalId, 'prop-2');
  } finally {
    broker.close();
    otp.restore();
  }
});