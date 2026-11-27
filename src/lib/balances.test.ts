import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BALANCE_STATE_LABEL,
  formatMoney,
  isDerivTokenExpired,
  lastUpdatedLabel,
  lastUpdatedShort,
  pickAccount,
  splitByMode,
  totalBalance,
  type AccountBalance,
} from './balances';

/**
 * Balance display rules.
 *
 * A failed read must never render as a number (null -> em dash, never "0.00"),
 * DEMO and REAL are never substituted for one another, and a group total is
 * withheld whenever it would have to invent a figure.
 */

function acct(over: Partial<AccountBalance>): AccountBalance {
  return {
    accountId: 'A',
    mode: 'demo',
    currency: 'USD',
    balance: null,
    state: 'ok',
    lastUpdated: null,
    ...over,
  };
}

/* ---------------------------- formatMoney ---------------------------- */

test('formatMoney shows a balance with its currency', () => {
  assert.equal(formatMoney(10092.59, 'USD'), '10,092.59 USD');
});

test('formatMoney omits a missing currency', () => {
  assert.equal(formatMoney(1234.5, null), '1,234.50');
});

test('a real zero renders as 0.00, not an em dash', () => {
  assert.equal(formatMoney(0, 'USD'), '0.00 USD');
});

test('a null balance renders as an em dash, never 0', () => {
  assert.equal(formatMoney(null, 'USD'), '—');
});

/* ---------------------------- pickAccount ---------------------------- */

test('pickAccount prefers the selection within the mode, else the first of that mode', () => {
  const accounts = [
    acct({ accountId: 'D1', mode: 'demo', balance: 10 }),
    acct({ accountId: 'R1', mode: 'real', balance: 20 }),
    acct({ accountId: 'D2', mode: 'demo', balance: 30 }),
  ];
  assert.equal(pickAccount(accounts, 'demo', null)?.accountId, 'D1');
  assert.equal(pickAccount(accounts, 'real', null)?.accountId, 'R1');
  assert.equal(pickAccount(accounts, 'demo', 'D2')?.accountId, 'D2');
  // A selection of the other mode must not leak across.
  assert.equal(pickAccount(accounts, 'demo', 'R1')?.accountId, 'D1');
});

test('pickAccount returns null when the mode has no account', () => {
  assert.equal(pickAccount([acct({ accountId: 'D1', mode: 'demo' })], 'real', null), null);
  assert.equal(pickAccount([], 'demo', null), null);
});

/* ---------------------------- splitByMode ---------------------------- */

test('splitByMode keeps DEMO and REAL apart, order preserved', () => {
  const { demo, real } = splitByMode([
    acct({ accountId: 'D1', mode: 'demo' }),
    acct({ accountId: 'R1', mode: 'real' }),
    acct({ accountId: 'D2', mode: 'demo' }),
  ]);
  assert.deepEqual(
    demo.map((a) => a.accountId),
    ['D1', 'D2']
  );
  assert.deepEqual(
    real.map((a) => a.accountId),
    ['R1']
  );
});

/* ---------------------------- totalBalance --------------------------- */

test('totalBalance sums known balances sharing one currency', () => {
  const total = totalBalance([
    acct({ accountId: 'D1', balance: 100, state: 'ok' }),
    acct({ accountId: 'D2', balance: 50, state: 'stale' }),
  ]);
  assert.deepEqual(total, { total: 150, currency: 'USD' });
});

test('totalBalance ignores accounts whose read failed', () => {
  const total = totalBalance([
    acct({ accountId: 'D1', balance: 100 }),
    acct({ accountId: 'D2', balance: null, state: 'unavailable' }),
  ]);
  assert.deepEqual(total, { total: 100, currency: 'USD' });
});

test('totalBalance is null when nothing is known — never a fabricated 0', () => {
  assert.equal(totalBalance([acct({ balance: null, state: 'unavailable' })]), null);
  assert.equal(totalBalance([]), null);
});

test('totalBalance withholds a total across mixed currencies', () => {
  assert.equal(
    totalBalance([
      acct({ accountId: 'D1', balance: 100, currency: 'USD' }),
      acct({ accountId: 'D2', balance: 100, currency: 'EUR' }),
    ]),
    null
  );
});

/* --------------------------- state labels ---------------------------- */

test('balance state labels are stable', () => {
  assert.equal(BALANCE_STATE_LABEL.ok, 'Live');
  assert.equal(BALANCE_STATE_LABEL.unavailable, 'Unavailable');
  assert.equal(BALANCE_STATE_LABEL.disconnected, 'Disconnected');
  assert.equal(BALANCE_STATE_LABEL.stale, 'Stale');
});

/* --------------------------- last updated ---------------------------- */

const T = 1_000_000_000_000;

test('lastUpdatedShort never shows a number when the age is unknown', () => {
  assert.equal(lastUpdatedShort(null, T), '—');
  assert.equal(lastUpdatedShort(T, T), 'now');
  assert.equal(lastUpdatedShort(T, T + 12_000), '12s');
  assert.equal(lastUpdatedShort(T, T + 3 * 60_000), '3m');
  assert.equal(lastUpdatedShort(T, T + 2 * 3_600_000), '2h');
  // A future timestamp clamps to now rather than going negative.
  assert.equal(lastUpdatedShort(T, T - 5_000), 'now');
});

test('lastUpdatedLabel reads plainly for every age', () => {
  assert.equal(lastUpdatedLabel(null, T), 'Never updated');
  assert.equal(lastUpdatedLabel(T, T), 'Updated just now');
  assert.equal(lastUpdatedLabel(T, T + 45_000), 'Updated 45s ago');
  assert.equal(lastUpdatedLabel(T, T + 5 * 60_000), 'Updated 5m ago');
  assert.equal(lastUpdatedLabel(T, T + 4 * 3_600_000), 'Updated 4h ago');
});

/* ------------------------- token expiry ------------------------------ */

test('isDerivTokenExpired is true only once the expiry is in the past', () => {
  assert.equal(isDerivTokenExpired(T - 1, T), true, 'expiry just passed is expired');
  assert.equal(isDerivTokenExpired(T, T), true, 'expiry exactly now is expired');
  assert.equal(isDerivTokenExpired(T + 1, T), false, 'a future expiry is still valid');
});

test('isDerivTokenExpired never fabricates an expiry from a missing value', () => {
  assert.equal(isDerivTokenExpired(null, T), false, 'unknown expiry is not treated as expired');
  assert.equal(isDerivTokenExpired(0, T), false, 'a zero/unset expiry is not expired');
  assert.equal(isDerivTokenExpired(-1, T), false, 'a negative expiry is not expired');
});
