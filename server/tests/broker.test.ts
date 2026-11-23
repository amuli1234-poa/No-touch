import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { DerivBroker, mapContract } from '../execution/broker/derivBroker.js';
import { BrokerError } from '../execution/broker/types.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/**
 * Phase 6 tests for the real Deriv broker adapter's *protocol* behaviour.
 *
 * A scripted socket and a stubbed `fetch` stand in for Deriv, so these prove the
 * OTP-URL flow, the ask-price-only buy, the uncertain-outcome classification and
 * the contract mapping without any network or live account.
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
    },
    isClosed: () => closed,
    emit: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e)),
    sent
  };
}

const OTP_URL = 'wss://api.derivws.com/trading/v1/options/ws/real?otp=abc';

/** Lets the adapter's awaited OTP fetch resolve and its socket listeners attach. */
const tick = () => new Promise((r) => setImmediate(r));

function proposalRequest(retainForBuy = false) {
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
    reqId: 1,
    retainForBuy
  };
}

async function requestBuyableProposal(broker: DerivBroker, sock: ReturnType<typeof fakeSocket>) {
  const proposal = broker.requestProposal(proposalRequest(true));
  await tick();
  sock.emit('open');
  assert.equal(sock.sent[0].proposal, 1);
  assert.equal(sock.sent[0].subscribe, 1);
  sock.emit('message', {
    data: JSON.stringify({
      msg_type: 'proposal',
      req_id: 1,
      proposal: { id: 'prop-1', ask_price: 1.23, payout: 2.4, spot: 100, date_start: 1, longcode: 'x' }
    })
  });
  return await proposal;
}

/** Stubs global fetch to answer the OTP call with a Deriv socket URL. */
function stubOtp(otpUrl = OTP_URL, ok = true) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: string) => {
    calls.push(String(url));
    return {
      ok,
      status: ok ? 200 : 401,
      json: async () => ({ data: { url: otpUrl } })
    } as any;
  };
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = original;
    }
  };
}

