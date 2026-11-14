import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, type ServerConfig } from './config.js';
import { Store } from './store/store.js';
import { createAuthRouter } from './routes/auth.js';
import { createWhatsAppRouter } from './routes/whatsapp.js';
import { createTelemetryRouter } from './routes/telemetry.js';
import { createBalancesRouter } from './routes/balances.js';
import { createExecutionRouter } from './routes/execution.js';
import { BalanceService } from './services/balance.js';
import { MarketDataService } from './services/marketData.js';
import { createExecution, type ExecutionBundle } from './execution/composition.js';
import { createAdminApiRouter, adminCors } from './routes/admin/index.js';
import { Telemetry, telemetryMiddleware } from './services/admin/telemetry.js';
import { attachSession, requireSession, type SessionContext, type AuthedRequest } from './lib/session.js';
import { open } from './lib/crypto.js';

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
}

/** Builds the Express app. Exported separately so tests can drive it directly. */
export function createApp(cfg: ServerConfig, store: Store): AppBundle {
  const ctx: SessionContext = { cfg, store };
  const telemetry = new Telemetry();
  // One balance service per process so the auth router and the balance router
  // share the same cache and invalidation (reauthorization clears it).
  const balances = new BalanceService(cfg);
  // Server-side market data on the public options gateway, plus the execution
  // layer. Kill switches default off, so nothing trades until explicitly enabled.
  const market = new MarketDataService(cfg);
  const execution = createExecution(cfg, store);
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
  app.use('/api/admin/v1', createAdminApiRouter({ cfg, store, telemetry }));

  app.use(attachSession(ctx));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(createAuthRouter(ctx, balances));

  // Client telemetry ingest. Needs a JSON body parser, scoped to its own
  // namespace so it never widens the surface of any other route.
  app.use('/api/telemetry', express.json({ limit: '32kb' }));
  app.use(createTelemetryRouter(ctx));
  app.use(createBalancesRouter(ctx, balances));
  app.use(
    createExecutionRouter({
      cfg,
      store,
      gateway: execution.gateway,
      market,
      runner: execution.runner,
      monitor: execution.monitor
    })
  );

  // WhatsApp alert dispatch. Status is public (masked); sending requires a session.
  app.use(createWhatsAppRouter());

  // Protected example scanner API surface. The scanner itself is client-side,
  // so this guard demonstrates and enforces "no session -> no data".
  app.get('/api/scanner/status', requireSession(ctx), (req: AuthedRequest, res) => {
    res.json({ authorized: true, userId: req.user!.id, accounts: req.user!.accounts });
  });

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

  return { app, cfg, store, telemetry, market, execution };
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir, { engine: cfg.storageEngine });
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

  const { app, market, execution } = createApp(cfg, store);

  // Reconcile any intent left UNKNOWN by a previous crash or lost response: ask
  // Deriv what actually happened rather than retrying a purchase. Best-effort —
  // a failure here leaves the intent visibly stuck for the operator, not hidden.
  void reconcileStuckIntents(cfg, store, execution).catch((err) => {
    console.warn(`[server] Reconciliation pass failed: ${err instanceof Error ? err.message : err}`);
  });

  // Open the shared public market-data connection. A failure here is not fatal:
  // the server still serves the app, and market data reconnects on demand.
  market.connect().catch((err) => {
    console.warn(`[server] Market data unavailable at boot: ${err instanceof Error ? err.message : err}`);
  });
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
const isDirectRun = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isDirectRun) {
  main().catch((err) => {
    console.error('[server] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

