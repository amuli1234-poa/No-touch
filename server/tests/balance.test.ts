import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';

import { createApp } from '../index.js';
import type { ServerConfig } from '../config.js';
import { Store } from '../store/store.js';
import type { UserRecord, SessionRecord } from '../store/store.js';
import { sign, seal } from '../lib/crypto.js';
import { BalanceService, BalanceAccessError } from '../services/balance.js';
import { fetchBalance, DerivBalanceError, type MinimalWebSocket } from '../lib/balance.js';

/**
 * Account balance tests: isolation, DEMO/REAL separation, stale data and
 * unavailable balances.
 *
 * Two layers are exercised, both against real code:
 *  - the BalanceService + balance reader, with an injected fetcher / socket so
 *    the happy path and the failure paths are deterministic;
 *  - the real Express routes over HTTP, with a signed session cookie, to prove
 *    ownership and mode are enforced on the server and that no token leaks.
 */

function makeConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    storageEngine: 'auto',
    deriv: {
      appId: 'test-app',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'trade',
      authorizationEndpoint: 'http://127.0.0.1:1/oauth2/auth',
      tokenEndpoint: 'http://127.0.0.1:1/oauth2/token',
      userinfoEndpoint: 'http://127.0.0.1:1/userinfo',
      revocationEndpoint: 'http://127.0.0.1:1/oauth2/revoke',
      // Unreachable on purpose: any real network read fails fast, which is what
      // the "unavailable" tests rely on.
      apiBaseUrl: 'http://127.0.0.1:1'
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

function makeUser(id: string, accounts: UserRecord['accounts']): UserRecord {
  const now = Date.now();
  return { id, derivSub: `sub_${id}`, accounts, createdAt: now, updatedAt: now, preferences: {} };
}

/* ---------------------- reader: socket + OTP flow ---------------------- */

/** A minimal scriptable WebSocket stand-in. */
function fakeSocket(onSend: (data: string, sock: any) => void): MinimalWebSocket & { emit: (t: string, e?: any) => void } {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const sock: any = {
    addEventListener: (t: string, fn: (e: any) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    send: (d: string) => onSend(d, sock),
    close: () => {},
    emit: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e))
  };
  return sock;
}

function withStubbedFetch<T>(json: unknown, status: number, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => json }) as any;
  return fn().finally(() => {
    (globalThis as any).fetch = original;
  });
}