test('a proposal is sent over an OTP-authenticated socket and mapped back', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    timeoutMs: 200
  });
  try {
    const p = broker.requestProposal({
      ...proposalRequest()
    });
    // The OTP endpoint was called for the right account.
    await tick();
    assert.ok(otp.calls.some((u) => u.includes('/accounts/VRTC1/otp')));
    sock.emit('open');
    assert.equal(sock.sent[0].proposal, 1);
    assert.equal(sock.sent[0].subscribe, undefined);
    assert.equal(sock.sent[0].contract_type, 'CALL');
    assert.equal(sock.sent[0].underlying_symbol, 'R_100');
    sock.emit('message', {
      data: JSON.stringify({
        msg_type: 'proposal',
        req_id: 1,
        proposal: { id: 'prop-1', ask_price: 1.23, payout: 2.4, spot: 100, date_start: 1, longcode: 'x' }
      })
    });
    const result = await p;
    assert.equal(result.proposalId, 'prop-1');
    assert.equal(result.askPrice, 1.23);
    // The socket is closed after the response.
    assert.equal(sock.isClosed(), true);
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a trade buys a streaming proposal on the same connection', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), { wsFactory: () => sock as unknown as MinimalWebSocket, timeoutMs: 200 });
  try {
    const proposal = await requestBuyableProposal(broker, sock);
    assert.equal(sock.isClosed(), false);
    const p = broker.buy({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      proposalId: proposal.proposalId,
      price: proposal.askPrice,
      reqId: 2
    });
    assert.equal(sock.sent.length, 2);
    assert.equal(sock.sent[1].buy, 'prop-1');
    assert.equal(sock.sent[1].price, 1.23);
    assert.equal(otp.calls.length, 1, 'proposal and buy reuse one OTP socket');
    sock.emit('message', {
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
    const result = await p;
    assert.equal(result.contractId, 999);
    assert.equal(result.transactionId, 555);
    assert.equal(sock.isClosed(), true);
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a buy refuses an expired proposal instead of opening a new socket', async () => {
  const otp = stubOtp();
  const broker = new DerivBroker(makeConfig(), { wsFactory: () => fakeSocket() as unknown as MinimalWebSocket });
  try {
    await assert.rejects(
      () =>
        broker.buy({
          accountId: 'VRTC1',
          accessToken: 'tok',
          accountMode: 'demo',
          proposalId: 'stale-proposal',
          price: 1.23,
          reqId: 2
        }),
      (error: unknown) => error instanceof BrokerError && error.code === 'rejected'
    );
    assert.equal(otp.calls.length, 0);
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a Deriv rejection is a definite failure, not an uncertain one', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), { wsFactory: () => sock as unknown as MinimalWebSocket, timeoutMs: 200 });
  try {
    await requestBuyableProposal(broker, sock);
    const p = broker.buy({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      proposalId: 'prop-1',
      price: 1.23,
      reqId: 2
    });
    sock.emit('message', { data: JSON.stringify({ msg_type: 'buy', error: { code: 'InvalidPrice', message: 'nope' } }) });
    await assert.rejects(
      p,
      (e: unknown) => e instanceof BrokerError && e.code === 'rejected' && e.uncertain === false && e.derivCode === 'InvalidPrice'
    );
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a buy timeout is classified uncertain, so it is never blindly retried', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), { wsFactory: () => sock as unknown as MinimalWebSocket, timeoutMs: 20 });
  try {
    const proposal = await requestBuyableProposal(broker, sock);
    const p = broker.buy({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      proposalId: proposal.proposalId,
      price: 1.23,
      reqId: 2
    });
    // No response; the timeout fires.
    await assert.rejects(p, (e: unknown) => e instanceof BrokerError && e.code === 'timeout' && e.uncertain === true);
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a sell is scoped to the account and requests the contract at market price', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    timeoutMs: 200
  });
  try {
    const salePromise = broker.sell({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      contractId: 999,
      price: 0,
      reqId: 3
    });
    await tick();
    assert.ok(otp.calls.some((url) => url.includes('/accounts/VRTC1/otp')));
    sock.emit('open');
    assert.deepEqual(sock.sent[0], { sell: 999, price: 0, req_id: 3 });
    sock.emit('message', {
      data: JSON.stringify({
        msg_type: 'sell',
        req_id: 3,
        sell: { contract_id: 999, sold_for: 1.75, balance_after: 100.5, transaction_id: 601 }
      })
    });
    assert.deepEqual(await salePromise, {
      contractId: 999,
      soldFor: 1.75,
      balanceAfter: 100.5,
      transactionId: 601
    });
    assert.equal(sock.isClosed(), true);
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a sell refused with InvalidOfferings is a definite, distinct rejection', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    timeoutMs: 200
  });
  try {
    const salePromise = broker.sell({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      contractId: 999,
      price: 0,
      reqId: 4
    });
    await tick();
    sock.emit('open');
    sock.emit('message', {
      data: JSON.stringify({
        msg_type: 'sell',
        req_id: 4,
        error: {
          code: 'InvalidOfferings',
          message: 'Contract is too close to expiry to be sold.'
        }
      })
    });

    const err = await salePromise.then(
      () => null,
      (e) => e
    );
    assert.ok(err instanceof BrokerError);
    // Definite, not uncertain: the sale did not happen and never will.
    assert.equal(err.code, 'invalid_offerings');
    assert.equal(err.uncertain, false);
    assert.equal(err.derivCode, 'InvalidOfferings');
  } finally {
    broker.close();
    otp.restore();
  }
});

test('InvalidOfferings on a buy is not reclassified as a sell refusal', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    timeoutMs: 200
  });
  try {
    // A buy is only accepted on the socket that holds its proposal, so the
    // proposal is requested first — exactly as the real flow does.
    const proposal = await requestBuyableProposal(broker, sock);
    const buyPromise = broker.buy({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      proposalId: proposal.proposalId,
      price: proposal.askPrice,
      reqId: 5
    });
    sock.emit('message', {
      data: JSON.stringify({
        msg_type: 'buy',
        req_id: 5,
        error: { code: 'InvalidOfferings', message: 'Invalid offerings.' }
      })
    });

    const err = await buyPromise.then(
      () => null,
      (e) => e
    );
    assert.ok(err instanceof BrokerError);
    // The sell-specific meaning must not leak onto a purchase.
    assert.equal(err.code, 'rejected');
    assert.equal(err.derivCode, 'InvalidOfferings');
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a sell timeout is uncertain and cannot be treated as a confirmed close', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    timeoutMs: 20
  });
  try {
    const salePromise = broker.sell({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      contractId: 999,
      price: 0,
      reqId: 3
    });
    await tick();
    sock.emit('open');
    await assert.rejects(
      salePromise,
      (error: unknown) => error instanceof BrokerError && error.code === 'timeout' && error.uncertain
    );
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a sell response without the requested contract id remains uncertain', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    timeoutMs: 200
  });
  try {
    const salePromise = broker.sell({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      contractId: 999,
      price: 0,
      reqId: 3
    });
    await tick();
    sock.emit('open');
    sock.emit('message', {
      data: JSON.stringify({ msg_type: 'sell', req_id: 3, sell: { sold_for: 1.75 } })
    });
    await assert.rejects(
      salePromise,
      (error: unknown) => error instanceof BrokerError && error.code === 'unknown' && error.uncertain
    );
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a proposal timeout is NOT uncertain, because no money moved', async () => {
  const otp = stubOtp();
  const sock = fakeSocket();
  const broker = new DerivBroker(makeConfig(), { wsFactory: () => sock as unknown as MinimalWebSocket, timeoutMs: 20 });
  try {
    const p = broker.requestProposal({
      accountId: 'VRTC1',
      accessToken: 'tok',
      accountMode: 'demo',
      payload: { amount: 1, basis: 'stake', contract_type: 'CALL', currency: 'USD', underlying_symbol: 'R_100', duration: 5, duration_unit: 'm' },
      reqId: 1
    });
    await tick();
    sock.emit('open');
    await assert.rejects(p, (e: unknown) => e instanceof BrokerError && e.code === 'timeout' && e.uncertain === false);
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a failed OTP request is a definite otp_failed error', async () => {
  const otp = stubOtp(OTP_URL, false);
  const broker = new DerivBroker(makeConfig(), { wsFactory: () => fakeSocket() as unknown as MinimalWebSocket, timeoutMs: 50 });
  try {
    await assert.rejects(
      () =>
        broker.requestProposal({
          accountId: 'VRTC1',
          accessToken: 'tok',
          accountMode: 'demo',
          payload: { amount: 1, basis: 'stake', contract_type: 'CALL', currency: 'USD', underlying_symbol: 'R_100', duration: 5, duration_unit: 'm' },
          reqId: 1
        }),
      (e: unknown) => e instanceof BrokerError && e.code === 'otp_failed'
    );
  } finally {
    broker.close();
    otp.restore();
  }
});

