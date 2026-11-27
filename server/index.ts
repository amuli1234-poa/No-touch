import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ServerConfig } from './config.js';
import { Store } from './store/store.js';
import { createAuthRouter } from './routes/auth.js';
import { createWhatsAppRouter } from './routes/whatsapp.js';
import { createTelemetryRouter } from './routes/telemetry.js';
import { createBalancesRouter } from './routes/balances.js';
import { createBotSessionRouter } from './routes/botSession.js';
import { createCopyTradingRouter } from './routes/copyTrading.js';
import { createExecutionRouter } from './routes/execution.js';
import { createBotsRouter } from './bots/routes.js';
import { ExecutionAuditor } from './execution/audit.js';
import { BalanceService } from './services/balance.js';
import { MarketDataService } from './services/marketData.js';
import { createExecution, type ExecutionBundle } from './execution/composition.js';
import { createAdminApiRouter, adminCors } from './routes/admin/index.js';
import { Telemetry, telemetryMiddleware } from './services/admin/telemetry.js';
import { createCache, MemoryCache, type Cache } from './services/cache.js';
import { attachSession, requireSession, type SessionContext, type AuthedRequest } from './lib/session.js';
import { open } from './lib/crypto.js';
import type { ContractStatus } from './execution/types.js';
import { installAsyncErrorForwarding } from './lib/expressAsync.js';

/**
 * WickSentinel server: serves the built SPA and provides the OAuth + session
 * backend. It is additive — the scanner runs unchanged in the browser; this
 * process only handles authentication, sessions and per-user preferences.
 *
 * The administrative API (`/api/admin/v1/*`) is a separate surface with its own
 * cookie, session store and RBAC. It never reuses trader sessions.
 */

export interface AppBundle {
  app: express.Express;
  cfg: ServerConfig;
  store: Store;
  telemetry: Telemetry;
  /** Server-side market data; connected at boot, closed on shutdown. */
  market: MarketDataService;
  /** The execution layer (gateway + kill switches). */
  execution: ExecutionBundle;
  /** The shared cache (Redis when configured, otherwise in-process). */
  cache: Cache;
}

