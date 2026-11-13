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
import { createCodeChallenge } from '../lib/pkce.js';

/**
 * Authentication integration tests.
 *
 * The only stand-in is a local HTTP server that plays the role of Deriv's
 * token / userinfo / accounts endpoints. Everything else — PKCE generation,
 * state validation, replay rejection, cookie signing, the JSON store, session
 * guards — is exercised as the real production code path. No real-money trades
 * are involved anywhere.
 */

interface FakeDeriv {
  url: string;
  close: () => Promise<void>;
  tokenBehaviour: 'ok' | 'invalid_grant' | 'http_500';
  userinfoBehaviour: 'ok' | 'unauthorized';
  accountsBehaviour: 'ok' | 'forbidden' | 'unauthorized';
  accountsData: { account_id: string; account_type: string; currency?: string; status?: string }[];
  lastTokenRequest: Record<string, string> | null;
  tokenRequestCount: number;
}

async function startFakeDeriv(): Promise<FakeDeriv> {
  const state: FakeDeriv = {
    url: '',
    close: async () => {},
    tokenBehaviour: 'ok',
    userinfoBehaviour: 'ok',
    accountsBehaviour: 'ok',
    accountsData: [
      { account_id: 'VRTC90001', account_type: 'demo', currency: 'USD', status: 'active' },
      { account_id: 'CR90002', account_type: 'real', currency: 'USD', status: 'active' }
    ],
    lastTokenRequest: null,
    tokenRequestCount: 0
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/oauth2/token') {
        state.tokenRequestCount++;
        state.lastTokenRequest = Object.fromEntries(new URLSearchParams(body));
        if (state.tokenBehaviour === 'invalid_grant') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }));
          return;
        }
        if (state.tokenBehaviour === 'http_500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ory_at_test_token', expires_in: 3600, token_type: 'Bearer' }));
        return;
      }

      if (url.pathname === '/userinfo') {
        if (state.userinfoBehaviour === 'unauthorized' || !req.headers.authorization) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_token' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sub: 'deriv-subject-abc-123', loginid: 'CR1234567' }));
        return;
      }

      if (url.pathname === '/trading/v1/options/accounts') {
        if (state.accountsBehaviour === 'unauthorized') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ code: 'Unauthorized' }] }));
          return;
        }
        if (state.accountsBehaviour === 'forbidden') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ code: 'AccessDenied' }] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: state.accountsData }));
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

function makeConfig(deriv: FakeDeriv, dataDir: string): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    deriv: {
      appId: '34WRcFqUqhHMuCW3O9NQy',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'openid trade',
      authorizationEndpoint: `${deriv.url}/oauth2/auth`,
      tokenEndpoint: `${deriv.url}/oauth2/token`,
      userinfoEndpoint: `${deriv.url}/userinfo`,
      revocationEndpoint: `${deriv.url}/oauth2/revoke`,
      apiBaseUrl: deriv.url
    },
    session: {
      secret: 'test_session_secret_at_least_32_characters_long_000',
      ttlSeconds: 3600,
      cookieName: 'ws_session',
      oauthCookieName: 'ws_oauth',
      oauthCookieTtlSeconds: 600
    },
    appOrigin: 'http://localhost:8787'
  };
}

async function startApp(deriv: FakeDeriv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-auth-test-'));
  const store = new Store(dataDir);
  await store.load();
  const cfg = makeConfig(deriv, dataDir);
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    store,
    cfg,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

function jar() {
  const cookies = new Map<string, string>();
  return {
    header(): string {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res: Response): void {
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (v === '') cookies.delete(k);
        else cookies.set(k, v);
      }
    }
  };
}

async function get(base: string, pathname: string, cj = jar(), redirect: 'manual' | 'follow' = 'manual') {
  const res = await fetch(`${base}${pathname}`, { headers: { Cookie: cj.header() }, redirect });
  cj.absorb(res);
  return res;
}

/* ------------------------------ test cases ---------------------------- */

