import test from 'node:test';
import assert from 'node:assert/strict';

import {
  automaticTradingDisabledMessage,
  closeExecutionContract,
  fetchExecutionContracts,
  fetchScannerStatus,
  placeTrade,
  resetDemoRiskSession,
  rejectionMessage,
  saveErrorMessage,
  saveExecutionPreferences
} from './trade';

/**
 * Trade settings save.
 *
 * The panel must never show a bare "could not save": every server rejection
 * carries a code, and an expired session in particular has to read as such
 * rather than as a mystery failure.
 */

test('saveErrorMessage maps a known rejection code', () => {
  assert.equal(saveErrorMessage('unauthorized'), 'Your session has expired. Please sign in again.');
  assert.equal(saveErrorMessage('account_suspended'), 'Your account is suspended. Contact support.');
  assert.equal(saveErrorMessage('account_not_authorized'), 'That account is not linked to your session.');
});

test('saveErrorMessage falls back for an unknown code', () => {
  assert.equal(saveErrorMessage('something_new'), 'Could not save your trade settings.');
});

function stubFetch(response: { status: number; body: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('a 401 with only a code surfaces the session-expired copy, not the generic fallback', async () => {
  const restore = stubFetch({ status: 401, body: { error: 'unauthorized' } });
  try {
    const result = await saveExecutionPreferences({ mode: 'automatic' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error, 'unauthorized');
    assert.equal(result.ok === false && result.message, 'Your session has expired. Please sign in again.');
  } finally {
    restore();
  }
});

test('a server-supplied message is preferred over the local copy', async () => {
  const restore = stubFetch({
    status: 422,
    body: { error: 'invalid_stake', message: 'Stake must be a positive number.' }
  });
  try {
    const result = await saveExecutionPreferences({ stake: { basis: 'stake', amount: -1, currency: 'USD' } });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.message, 'Stake must be a positive number.');
  } finally {
    restore();
  }
});

test('a risk-session reset targets the selected DEMO account', async () => {
  const original = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ preferences: { autoStopped: false } }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await resetDemoRiskSession('VRTC123');
    assert.equal(result.ok, true);
    assert.equal(requestUrl, '/api/execution/risk-session/reset');
    assert.deepEqual(JSON.parse(requestBody), { accountId: 'VRTC123' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a risk-session reset displays the server rejection message', async () => {
  const restore = stubFetch({
    status: 409,
    body: {
      error: 'auto_stop_not_engaged',
      message: 'Automatic execution is not stopped; no risk-session reset was made.'
    }
  });
  try {
    const result = await resetDemoRiskSession('VRTC123');
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.message,
      'Automatic execution is not stopped; no risk-session reset was made.'
    );
  } finally {
    restore();
  }
});

test('a successful save returns the stored preferences', async () => {
  const restore = stubFetch({
    status: 200,
    body: { preferences: { mode: 'automatic', contractFamily: 'rise_fall' } }
  });
  try {
    const result = await saveExecutionPreferences({ mode: 'automatic' });
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && (result.preferences as { mode: string }).mode, 'automatic');
  } finally {
    restore();
  }
});

test('execution contracts are returned only when the server response is valid', async () => {
  const contract = {
    id: '123',
    accountId: 'VRTC123',
    accountMode: 'demo',
    contractType: 'CALL',
    symbol: 'R_100',
    stake: 2,
    currency: 'USD',
    purchaseTime: 1_700_000_000,
    startTime: 1_700_000_000,
    expiryTime: null,
    settlementTime: null,
    status: 'open',
    profit: 0.4,
    closePending: false
  };
  const restore = stubFetch({ status: 200, body: { contracts: [contract] } });
  try {
    const result = await fetchExecutionContracts();
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.contracts[0].profit, 0.4);
  } finally {
    restore();
  }
});

