import { formatMoney, pickAccount, BALANCE_STATE_LABEL, type AccountBalance } from '../lib/balances';

/**
 * Tests for the balance display helpers.
 *
 * These guard the rule that a failed read is never rendered as a number: a null
 * balance must render as an em dash, never "0.00". They also cover which record
 * is chosen per mode, since DEMO and REAL must never be substituted for each
 * other.
 */

console.log('🧪 Starting Balance Display Test Suite...\n');

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failCount++;
  }
}

const acct = (over: Partial<AccountBalance>): AccountBalance => ({
  accountId: 'A',
  mode: 'demo',
  currency: 'USD',
  balance: null,
  state: 'ok',
  lastUpdated: null,
  ...over
});

/* ---------------------------- formatMoney ---------------------------- */

assert(formatMoney(10092.59, 'USD') === '10,092.59 USD', 'formats a balance with its currency');
assert(formatMoney(1234.5, null) === '1,234.50', 'formats a balance without a currency');
assert(formatMoney(0, 'USD') === '0.00 USD', 'a real zero renders as 0.00, not an em dash');
assert(formatMoney(null, 'USD') === '—', 'a null balance renders as an em dash, never 0');

/* ---------------------------- pickAccount ---------------------------- */

const accounts: AccountBalance[] = [
  acct({ accountId: 'D1', mode: 'demo', balance: 10 }),
  acct({ accountId: 'R1', mode: 'real', balance: 20 }),
  acct({ accountId: 'D2', mode: 'demo', balance: 30 })
];

assert(pickAccount(accounts, 'demo', null)?.accountId === 'D1', 'no selection -> first demo account');
assert(pickAccount(accounts, 'real', null)?.accountId === 'R1', 'no selection -> first real account');
assert(pickAccount(accounts, 'demo', 'D2')?.accountId === 'D2', 'honours the selected account within the mode');
assert(
  pickAccount(accounts, 'demo', 'R1')?.accountId === 'D1',
  'a selection of the other mode does not leak across — falls back within mode'
);
assert(pickAccount([acct({ accountId: 'D1', mode: 'demo' })], 'real', null) === null, 'no real account -> null');
assert(pickAccount([], 'demo', null) === null, 'no accounts -> null');

/* --------------------------- state labels ---------------------------- */

assert(BALANCE_STATE_LABEL.ok === 'Live', 'ok maps to Live');
assert(BALANCE_STATE_LABEL.unavailable === 'Unavailable', 'unavailable maps to Unavailable');
assert(BALANCE_STATE_LABEL.disconnected === 'Disconnected', 'disconnected maps to Disconnected');
assert(BALANCE_STATE_LABEL.stale === 'Stale', 'stale maps to Stale');

console.log(`\n${'='.repeat(52)}`);
console.log(`Balance display tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error('❌ Balance display test suite FAILED');
  process.exit(1);
}
console.log('✅ Balance display test suite PASSED');