test('1. New user registration: signup flow creates a profile and a session', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=signup', cj);
    assert.equal(start.status, 302);
    const authUrl = new URL(start.headers.get('location')!);
    assert.equal(authUrl.searchParams.get('prompt'), 'registration');
    assert.equal(authUrl.searchParams.get('client_id'), '34WRcFqUqhHMuCW3O9NQy');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    const state = authUrl.searchParams.get('state')!;

    const cb = await get(app.base, `/auth/deriv/callback?code=CODE1&state=${state}`, cj);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), 'http://localhost:8787/app');
    const setCookie = cb.headers.getSetCookie().join('; ');
    assert.match(setCookie, /ws_session=/);
    assert.match(setCookie, /HttpOnly/);

    const session = await get(app.base, '/auth/session', cj);
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.user.loginId, 'CR1234567');
    assert.equal(body.user.demoAccounts, 1);
    assert.equal(body.user.realAccounts, 1);

    const sentVerifier = deriv.lastTokenRequest!.code_verifier;
    assert.equal(createCodeChallenge(sentVerifier), authUrl.searchParams.get('code_challenge'));
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('2 & 3. Existing user login recognises the same profile (no duplicate)', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  try {
    const login = async () => {
      const cj = jar();
      const start = await get(app.base, '/auth/start?mode=login', cj);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);
      return cj;
    };
    const cj1 = await login();
    const first = await (await get(app.base, '/auth/session', cj1)).json();
    const cj2 = await login();
    const second = await (await get(app.base, '/auth/session', cj2)).json();

    assert.equal(first.user.id, second.user.id, 'same Deriv subject maps to the same profile');
    assert.equal(app.store.countUsers(), 1, 'no duplicate profile created');

    const firstSession = await get(app.base, '/auth/session', cj1);
    assert.equal(firstSession.status, 401, 'previous session invalidated');
    assert.equal(app.store.countActiveSessions(), 1, 'only one live session per user');
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('4. Invalid OAuth state is rejected', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  try {
    const res = await get(app.base, '/auth/deriv/callback?code=X&state=not-a-real-state');
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location')!, /\/signin-error\?code=invalid_state/);
    assert.equal(deriv.tokenRequestCount, 0, 'no token exchange attempted');
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('5. Cancelled authorization is surfaced', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  try {
    const res = await get(app.base, '/auth/deriv/callback?error=access_denied&error_description=User+cancelled');
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location')!, /\/signin-error\?code=cancelled/);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('6. Expired / invalid authorization code maps to expired_code', async () => {
  const deriv = await startFakeDeriv();
  deriv.tokenBehaviour = 'invalid_grant';
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await get(app.base, `/auth/deriv/callback?code=EXPIRED&state=${state}`, cj);
    assert.match(res.headers.get('location')!, /\/signin-error\?code=expired_code/);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('7. Duplicate callback is rejected and never re-exchanged', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const first = await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);
    assert.equal(first.headers.get('location'), 'http://localhost:8787/app');
    const second = await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);
    assert.match(second.headers.get('location')!, /\/signin-error\?code=duplicate_callback/);
    assert.equal(deriv.tokenRequestCount, 1, 'code exchanged exactly once');
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('8. Invalid / revoked authorization (both identity sources fail) is rejected', async () => {
  const deriv = await startFakeDeriv();
  // Deriv rejects the token on every endpoint that could identify the user.
  deriv.userinfoBehaviour = 'unauthorized';
  deriv.accountsBehaviour = 'unauthorized';
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);
    assert.match(res.headers.get('location')!, /\/signin-error\?code=identity_unverified/);
    const session = await get(app.base, '/auth/session', cj);
    assert.equal(session.status, 401, 'no session established');
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('8b. Identity falls back to the trade-scoped accounts when userinfo is unavailable', async () => {
  const deriv = await startFakeDeriv();
  // `openid` is not allowed for this app, so userinfo is unreachable; the
  // accounts endpoint must still identify the user.
  deriv.userinfoBehaviour = 'unauthorized';
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);
    assert.match(res.headers.get('location')!, /\/app$/);

    const session = await get(app.base, '/auth/session', cj);
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.user.demoAccounts, 1);
    assert.equal(body.user.realAccounts, 1);
    // Identity derived from the accounts is stable, so exactly one profile exists.
    assert.equal(app.store.countUsers(), 1);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('9. Logout destroys the session', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);
    assert.equal((await get(app.base, '/auth/session', cj)).status, 200);

    const logout = await fetch(`${app.base}/auth/logout`, { method: 'POST', headers: { Cookie: cj.header() } });
    assert.equal(logout.status, 204);
    cj.absorb(logout);

    assert.equal((await get(app.base, '/auth/session', cj)).status, 401);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('10. Unauthorized dashboard access is blocked without a session', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  try {
    const res = await get(app.base, '/auth/session');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });

    const res2 = await fetch(`${app.base}/auth/session`, { headers: { Cookie: 'ws_session=forged.sig' } });
    assert.equal(res2.status, 401);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('11. Unauthorized scanner API access is blocked', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  const cj = jar();
  try {
    assert.equal((await get(app.base, '/api/scanner/status')).status, 401);

    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);

    const ok = await get(app.base, '/api/scanner/status', cj);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).authorized, true);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('12. Demo and real accounts are separated on the profile', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);

    const body = await (await get(app.base, '/auth/session', cj)).json();
    const types = body.user.accounts.map((a: any) => a.type).sort();
    assert.deepEqual(types, ['demo', 'real']);
    assert.equal(body.user.demoAccounts, 1);
    assert.equal(body.user.realAccounts, 1);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('12b. Returning user with a changed account set keeps the same profile', async () => {
  const deriv = await startFakeDeriv();
  // `openid` is not allowed, so identity is derived from the account set.
  deriv.userinfoBehaviour = 'unauthorized';
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const first = await get(app.base, '/auth/start?mode=login', cj);
    const s1 = new URL(first.headers.get('location')!).searchParams.get('state')!;
    await get(app.base, `/auth/deriv/callback?code=C&state=${s1}`, cj);
    const before = await (await get(app.base, '/auth/session', cj)).json();
    assert.equal(app.store.countUsers(), 1);

    // The user opens an additional Deriv account, so the account set changes.
    deriv.accountsData = [
      { account_id: 'VRTC90001', account_type: 'demo', currency: 'USD', status: 'active' },
      { account_id: 'CR90002', account_type: 'real', currency: 'USD', status: 'active' },
      { account_id: 'CR90003', account_type: 'real', currency: 'USD', status: 'active' }
    ];
    const second = await get(app.base, '/auth/start?mode=login', cj);
    const s2 = new URL(second.headers.get('location')!).searchParams.get('state')!;
    await get(app.base, `/auth/deriv/callback?code=C&state=${s2}`, cj);
    const after = await (await get(app.base, '/auth/session', cj)).json();

    // Same profile (id and createdAt), no duplicate, accounts refreshed.
    assert.equal(app.store.countUsers(), 1, 'no duplicate profile created');
    assert.equal(after.user.id, before.user.id);
    assert.equal(after.user.createdAt, before.user.createdAt);
    assert.equal(after.user.realAccounts, 2);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('13. Account listing failure does not block login (best effort)', async () => {
  const deriv = await startFakeDeriv();
  deriv.accountsBehaviour = 'forbidden';
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const res = await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);
    assert.equal(res.headers.get('location'), 'http://localhost:8787/app');
    const body = await (await get(app.base, '/auth/session', cj)).json();
    assert.equal(body.user.demoAccounts, 0);
    assert.equal(body.user.realAccounts, 0);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('14. Per-user preferences are session-scoped', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);

    assert.equal((await get(app.base, '/api/preferences')).status, 401, 'anonymous cannot read preferences');

    const put = await fetch(`${app.base}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cj.header() },
      body: JSON.stringify({ preferences: { defaultTimeframe: '5m' } })
    });
    assert.equal(put.status, 200);

    const got = await (await get(app.base, '/api/preferences', cj)).json();
    assert.deepEqual(got.preferences, { defaultTimeframe: '5m' });
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('15. Revoked Deriv authorization invalidates the application session', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv);
  const cj = jar();
  try {
    const start = await get(app.base, '/auth/start?mode=login', cj);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    await get(app.base, `/auth/deriv/callback?code=C&state=${state}`, cj);

    // Token still good -> verify passes.
    const ok = await get(app.base, '/api/deriv/verify', cj);
    assert.equal(ok.status, 200);

    // Deriv now rejects the token (authorization revoked / expired) on every
    // endpoint used to revalidate it.
    deriv.userinfoBehaviour = 'unauthorized';
    deriv.accountsBehaviour = 'unauthorized';
    const revoked = await get(app.base, '/api/deriv/verify', cj);
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json()).error, 'deriv_authorization_revoked');

    // The application session is gone.
    assert.equal((await get(app.base, '/auth/session', cj)).status, 401);
    assert.equal(app.store.countActiveSessions(), 0);
  } finally {
    await app.close();
    await deriv.close();
  }
});