test('a non-Deriv session URL is refused', async () => {
  const otp = stubOtp('wss://evil.example.com/ws');
  const broker = new DerivBroker(makeConfig(), { wsFactory: () => fakeSocket() as unknown as MinimalWebSocket, timeoutMs: 50 });
  try {
    await assert.rejects(
      () =>
        broker.requestProposal({
          accountId: 'VRTC1',
          accessToken: 'tok',
          accountMode: 'demo',
          payload: { amount: 1, basis: 'stake', contract_type: 'CALL', currency: 'USD', underlying_symbol: 'R_100', duration: 5, duration_unit: 'm' },
          reqId: 1
        }),
      (e: unknown) => e instanceof BrokerError && e.code === 'otp_failed'
    );
  } finally {
    broker.close();
    otp.restore();
  }
});

test('mapContract normalises a settled win', () => {
  const u = mapContract({
    contract_id: 1,
    status: 'won',
    is_sold: 1,
    is_expired: 1,
    profit: 1.5,
    entry_spot: 100,
    exit_tick: 101,
    payout: 2,
    date_start: 10,
    date_expiry: 20,
    date_settlement: 21
  });
  assert.equal(u.status, 'won');
  assert.equal(u.profit, 1.5);
  assert.equal(u.isExpired, true);
  assert.equal(u.entrySpot, 100);
  assert.equal(u.exitSpot, 101);
});

test('mapContract recognizes a Deriv-sold contract as settled', () => {
  const update = mapContract({
    contract_id: 2,
    status: 'sold',
    is_sold: 1,
    is_expired: 1,
    profit: -0.25,
    sell_price: 0.75
  });
  assert.equal(update.status, 'sold');
  assert.equal(update.isExpired, true);
  assert.equal(update.soldFor, 0.75);
});
