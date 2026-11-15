import test from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionContract } from './trade';
import { summarizeContracts } from './positions';

function contract(
  overrides: Partial<ExecutionContract> = {}
): ExecutionContract {
  return {
    id: '1',
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
    profit: 0.5,
    ...overrides
  };
}

test('summaries separate account modes, accounts, and currencies', () => {
  const summaries = summarizeContracts(
    [
      contract(),
      contract({ id: '2', accountId: 'VRTC123', status: 'won', profit: 1 }),
      contract({ id: '3', accountId: 'VRTC456', status: 'lost', profit: -2 }),
      contract({ id: '4', accountMode: 'real', accountId: 'CR123', status: 'won', profit: 8 }),
      contract({ id: '5', currency: 'EUR', status: 'won', profit: 3 })
    ],
    'demo'
  );

  assert.equal(summaries.length, 3);
  assert.deepEqual(
    summaries.map(({ accountId, currency, openProfit, realizedProfit }) => ({
      accountId,
      currency,
      openProfit,
      realizedProfit
    })),
    [
      { accountId: 'VRTC123', currency: 'EUR', openProfit: null, realizedProfit: 3 },
      { accountId: 'VRTC123', currency: 'USD', openProfit: 0.5, realizedProfit: 1 },
      { accountId: 'VRTC456', currency: 'USD', openProfit: null, realizedProfit: -2 }
    ]
  );
});

test('incomplete live or settled profit is unavailable rather than partially summed', () => {
  const [summary] = summarizeContracts(
    [
      contract(),
      contract({ id: '2', profit: null }),
      contract({ id: '3', status: 'won', profit: 1 }),
      contract({ id: '4', status: 'lost', profit: null })
    ],
    'demo'
  );

  assert.equal(summary.openProfit, null);
  assert.equal(summary.openProfitUnavailableCount, 1);
  assert.equal(summary.realizedProfit, null);
  assert.equal(summary.realizedProfitUnavailableCount, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
});