test('execution contract errors explain an expired session', async () => {
  const restore = stubFetch({ status: 401, body: { error: 'unauthorized' } });
  try {
    const result = await fetchExecutionContracts();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.message, 'Sign in again to view your account positions.');
  } finally {
    restore();
  }
});

test('malformed execution contract data is surfaced instead of shown as empty history', async () => {
  const restore = stubFetch({ status: 200, body: { contracts: [{ id: 'not-a-contract' }] } });
  try {
    const result = await fetchExecutionContracts();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error, 'invalid_contracts');
  } finally {
    restore();
  }
});

test('a manual trade rejected by an expired session shows actionable copy', async () => {
  const restore = stubFetch({ status: 401, body: { error: 'unauthorized' } });
  try {
    const result = await placeTrade({
      accountId: 'VRTC123',
      symbol: 'R_100',
      timeframe: '5m',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      stake: 1,
      currency: 'USD',
      parameters: {
        duration: 5,
        durationUnit: 'm',
        multiplier: null,
        cancellation: null,
        stopLoss: null,
        takeProfit: null
      },
      idempotencyKey: 'expired-session-test'
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error, 'unauthorized');
    assert.equal(
      result.ok === false && result.message,
      'Your session has expired. Sign in again before trading.'
    );
    assert.equal(
      rejectionMessage('unauthorized'),
      'Your session has expired. Sign in again before trading.'
    );
  } finally {
    restore();
  }
});

test('a risk rejection explains the open-contract limit without changing it', () => {
  assert.equal(
    rejectionMessage('risk_rejected', ['max_open_contracts']),
    'Maximum open trades reached. Wait for an open position to settle before placing another.'
  );
});

test('a confirmed close request returns success', async () => {
  const restore = stubFetch({ status: 200, body: { contract: { id: '123', status: 'sold' } } });
  try {
    const result = await closeExecutionContract('123');
    assert.deepEqual(result, { ok: true });
  } finally {
    restore();
  }
});

test('an uncertain close response is surfaced as pending and not retried by the client', async () => {
  const restore = stubFetch({
    status: 409,
    body: { error: 'close_pending', message: 'Deriv has not confirmed the sale.' }
  });
  try {
    const result = await closeExecutionContract('123');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.pending, true);
    assert.equal(result.ok === false && result.message, 'Deriv has not confirmed the sale.');
  } finally {
    restore();
  }
});

test('fetchScannerStatus surfaces the automatic-trading switch and its reason', async () => {
  const restore = stubFetch({
    status: 200,
    body: {
      running: false,
      executionEnabled: true,
      demoEnabled: true,
      automaticEnabled: false,
      reason: 'automatic_disabled',
      lastPassAt: null,
      watchedMarkets: [],
      recent: []
    }
  });
  try {
    const status = await fetchScannerStatus();
    assert.equal(status?.automaticEnabled, false);
    assert.equal(status?.reason, 'automatic_disabled');
  } finally {
    restore();
  }
});

test('automatic trading disabled reasons explain the operator action', () => {
  assert.match(automaticTradingDisabledMessage('execution_disabled'), /ALLOW_EXECUTION/);
  assert.match(automaticTradingDisabledMessage('demo_execution_disabled'), /ALLOW_DEMO_EXECUTION/);
  assert.match(automaticTradingDisabledMessage('automatic_disabled'), /ALLOW_AUTOMATIC_TRADING/);
  assert.match(automaticTradingDisabledMessage('automatic_disabled'), /DEMO-only/);
  assert.match(automaticTradingDisabledMessage(null), /Contact the operator/);
});

test('fetchScannerStatus defaults automatic trading to on when the server omits the field', async () => {
  const restore = stubFetch({
    status: 200,
    body: { running: true, executionEnabled: true, demoEnabled: true, reason: null, watchedMarkets: [], recent: [] }
  });
  try {
    const status = await fetchScannerStatus();
    assert.equal(status?.automaticEnabled, true);
    assert.equal(status?.reason, null);
  } finally {
    restore();
  }
});
