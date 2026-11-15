import test from 'node:test';
import assert from 'node:assert/strict';

import { saveErrorMessage, saveExecutionPreferences } from './trade';

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