test('reader returns the balance pushed by Deriv over the account socket', async () => {
  const cfg = makeConfig(os.tmpdir());
  await withStubbedFetch(
    { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc' } },
    200,
    async () => {
      const result = await fetchBalance(cfg, 'token', 'DOT90004580', {
        wsFactory: () => {
          const sock = fakeSocket((data, s) => {
            assert.deepEqual(JSON.parse(data), { balance: 1, req_id: 1 });
            // Deriv nests the fields under `balance`, as documented for
            // "Account Management -> Balance" on developers.deriv.com.
            s.emit('message', {
              data: JSON.stringify({
                echo_req: { balance: 1, req_id: 1 },
                balance: { balance: 1234.56, currency: 'USD', loginid: 'VRTC1' },
                msg_type: 'balance',
                req_id: 1
              })
            });
          });
          setImmediate(() => sock.emit('open'));
          return sock;
        }
      });
      assert.equal(result.balance, 1234.56);
      assert.equal(result.currency, 'USD');
      assert.equal(result.loginId, 'VRTC1');
    }
  );
});

test('reader still accepts a flat balance payload', async () => {
  const cfg = makeConfig(os.tmpdir());
  await withStubbedFetch(
    { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc' } },
    200,
    async () => {
      const result = await fetchBalance(cfg, 'token', 'DOT1', {
        wsFactory: () => {
          const sock = fakeSocket((_data, s) => {
            s.emit('message', { data: JSON.stringify({ msg_type: 'balance', balance: 7.5, currency: 'USD', loginid: 'D1' }) });
          });
          setImmediate(() => sock.emit('open'));
          return sock;
        }
      });
      assert.equal(result.balance, 7.5);
      assert.equal(result.loginId, 'D1');
    }
  );
});

test('reader rejects a balance message with no usable figure (never resolves null)', async () => {
  const cfg = makeConfig(os.tmpdir());
  await withStubbedFetch(
    { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc' } },
    200,
    async () => {
      await assert.rejects(
        () =>
          fetchBalance(cfg, 'token', 'DOT1', {
            wsFactory: () => {
              // A `balance` message whose figure is absent/unusable. Previously
              // this resolved as { balance: null }, which the service cached as
              // `ok` and the UI showed as "—".
              const sock = fakeSocket((_data, s) => {
                s.emit('message', { data: JSON.stringify({ msg_type: 'balance', balance: {} }) });
              });
              setImmediate(() => sock.emit('open'));
              return sock;
            }
          }),
        (err: unknown) => err instanceof DerivBalanceError && err.code === 'balance_failed'
      );
    }
  );
});

test('reader refuses a balance session URL that is not on Deriv', async () => {
  const cfg = makeConfig(os.tmpdir());
  await withStubbedFetch({ data: { url: 'wss://evil.example.com/ws?otp=abc' } }, 200, async () => {
    await assert.rejects(
      () => fetchBalance(cfg, 'token', 'DOT1', { wsFactory: () => fakeSocket(() => {}) }),
      (err: unknown) => err instanceof DerivBalanceError && err.code === 'otp_failed'
    );
  });
});

test('reader surfaces an OTP failure rather than inventing a balance', async () => {
  const cfg = makeConfig(os.tmpdir());
  await withStubbedFetch({ error: 'unauthorized' }, 401, async () => {
    await assert.rejects(
      () => fetchBalance(cfg, 'token', 'DOT1', { wsFactory: () => fakeSocket(() => {}) }),
      (err: unknown) => err instanceof DerivBalanceError && err.code === 'otp_failed' && err.status === 401
    );
  });
});

/* --------------------------- service: rules ---------------------------- */

test('service keeps DEMO and REAL balances separate and distinct', async () => {
  const cfg = makeConfig(os.tmpdir());
  const values: Record<string, number> = { D1: 10_000, R1: 250.75 };
  const svc = new BalanceService(cfg, {
    fetcher: async (_c, _t, accountId) => ({ balance: values[accountId], currency: accountId === 'D1' ? 'USD' : 'EUR', loginId: accountId })
  });
  const user = makeUser('u1', [
    { accountId: 'D1', type: 'demo', currency: 'USD' },
    { accountId: 'R1', type: 'real', currency: 'EUR' }
  ]);

  const all = await svc.readAll(user, 'token');
  assert.equal(all.length, 2);
  const demo = all.find((b) => b.accountId === 'D1')!;
  const real = all.find((b) => b.accountId === 'R1')!;
  assert.equal(demo.mode, 'demo');
  assert.equal(real.mode, 'real');
  assert.equal(demo.balance, 10_000);
  assert.equal(real.balance, 250.75);
  // Never mixed: each carries its own currency and value.
  assert.notEqual(demo.balance, real.balance);
  assert.equal(demo.currency, 'USD');
  assert.equal(real.currency, 'EUR');
});

test('service rejects reading an account that belongs to another user', async () => {
  const cfg = makeConfig(os.tmpdir());
  const svc = new BalanceService(cfg, { fetcher: async () => ({ balance: 1, currency: null, loginId: null }) });
  const alice = makeUser('alice', [{ accountId: 'A_DEMO', type: 'demo' }]);
  const bob = makeUser('bob', [{ accountId: 'B_REAL', type: 'real' }]);

  await assert.rejects(
    () => svc.read(bob, 'A_DEMO', 'token'),
    (err: unknown) => err instanceof BalanceAccessError && err.code === 'account_not_authorized'
  );
  // And Bob's own view never includes Alice's account.
  const bobView = await svc.readAll(bob, 'token');
  assert.deepEqual(bobView.map((b) => b.accountId), ['B_REAL']);
});

test('service rejects a mode that disagrees with the account (no substitution)', async () => {
  const cfg = makeConfig(os.tmpdir());
  let called = 0;
  const svc = new BalanceService(cfg, {
    fetcher: async () => {
      called += 1;
      return { balance: 999, currency: 'USD', loginId: null };
    }
  });
  const user = makeUser('u1', [{ accountId: 'D1', type: 'demo' }]);

  await assert.rejects(
    () => svc.read(user, 'D1', 'token', { expectedMode: 'real' }),
    (err: unknown) => err instanceof BalanceAccessError && err.code === 'account_mode_mismatch'
  );
  // The mismatch is rejected before any broker call — no silent fetch of D1.
  assert.equal(called, 0);
});

test('service reports stale (with the last good value) when a refresh fails', async () => {
  const cfg = makeConfig(os.tmpdir());
  let now = 1_000_000;
  let fail = false;
  const svc = new BalanceService(cfg, {
    ttlMs: 1_000,
    now: () => now,
    fetcher: async () => {
      if (fail) throw new DerivBalanceError('otp_failed', 'down');
      return { balance: 500, currency: 'USD', loginId: null };
    }
  });
  const user = makeUser('u1', [{ accountId: 'D1', type: 'demo', currency: 'USD' }]);

  const first = await svc.read(user, 'D1', 'token');
  assert.equal(first.state, 'ok');
  assert.equal(first.balance, 500);
  const firstTime = first.lastUpdated;

  now += 5_000; // past the TTL so a refresh is attempted
  fail = true;
  const second = await svc.read(user, 'D1', 'token');
  assert.equal(second.state, 'stale');
  // The last good value is preserved — never replaced with zero.
  assert.equal(second.balance, 500);
  assert.equal(second.lastUpdated, firstTime);
  assert.equal(second.reason, 'otp_failed');
});

test('service reports unavailable (balance null, never zero) when the first read fails', async () => {
  const cfg = makeConfig(os.tmpdir());
  const svc = new BalanceService(cfg, {
    fetcher: async () => {
      throw new DerivBalanceError('ws_failed', 'socket died');
    }
  });
  const user = makeUser('u1', [{ accountId: 'R1', type: 'real', currency: 'USD' }]);

  const result = await svc.read(user, 'R1', 'token');
  assert.equal(result.state, 'unavailable');
  assert.equal(result.balance, null);
  assert.equal(result.lastUpdated, null);
  assert.notEqual(result.balance, 0);
});

test('service maps an unusable balance payload to unavailable, never ok with a null balance', async () => {
  const cfg = makeConfig(os.tmpdir());
  // End-to-end through the real reader: a documented nested payload with no
  // usable figure must not be cached as `ok`.
  const svc = new BalanceService(cfg, {
    fetcher: (c, token, accountId) =>
      withStubbedFetch(
        { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc' } },
        200,
        () =>
          fetchBalance(c, token, accountId, {
            wsFactory: () => {
              const sock = fakeSocket((_data, s) => {
                s.emit('message', { data: JSON.stringify({ msg_type: 'balance', balance: {} }) });
              });
              setImmediate(() => sock.emit('open'));
              return sock;
            }
          })
      )
  });
  const user = makeUser('u1', [{ accountId: 'D1', type: 'demo', currency: 'USD' }]);

  const result = await svc.read(user, 'D1', 'token');
  assert.equal(result.state, 'unavailable');
  assert.equal(result.balance, null);
  assert.equal(result.reason, 'balance_failed');
});

test('service reports disconnected when there is no usable Deriv token', async () => {
  const cfg = makeConfig(os.tmpdir());
  let called = 0;
  const svc = new BalanceService(cfg, {
    fetcher: async () => {
      called += 1;
      return { balance: 1, currency: null, loginId: null };
    }
  });
  const user = makeUser('u1', [{ accountId: 'D1', type: 'demo' }]);

  const result = await svc.read(user, 'D1', null);
  assert.equal(result.state, 'disconnected');
  assert.equal(result.balance, null);
  assert.equal(called, 0);
});

test('invalidating a user drops every cached balance for that user only', async () => {
  const cfg = makeConfig(os.tmpdir());
  let now = 1_000_000;
  let value = 100;
  const svc = new BalanceService(cfg, {
    ttlMs: 60_000,
    now: () => now,
    fetcher: async () => ({ balance: value, currency: 'USD', loginId: null })
  });
  const u1 = makeUser('u1', [{ accountId: 'D1', type: 'demo' }]);
  const u2 = makeUser('u2', [{ accountId: 'D2', type: 'demo' }]);

  await svc.read(u1, 'D1', 'token');
  await svc.read(u2, 'D2', 'token');
  value = 200;

  svc.invalidateUser('u1');
  const afterInvalidate = await svc.read(u1, 'D1', 'token');
  const untouched = await svc.read(u2, 'D2', 'token');
  assert.equal(afterInvalidate.balance, 200); // refetched
  assert.equal(untouched.balance, 100); // still cached
});

/* ----------------------- routes: end-to-end HTTP ----------------------- */

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-balance-test-'));
  const cfg = makeConfig(dataDir);
  const store = new Store(dataDir, { engine: cfg.storageEngine });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${addr.port}`, store, cfg, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function seedSession(
  store: Store,
  cfg: ServerConfig,
  id: string,
  accounts: UserRecord['accounts'],
  opts: { tokenExpired?: boolean } = {}
) {
  const now = Date.now();
  await store.upsertUser(makeUser(id, accounts));
  const session: SessionRecord = {
    id: `sess_${id}`,
    userId: id,
    createdAt: now,
    expiresAt: now + 3600_000,
    lastSeenAt: now,
    revoked: false,
    derivTokenSealed: seal('deriv-access-token', cfg.session.secret),
    derivTokenExpiresAt: opts.tokenExpired ? now - 1_000 : now + 3600_000,
    derivSub: `sub_${id}`
  };
  await store.createSession(session);
  return sign(session.id, cfg.session.secret);
}

async function get(base: string, pathname: string, cookie: string | null) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { Accept: 'application/json', ...(cookie ? { Cookie: `ws_session=${cookie}` } : {}) }
  });
  return { status: res.status, json: await res.json().catch(() => null), text: await res.text().catch(() => '') };
}

test('balance routes require a session', async () => {
  const app = await startApp();
  try {
    const res = await get(app.base, '/api/balances', null);
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('route returns only the caller own accounts and never a token', async () => {
  const app = await startApp();
  try {
    const cookie = await seedSession(app.store, app.cfg, 'alice', [
      { accountId: 'A_DEMO', type: 'demo', currency: 'USD' },
      { accountId: 'A_REAL', type: 'real', currency: 'USD' }
    ]);
    const res = await get(app.base, '/api/balances', cookie);
    assert.equal(res.status, 200);
    const ids = (res.json.accounts as any[]).map((a) => a.accountId).sort();
    assert.deepEqual(ids, ['A_DEMO', 'A_REAL']);
    // The read fails against the unreachable broker, so states are explicit —
    // never a fabricated 0.
    for (const a of res.json.accounts) {
      assert.equal(a.balance, null);
      assert.equal(a.state, 'unavailable');
    }
    // No credential material anywhere in the payload.
    assert.ok(!/token/i.test(res.text), 'response must not mention a token');
    assert.ok(!res.text.includes('deriv-access-token'));
  } finally {
    await app.close();
  }
});

test('route rejects reading another user account id', async () => {
  const app = await startApp();
  try {
    const cookie = await seedSession(app.store, app.cfg, 'bob', [{ accountId: 'B_REAL', type: 'real' }]);
    const res = await get(app.base, '/api/balances/A_DEMO', cookie);
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'account_not_authorized');
  } finally {
    await app.close();
  }
});

test('route rejects a mismatched mode parameter', async () => {
  const app = await startApp();
  try {
    const cookie = await seedSession(app.store, app.cfg, 'bob', [{ accountId: 'B_DEMO', type: 'demo' }]);
    const res = await get(app.base, '/api/balances/B_DEMO?mode=real', cookie);
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'account_mode_mismatch');
  } finally {
    await app.close();
  }
});

test('route reports disconnected when the Deriv token has expired', async () => {
  const app = await startApp();
  try {
    const cookie = await seedSession(app.store, app.cfg, 'carol', [{ accountId: 'C_DEMO', type: 'demo' }], {
      tokenExpired: true
    });
    const res = await get(app.base, '/api/balances', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.json.accounts[0].state, 'disconnected');
    assert.equal(res.json.accounts[0].balance, null);
  } finally {
    await app.close();
  }
});

test('route rejects an unknown mode value outright', async () => {
  const app = await startApp();
  try {
    const cookie = await seedSession(app.store, app.cfg, 'dave', [{ accountId: 'D_DEMO', type: 'demo' }]);
    const res = await get(app.base, '/api/balances/D_DEMO?mode=live', cookie);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_mode');
  } finally {
    await app.close();
  }
});
