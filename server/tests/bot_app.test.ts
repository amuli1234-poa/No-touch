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

/**
 * The vendored Deriv bot app is mounted at /bot and owns that whole subtree.
 * These tests use a throwaway directory shaped like a real build so they do not
 * depend on `npm run build:bot` having been run.
 */

function makeConfig(dataDir: string, botAppDir: string): ServerConfig {
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
    appOrigin: 'http://localhost:8787',
    botAppDir
  };
}

/** Writes a minimal bot build: an index shell plus one hashed asset. */
function makeBotAppDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bot-app-'));
  fs.mkdirSync(path.join(dir, 'static', 'js'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script src="/bot/static/js/index.abc123.js"></script></body></html>'
  );
  fs.writeFileSync(path.join(dir, 'static', 'js', 'index.abc123.js'), 'console.log("bot");');
  return dir;
}

async function startApp(cfg: ServerConfig) {
  const store = new Store(cfg.dataDir, { engine: cfg.storageEngine });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    store,
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

async function withApp(fn: (base: string) => Promise<void>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bot-data-'));
  const botAppDir = makeBotAppDir();
  const ctx = await startApp(makeConfig(dataDir, botAppDir));
  try {
    await fn(ctx.base);
  } finally {
    await ctx.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(botAppDir, { recursive: true, force: true });
  }
}

test('/bot/ serves the bot app shell', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/bot/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="root"/);
    assert.match(body, /\/bot\/static\/js\/index\.abc123\.js/);
  });
});

test('/bot deep links fall back to the bot shell, not the WickSentinel shell', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/bot/some/deep/route`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /\/bot\/static\/js\/index\.abc123\.js/);
  });
});

test('/bot serves hashed assets from the bot build', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/bot/static/js/index.abc123.js`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'console.log("bot");');
  });
});

test('the bot mount does not swallow the WickSentinel API', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });
});

test('a missing bot build degrades instead of crashing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bot-data-'));
  const ctx = await startApp(makeConfig(dataDir, path.join(dataDir, 'does-not-exist')));
  try {
    // No bot assets are served. The route must fail explicitly rather than
    // falling through to the WickSentinel shell, which would answer 200 with a
    // page whose router has no /bot route (the original 404 report).
    const asset = await fetch(`${ctx.base}/bot/static/js/index.abc123.js`);
    assert.equal(asset.status, 503);

    const shell = await fetch(`${ctx.base}/bot/`);
    assert.equal(shell.status, 503);
    const body = await shell.text();
    assert.equal(JSON.parse(body).error, 'bot_build_missing');
    assert.doesNotMatch(body, /\/bot\/static\/js\/index\.abc123\.js/);
  } finally {
    await ctx.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
