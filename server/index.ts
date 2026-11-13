import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, type ServerConfig } from './config.js';
import { Store } from './store/store.js';
import { createAuthRouter } from './routes/auth.js';
import { createWhatsAppRouter } from './routes/whatsapp.js';
import { createAdminApiRouter, adminCors } from './routes/admin/index.js';
import { Telemetry, telemetryMiddleware } from './services/admin/telemetry.js';
import { attachSession, requireSession, type SessionContext, type AuthedRequest } from './lib/session.js';

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
}

/** Builds the Express app. Exported separately so tests can drive it directly. */
export function createApp(cfg: ServerConfig, store: Store): AppBundle {
  const ctx: SessionContext = { cfg, store };
  const telemetry = new Telemetry();
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

  app.use(createAuthRouter(ctx));

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

  return { app, cfg, store, telemetry };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir);
  await store.load();
  await store.pruneExpiredSessions();
  await store.pruneAdminSessions();

  const { app } = createApp(cfg, store);

  app.listen(cfg.port, () => {
    console.log(`[server] WickSentinel listening on :${cfg.port} (${cfg.isProduction ? 'production' : 'development'})`);
    console.log(`[server] Deriv redirect URI: ${cfg.deriv.redirectUri}`);
    if (!cfg.deriv.clientSecret) console.log('[server] Public PKCE client (no DERIV_CLIENT_SECRET set).');
  });
}

// Only auto-start when executed directly (not when imported by tests).
const isDirectRun = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isDirectRun) {
  main().catch((err) => {
    console.error('[server] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