/** Builds the Express app. Exported separately so tests can drive it directly. */
export function createApp(cfg: ServerConfig, store: Store, cache?: Cache, balancesOverride?: BalanceService): AppBundle {
  // Must run before any router is mounted so every layer is patched.
  installAsyncErrorForwarding();
  const ctx: SessionContext = { cfg, store };
  const telemetry = new Telemetry();
  // One balance service per process so the auth router and the balance router
  // share the same cache and invalidation (reauthorization clears it). Tests may
  // inject one whose Deriv reader is stubbed, since the real reader dials Deriv.
  const balances = balancesOverride ?? new BalanceService(cfg);
  // Server-side market data on the public options gateway, plus the execution
  // layer. Kill switches default off, so nothing trades until explicitly enabled.
  const resolvedCache = cache ?? new MemoryCache(cfg.redis?.ttlSeconds ?? 60);
  const market = new MarketDataService(cfg, { cache: resolvedCache });
  const execution = createExecution(cfg, store, balances);
  const app = express();
  app.disable('x-powered-by');

  // Behind a TLS-terminating proxy (GitHub Pages/Cloud Run/Nginx) trust the
  // forwarded protocol so `secure` cookies and HTTPS checks behave correctly.
  app.set('trust proxy', 1);

  // Enforce HTTPS in production for every request that isn't a plain health probe.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (cfg.isProduction && req.path !== '/healthz' && req.protocol !== 'https') {
      const host = req.headers.host;
      res.redirect(308, `https://${host}${req.originalUrl}`);
      return;
    }
    next();
  });

  app.use(telemetryMiddleware(telemetry));

  // Admin API needs a JSON body parser (its routes read structured payloads).
  // Mounted before the session middleware so CORS preflight short-circuits.
  app.use('/api/admin/v1', adminCors({ cfg, store, telemetry }), express.json({ limit: '64kb' }));
  app.use('/api/admin/v1', createAdminApiRouter({ cfg, store, telemetry, balances, flags: execution.flags }));

  app.use(attachSession(ctx));

  app.get('/healthz', async (_req, res) => {
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
      await Promise.race([store.storage.counts(), timeout]);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use(createAuthRouter(ctx, balances));

  // Client telemetry ingest. Needs a JSON body parser, scoped to its own
  // namespace so it never widens the surface of any other route.
  app.use('/api/telemetry', express.json({ limit: '32kb' }));
  app.use(createTelemetryRouter(ctx));
  app.use(createBalancesRouter(ctx, balances));
  app.use(createCopyTradingRouter(ctx, balances, { engine: execution.copyEngine, broker: execution.broker }));
  // Deriv Bot receives a short-lived account-bound WebSocket URL through the
  // signed WickSentinel session. The long-lived OAuth token stays server-side.
  app.use('/api/bot', express.json({ limit: '4kb' }));
  app.use(createBotSessionRouter(ctx));
  // Bot importer and runner. Session-guarded and tenant-scoped; an imported bot
  // is inert data until a run starts, and every entry goes through the gateway.
  app.use(
    createBotsRouter(ctx, store, {
      gateway: execution.gateway,
      runner: execution.runner,
      monitor: execution.monitor,
      auditor: new ExecutionAuditor(store),
      market,
      flags: execution.flags,
      copyEngine: execution.copyEngine
    })
  );
  app.use(
    createExecutionRouter({
      cfg,
      store,
      gateway: execution.gateway,
      market,
      runner: execution.runner,
      monitor: execution.monitor,
      systemSignals: execution.systemSignals,
      flags: execution.flags,
      copyEngine: execution.copyEngine
    })
  );

  // WhatsApp alert dispatch. Status is public (masked); sending requires a session.
  app.use(createWhatsAppRouter());

  // Protected example scanner API surface. The scanner itself is client-side,
  // so this guard demonstrates and enforces "no session -> no data".
  app.get('/api/scanner/status', requireSession(ctx), (req: AuthedRequest, res) => {
    res.json({ authorized: true, userId: req.user!.id, accounts: req.user!.accounts });
  });

  /* ------------------------- vendored bot app -------------------------- */

  // The Deriv bot app is a separate React build served under /bot with its own
  // router and global styles. It is mounted ahead of the WickSentinel shell so
  // its SPA fallback claims only its own subtree.
  const botAppDir = cfg.botAppDir ?? path.resolve(process.cwd(), 'bot-app/out/bot');
  const botAppIndex = path.join(botAppDir, 'index.html');
  const hasBotApp = fs.existsSync(botAppIndex);

  if (hasBotApp) {
    app.use('/bot', express.static(botAppDir, { index: false, maxAge: '1h' }));
    // Compatibility for previously cached bot shells that requested lazy
    // chunks from /static instead of the current /bot/static asset prefix.
    app.use('/static', express.static(path.join(botAppDir, 'static'), { maxAge: '1h' }));
    app.get(/^\/bot(\/.*)?$/, (req, res, next) => {
      if (/\.[a-z0-9]+$/i.test(req.path)) return next();
      res.sendFile(botAppIndex);
    });
  } else {
    console.warn('[server] bot-app/out/bot not found — run `npm run build:bot` to serve /bot.');
  }

  /* --------------------------- static frontend -------------------------- */

  const distDir = path.resolve(process.cwd(), 'dist');
  const indexHtml = path.join(distDir, 'index.html');
  const hasDist = fs.existsSync(indexHtml);

  if (hasDist) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  } else {
    console.warn('[server] dist/ not found — run `npm run build` to serve the SPA. API routes still work.');
  }

  // SPA fallback: any non-API GET without a file extension renders the app
  // shell, which then calls /auth/session and redirects to /login when
  // unauthenticated. Asset-like paths (with an extension) are left to 404.
  app.get(/^\/(?!api\/|auth\/|healthz).*/, (req, res, next) => {
    if (!hasDist) return next();
    if (/\.[a-z0-9]+$/i.test(req.path)) return next();
    res.sendFile(indexHtml);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  /*
   * Terminal error handler. Express 4 does not catch a rejected promise from an
   * async handler: the rejection is unhandled and the request is left with no
   * response at all, so the socket eventually times out. From the browser that is
   * indistinguishable from an unreachable network, which is exactly how a
   * half-completed mutation gets reported as "network error" after it persisted.
   *
   * Answering here turns that hang into a real status the caller can act on. The
   * body is deliberately generic: an internal message can name a file path, a
   * record id or a store conflict, and this response reaches a browser.
   */
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error(`[server] Unhandled error on ${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'internal_error' });
  });

  return { app, cfg, store, telemetry, market, execution, cache: resolvedCache };
}

/**
 * Resolves intents stuck in UNKNOWN/RECONCILIATION_REQUIRED. It needs each
 * owner's Deriv token, which lives in a live session; an intent whose owner has
 * no active session is left for the operator (or the next login) to resolve.
 * Never retries a purchase.
 */
async function reconcileStuckIntents(
  cfg: ServerConfig,
  store: Store,
  execution: ExecutionBundle
): Promise<void> {
  const stuck = store
    .listUsers()
    .flatMap((user) => store.listTradeIntents(user.id).filter((i) => i.state === 'UNKNOWN' || i.state === 'RECONCILIATION_REQUIRED').map((i) => ({ user, intent: i })));
  if (stuck.length === 0) return;
  console.log(`[server] Reconciling ${stuck.length} stuck intent(s).`);
  for (const { user, intent } of stuck) {
    const session = store.listSessionsForUser(user.id).find((s) => !s.revoked && s.expiresAt > Date.now() && s.derivTokenExpiresAt > Date.now());
    if (!session) {
      console.warn(`[server] Intent ${intent.id} left stuck: owner has no active session.`);
      continue;
    }
    let token: string | null = null;
    try {
      token = open(session.derivTokenSealed, cfg.session.secret);
    } catch {
      token = null;
    }
    if (!token) continue;
    try {
      await execution.monitor.reconcile(user, intent.id, token);
    } catch (err) {
      console.warn(`[server] Could not reconcile intent ${intent.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Corrects legacy contracts frozen as `unknown` by an older build.
 *
 * A fast contract could expire with a real profit before Deriv reported its
 * final won/lost string; `ContractMonitor.settle` (pre-fix) stored that as
 * `unknown`, which reporting excludes from realised P/L. The profit is already
 * recorded, so the outcome is re-derived from it — no Deriv call, no purchase,
 * no ledger change (the settlement entry was already posted). Idempotent.
 */
async function reclassifyUnknownContracts(store: Store): Promise<void> {
  const principals = new Set<string>();
  for (const user of store.listUsers()) principals.add(user.id);
  for (const follower of store.listAllCopyTradingFollowers()) {
    principals.add(`copy_follower_${follower.id}`);
  }
  let fixed = 0;
  for (const principal of principals) {
    for (const contract of store.listContracts(principal)) {
      if (contract.status !== 'unknown') continue;
      const profit = contract.profit;
      if (typeof profit !== 'number' || !Number.isFinite(profit) || profit === 0) continue;
      const status: ContractStatus = profit > 0 ? 'won' : 'lost';
      await store.putContract({ ...contract, status, updatedAt: Date.now() });
      fixed += 1;
    }
  }
  if (fixed > 0) {
    console.log(`[server] Reclassified ${fixed} legacy unknown contract(s) to won/lost from their recorded profit.`);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir, { engine: cfg.storageEngine, connectionString: cfg.database?.url ?? undefined, ssl: cfg.database?.ssl });
  await store.load();
  console.log(`[server] Storage engine: ${store.storage.kind}`);
  await store.pruneExpiredSessions();
  await store.pruneAdminSessions();
  // Telemetry retention: drop old activity events and stale scanner rows so the
  // high-volume collections stay bounded.
  const prunedEvents = await store.pruneActivityEvents(cfg.telemetry.retentionDays);
  const prunedSessions = await store.pruneScannerSessions(cfg.telemetry.scannerSessionTtlSeconds * 1000);
  if (prunedEvents > 0 || prunedSessions > 0) {
    console.log(`[server] Telemetry retention: pruned ${prunedEvents} events, ${prunedSessions} scanner sessions.`);
  }

  // Build the shared cache before the app so market data and the scanner can use
  // it from their first request. Redis is opt-in; this falls back to memory.
  const cache = await createCache({
    url: cfg.redis?.url ?? null,
    keyPrefix: cfg.redis?.keyPrefix ?? 'wicksentinel:',
    ttlSeconds: cfg.redis?.ttlSeconds ?? 60
  });

  const { app, market, execution } = createApp(cfg, store, cache);
  console.log(`[server] Cache: ${cache.kind}`);

  // Reconcile any intent left UNKNOWN by a previous crash or lost response: ask
  // Deriv what actually happened rather than retrying a purchase. Best-effort —
  // a failure here leaves the intent visibly stuck for the operator, not hidden.
  void reconcileStuckIntents(cfg, store, execution).catch((err) => {
    console.warn(`[server] Reconciliation pass failed: ${err instanceof Error ? err.message : err}`);
  });

  // Correct any contract a pre-fix build froze as `unknown` despite a recorded
  // profit, so its P/L is realised in reporting. Best-effort and idempotent.
  void reclassifyUnknownContracts(store).catch((err) => {
    console.warn(`[server] Contract reclassification pass failed: ${err instanceof Error ? err.message : err}`);
  });

  // Open the shared public market-data connection. A failure here is not fatal:
  // the server still serves the app, and market data reconnects on demand.
  market.connect().catch((err) => {
    console.warn(`[server] Market data unavailable at boot: ${err instanceof Error ? err.message : err}`);
  });
  // Automatic trading is now driven by the dashboard's own best signal: the
  // client publishes the confirmed setup it is showing and the server trades it
  // for users in automatic mode. There is no headless scanner to start. With
  // automatic trading off (the default) a published signal is never executed.
  if (execution.flags.allowExecution && !execution.flags.allowAutomaticTrading) {
    console.log('[server] Automatic trading is OFF (set ALLOW_AUTOMATIC_TRADING=true to enable it).');
  }
  if (execution.flags.allowExecution) {
    console.log(
      `[server] Execution ENABLED (demo=${execution.flags.allowDemoExecution}, real=${execution.flags.allowRealExecution}).`
    );
  }

  const server = app.listen(cfg.port, () => {
    console.log(`[server] WickSentinel listening on :${cfg.port} (${cfg.isProduction ? 'production' : 'development'})`);
    console.log(`[server] Deriv redirect URI: ${cfg.deriv.redirectUri}`);
    if (!cfg.deriv.clientSecret) console.log('[server] Public PKCE client (no DERIV_CLIENT_SECRET set).');
  });

  // Release the data-directory lock on shutdown so a restart (or the bootstrap
  // command) is not blocked by a lock this process no longer needs.
  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, shutting down.`);
    market.close();
    execution.monitor.close();
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Only auto-start when executed directly (not when imported by tests).
const isDirectRun = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;
if (isDirectRun) {
  main().catch((err) => {
    console.error('[server] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

