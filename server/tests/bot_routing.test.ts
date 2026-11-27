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
 * Bot Builder routing.
 *
 * The bot app is a separate, gitignored build served under /bot. When that build
 * is absent the route must fail loudly: the previous behaviour fell through to
 * the WickSentinel SPA fallback, which returned 200 with the trader shell, whose
 * router then rendered its own 404 page. The user saw "this page isn't here" for
 * a route that was simply never built.
 *
 * These tests use synthetic fixtures in temp directories so they never depend on
 * the real (gitignored) bot build or on production data.
 */

const SECRET = 'test_session_secret_at_least_32_characters_long_000';

function makeConfig(dataDir: string, botAppDir: string): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    storageEngine: 'json',
    botAppDir,
    deriv: {
      appId: 'test-app-id',
      patAppId: null,
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
      secret: SECRET,
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

const BOT_INDEX = [
  '<!doctype html><html><head><title>Deriv Bot</title>',
  '<link rel="stylesheet" href="/bot/static/css/index.abc123.css">',
  '</head><body><div id="deriv-bot-root"></div>',
  '<script src="/bot/static/js/index.abc123.js"></script>',
  '</body></html>'
].join('');
const SHELL_INDEX = '<!doctype html><html><head><title>WickSentinel</title></head><body><div id="root"></div></body></html>';

interface Harness {
  base: string;
  close: () => Promise<void>;
}

/** Builds an app whose /bot directory is either a synthetic build or absent. */
async function startApp(opts: { botBuild: boolean }): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-botroute-data-'));
  const botRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-botroute-bot-'));
  const botAppDir = path.join(botRoot, 'bot');

  if (opts.botBuild) {
    fs.mkdirSync(path.join(botAppDir, 'static', 'js'), { recursive: true });
    fs.mkdirSync(path.join(botAppDir, 'static', 'css'), { recursive: true });
    fs.writeFileSync(path.join(botAppDir, 'index.html'), BOT_INDEX);
    fs.writeFileSync(path.join(botAppDir, 'static', 'js', 'index.abc123.js'), 'console.log("bot");');
    fs.writeFileSync(path.join(botAppDir, 'static', 'css', 'index.abc123.css'), '.bot{color:red}');
  }

  // A dist/ shell so the SPA fallback is active and can be proven not to claim /bot.
  const distDir = path.join(dataDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), SHELL_INDEX);

  const cfg = makeConfig(dataDir, botAppDir);
  const store = new Store(cfg.dataDir, { engine: 'json' });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

const get = (base: string, url: string) => fetch(`${base}${url}`, { redirect: 'manual' });

/* ========================= 1. BUILD PRESENT ============================== */

test('bot route: serves the Bot Builder when its build exists', async () => {
  const app = await startApp({ botBuild: true });
  try {
    const res = await get(app.base, '/bot/');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /deriv-bot-root/, 'must serve the bot shell');
    assert.doesNotMatch(body, /WickSentinel/, 'must not serve the trader shell');
  } finally {
    await app.close();
  }
});

test('bot route: /bot without a trailing slash reaches the bot app', async () => {
  const app = await startApp({ botBuild: true });
  try {
    const res = await get(app.base, '/bot');
    // express.static redirects the bare mount to its slashed form.
    assert.ok([200, 301].includes(res.status), `unexpected status ${res.status}`);
    if (res.status === 301) {
      assert.equal(res.headers.get('location'), '/bot/');
      const followed = await get(app.base, '/bot/');
      assert.equal(followed.status, 200);
      assert.match(await followed.text(), /deriv-bot-root/);
    } else {
      assert.match(await res.text(), /deriv-bot-root/);
    }
  } finally {
    await app.close();
  }
});

/* ========================= 2. BUILD ABSENT =============================== */

test('bot route: a missing build answers 503 bot_build_missing, not the trader shell', async () => {
  const app = await startApp({ botBuild: false });
  try {
    for (const url of ['/bot/', '/bot', '/bot/some/deep/route']) {
      const res = await get(app.base, url);
      const body = await res.text();
      assert.equal(res.status, 503, `${url} should be 503, got ${res.status}`);
      assert.doesNotMatch(body, /<div id="root">/, `${url} must not serve the SPA shell`);
      assert.doesNotMatch(body, /WickSentinel/, `${url} must not serve the trader shell`);
      const json = JSON.parse(body);
      assert.equal(json.error, 'bot_build_missing');
      assert.equal(typeof json.message, 'string');
    }
  } finally {
    await app.close();
  }
});

