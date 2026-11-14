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
import { sign } from '../lib/crypto.js';
import { summarise } from '../activity/service.js';
import { SCANNER_ACTIVE_WINDOW_MS } from '../activity/types.js';
import type { UserRecord, SessionRecord } from '../store/store.js';

/**
 * Telemetry ingest + admin read-path integration tests.
 *
 * Everything runs against the real Express app and the real store. The client
 * is simulated by a signed session cookie, exactly as the browser would present
 * it, so the tests exercise the real auth path rather than a stub.
 */

function makeConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    storageEngine: (process.env.TEST_STORAGE_ENGINE as ServerConfig['storageEngine']) ?? 'auto',
    deriv: {
      appId: '34WRcFqUqhHMuCW3O9NQy',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'trade',
      authorizationEndpoint: 'http://127.0.0.1:1/oauth2/auth',
      tokenEndpoint: 'http://127.0.0.1:1/oauth2/token',
      userinfoEndpoint: 'http://127.0.0.1:1/userinfo',
      revocationEndpoint: 'http://127.0.0.1:1/oauth2/revoke',
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

/** A user plus a live session, and the cookie value that authenticates them. */
async function seedUser(store: Store, cfg: ServerConfig, id: string) {
  const now = Date.now();
  const user: UserRecord = {
    id,
    derivSub: `sub_${id}`,
    accounts: [{ accountId: 'CR1', type: 'demo' }],
    createdAt: now,
    updatedAt: now
  };
  await store.upsertUser(user);
  const session: SessionRecord = {
    id: `sess_${id}`,
    userId: id,
    createdAt: now,
    expiresAt: now + 3600_000,
    lastSeenAt: now,
    revoked: false,
    derivTokenSealed: 'sealed',
    derivTokenExpiresAt: now + 3600_000,
    derivSub: `sub_${id}`
  };
  await store.createSession(session);
  return sign(session.id, cfg.session.secret);
}

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-telemetry-test-'));
  const cfg = makeConfig(dataDir);
  const store = new Store(dataDir, { engine: cfg.storageEngine });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    store,
    cfg,
    dataDir,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

async function post(base: string, pathname: string, cookie: string | null, body: unknown) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: `ws_session=${cookie}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/* ------------------------------- tests -------------------------------- */

test('telemetry ingest rejects an unauthenticated client', async () => {
  const app = await startApp();
  try {
    const res = await post(app.base, '/api/telemetry/events', null, { events: [{ kind: 'app.opened' }] });
    assert.equal(res.status, 401);
    assert.equal(app.store.listActivityEvents().length, 0);
  } finally {
    await app.close();
  }
});

test('telemetry ingest stores only known client event kinds and rejects the rest', async () => {
  const app = await startApp();
  try {
    const cookie = await seedUser(app.store, app.cfg, 'u_a');
    const res = await post(app.base, '/api/telemetry/events', cookie, {
      events: [
        { kind: 'scan.started', symbol: 'R_100', timeframe: '1m' },
        { kind: 'not.a.kind' },
        // Server-observed kinds must not be client-writable.
        { kind: 'auth.login' },
        { kind: 'signal.generated', symbol: 'R_50', timeframe: '5m', metrics: { score: 91 } }
      ]
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.accepted, 2);
    assert.equal(res.json.rejected, 2);

    const stored = app.store.listActivityEvents();
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((e) => e.kind),
      ['scan.started', 'signal.generated']
    );
    // The user id comes from the session, never the payload.
    assert.ok(stored.every((e) => e.userId === 'u_a'));
    assert.deepEqual(stored[1].metrics, { score: 91 });
  } finally {
    await app.close();
  }
});

test('heartbeat creates a session and signals increment its counters', async () => {
  const app = await startApp();
  try {
    const cookie = await seedUser(app.store, app.cfg, 'u_a');
    const hb = await post(app.base, '/api/telemetry/heartbeat', cookie, {
      sessionId: 'cli-1',
      symbols: ['R_100', 'R_50'],
      timeframes: ['1m'],
      clientVersion: '1.2.3'
    });
    assert.equal(hb.status, 202);
    assert.equal(hb.json.sessionId, 'u_a:cli-1');

    await post(app.base, '/api/telemetry/events', cookie, {
      events: [
        { kind: 'signal.generated', sessionId: 'cli-1', symbol: 'R_100' },
        { kind: 'signal.generated', sessionId: 'cli-1', symbol: 'R_100' },
        { kind: 'engine.error', sessionId: 'cli-1' }
      ]
    });

    const sessions = app.store.listScannerSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].signalCount, 2);
    assert.equal(sessions[0].errorCount, 1);
    assert.deepEqual(sessions[0].symbols, ['R_100', 'R_50']);
  } finally {
    await app.close();
  }
});

test('one user cannot overwrite another user\u2019s scanner session', async () => {
  const app = await startApp();
  try {
    const cookieA = await seedUser(app.store, app.cfg, 'u_a');
    const cookieB = await seedUser(app.store, app.cfg, 'u_b');

    // Both clients pick the same session id; keys are namespaced by user.
    await post(app.base, '/api/telemetry/heartbeat', cookieA, { sessionId: 'shared', symbols: ['R_100'] });
    await post(app.base, '/api/telemetry/heartbeat', cookieB, { sessionId: 'shared', symbols: ['R_50'] });

    const sessions = app.store.listScannerSessions();
    assert.equal(sessions.length, 2);
    const byUser = Object.fromEntries(sessions.map((s) => [s.userId, s]));
    assert.deepEqual(byUser['u_a'].symbols, ['R_100']);
    assert.deepEqual(byUser['u_b'].symbols, ['R_50']);
  } finally {
    await app.close();
  }
});

test('a signal for an unknown session does not fabricate a session', async () => {
  const app = await startApp();
  try {
    const cookie = await seedUser(app.store, app.cfg, 'u_a');
    await post(app.base, '/api/telemetry/events', cookie, {
      events: [{ kind: 'signal.generated', sessionId: 'never-heartbeated', symbol: 'R_100' }]
    });
    assert.equal(app.store.listScannerSessions().length, 0);
  } finally {
    await app.close();
  }
});

test('oversized batches are rejected before reaching the store', async () => {
  const app = await startApp();
  try {
    const cookie = await seedUser(app.store, app.cfg, 'u_a');
    const events = Array.from({ length: 200 }, () => ({ kind: 'app.opened' }));
    const res = await post(app.base, '/api/telemetry/events', cookie, { events });
    assert.equal(res.status, 413);
    assert.equal(app.store.listActivityEvents().length, 0);
  } finally {
    await app.close();
  }
});

test('summarise reports DAU/MAU and active sessions from recorded events', async () => {
  const app = await startApp();
  try {
    const cookieA = await seedUser(app.store, app.cfg, 'u_a');
    const cookieB = await seedUser(app.store, app.cfg, 'u_b');

    await post(app.base, '/api/telemetry/heartbeat', cookieA, { sessionId: 's1' });
    await post(app.base, '/api/telemetry/events', cookieA, {
      events: [{ kind: 'signal.generated', sessionId: 's1', symbol: 'R_100' }]
    });
    await post(app.base, '/api/telemetry/events', cookieB, { events: [{ kind: 'app.opened' }] });

    const summary = summarise(app.store);
    assert.equal(summary.dau, 2);
    assert.equal(summary.mau, 2);
    assert.equal(summary.activeScannerSessions, 1);
    assert.equal(summary.signalsLast24h, 1);
    assert.ok(summary.lastEventAt !== null);
  } finally {
    await app.close();
  }
});

test('a stale heartbeat is not counted as an active session', async () => {
  const app = await startApp();
  try {
    const cookie = await seedUser(app.store, app.cfg, 'u_a');
    await post(app.base, '/api/telemetry/heartbeat', cookie, { sessionId: 's1' });

    const session = app.store.listScannerSessions()[0];
    // Simulate a client that stopped reporting well outside the active window.
    session.lastSeenAt = Date.now() - SCANNER_ACTIVE_WINDOW_MS - 1000;
    await app.store.upsertScannerSession(session);

    const summary = summarise(app.store);
    assert.equal(summary.activeScannerSessions, 0);
    // The row still exists so an operator can see it went quiet.
    assert.equal(app.store.listScannerSessions().length, 1);
  } finally {
    await app.close();
  }
});
