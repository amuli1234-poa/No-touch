import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { createAdminAuthRouter } from './auth.js';
import { createDashboardRouter } from './dashboard.js';
import { createUsersRouter } from './users.js';
import { createAdministratorsRouter } from './administrators.js';
import { createSubscriptionsRouter } from './subscriptions.js';
import { createAnalyticsRouter } from './analytics.js';
import { createMonitoringRouter } from './monitoring.js';
import { createAuditRouter } from './audit.js';
import { createSupportRouter } from './support.js';
import { createAnnouncementsRouter } from './announcements.js';
import { createConfigurationRouter } from './configuration.js';
import { createCopyTradingAdminRouter } from './copyTrading.js';
import { createBotsRouter } from './bots.js';

/**
 * Admin API v1 — mounted at `/api/admin/v1`.
 *
 * The namespace is deliberately separate from the trader API so the two
 * surfaces can never be confused, and every sub-router enforces its own
 * permission checks.
 */

export function createAdminApiRouter(ctx: AdminRouteContext): Router {
  const router = Router();

  router.use('/auth', createAdminAuthRouter(ctx));
  router.use('/dashboard', createDashboardRouter(ctx));
  router.use('/users', createUsersRouter(ctx));
  router.use('/administrators', createAdministratorsRouter(ctx));
  router.use('/subscriptions', createSubscriptionsRouter(ctx));
  router.use('/analytics', createAnalyticsRouter(ctx));
  router.use('/monitoring', createMonitoringRouter(ctx));
  router.use('/audit', createAuditRouter(ctx));
  router.use('/support', createSupportRouter(ctx));
  router.use('/announcements', createAnnouncementsRouter(ctx));
  router.use('/configuration', createConfigurationRouter(ctx));
  router.use('/copy-trading', createCopyTradingAdminRouter(ctx));
  router.use('/bots', createBotsRouter(ctx));

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'admin_route_not_found' });
  });

  return router;
}

/**
 * Credentialed CORS for the admin surface.
 *
 * Only the explicit allowlist from `ADMIN_ALLOWED_ORIGINS` is echoed back, and
 * `Access-Control-Allow-Credentials` is set only for those origins. A wildcard
 * is never used with credentials.
 */
export function adminCors(ctx: AdminRouteContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const allowed = ctx.cfg.admin.allowedOrigins;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