/* ========================= 3. DEEP LINKS ================================= */

test('bot route: deep links render the bot shell, which owns its own subtree', async () => {
  const app = await startApp({ botBuild: true });
  try {
    for (const url of ['/bot/dashboard', '/bot/bot-builder/123', '/bot/a/b/c']) {
      const res = await get(app.base, url);
      assert.equal(res.status, 200, `${url} should be 200`);
      assert.match(await res.text(), /deriv-bot-root/, `${url} should serve the bot shell`);
    }
  } finally {
    await app.close();
  }
});

test('bot route: asset-like paths are not rewritten to the bot shell', async () => {
  const app = await startApp({ botBuild: true });
  try {
    const res = await get(app.base, '/bot/static/js/missing.abc123.js');
    // A missing chunk must 404 rather than receive HTML, or the browser tries
    // to parse a page as JavaScript.
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /deriv-bot-root/);
  } finally {
    await app.close();
  }
});

/* ===================== 4. ASSET PATH INTEGRITY =========================== */

test('bot route: every asset referenced by the bot index resolves under /bot/', async () => {
  const app = await startApp({ botBuild: true });
  try {
    const html = await (await get(app.base, '/bot/')).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const local = refs.filter((r) => r.startsWith('/bot/'));
    assert.ok(local.length > 0, 'fixture should reference at least one /bot asset');

    for (const ref of local) {
      const res = await get(app.base, ref);
      assert.equal(res.status, 200, `${ref} should resolve, got ${res.status}`);
    }
  } finally {
    await app.close();
  }
});

/* ================= 5. SPA FALLBACK EXCLUSION ============================= */

test('spa fallback: /bot is excluded but ordinary deep links still get the shell', async () => {
  const app = await startApp({ botBuild: false });
  try {
    // /bot is excluded from the catch-all, so it never receives the shell.
    const bot = await get(app.base, '/bot/pricing');
    assert.equal(bot.status, 503);
    assert.doesNotMatch(await bot.text(), /<div id="root">/);

    // Unrelated client-side routes must keep working.
    for (const url of ['/app', '/app/scanner', '/pricing']) {
      const res = await get(app.base, url);
      assert.equal(res.status, 200, `${url} should still get the SPA shell`);
      assert.match(await res.text(), /<div id="root">/);
    }
  } finally {
    await app.close();
  }
});

test('spa fallback: only the /bot segment is excluded, not similarly-prefixed paths', async () => {
  const app = await startApp({ botBuild: false });
  try {
    // `/botanical` must not be swallowed by the /bot exclusion.
    const res = await get(app.base, '/botanical');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<div id="root">/);
  } finally {
    await app.close();
  }
});

/* ================== 6. PRODUCTION BUILD COMMAND ========================== */

test('deployment: the Render build command builds the bot app', () => {
  const renderYaml = fs.readFileSync(path.resolve(import.meta.dirname, '../../render.yaml'), 'utf8');
  const line = renderYaml.split('\n').find((l) => /^\s*buildCommand:/.test(l));
  assert.ok(line, 'render.yaml must declare a buildCommand');
  assert.match(line!, /npm run build:bot/, 'buildCommand must include `npm run build:bot`');
  // Order matters: the bot build must follow the main install.
  assert.ok(line!.indexOf('npm install') < line!.indexOf('npm run build:bot'));
});

test('deployment: the bot build script exists and targets the served output path', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'));
  assert.match(rootPkg.scripts['build:bot'], /build:bot/);

  const botPkg = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, '../../bot-app/package.json'), 'utf8')
  );
  assert.ok(botPkg.scripts['build:bot'], 'bot-app must expose build:bot');

  // The rsbuild override must emit where the server looks: bot-app/out/bot.
  const rsbuild = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../bot-app/rsbuild.bot.config.ts'),
    'utf8'
  );
  assert.match(rsbuild, /root:\s*'out\/bot'/, 'bot build must emit to out/bot');
  assert.match(rsbuild, /assetPrefix/, 'bot build must set an asset prefix so /bot/ assets resolve');
});
