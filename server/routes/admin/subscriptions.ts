import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';

/**
 * Subscriptions & revenue (`/api/admin/v1/subscriptions/*`).
 *
 * There is NO billing system in this deployment: no payment gateway, no plan
 * table, no invoices. Rather than invent records, every collection here is
 * empty and each response carries an explicit `unavailable` explanation so the
 * UI renders an honest empty state. Manual grant endpoints are therefore not
 * offered — a grant with no entitlement model would be meaningless.
 */

export function createSubscriptionsRouter(ctx: AdminRouteContext): Router {
  const router = Router();

  router.get('/', requireAdmin(ctx, 'subscriptions.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      unavailable: 'No subscription records exist. Connect a billing provider to populate this module.'
    });
  });

  router.get('/plans', requireAdmin(ctx, 'subscriptions.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ items: [], unavailable: 'No plan catalogue is configured.' });
  });

  router.get('/revenue', requireAdmin(ctx, 'revenue.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({
      currency: null,
      mrr: null,
      arr: null,
      series: [],
      unavailable: 'No payment gateway or billing records are configured, so revenue cannot be computed.'
    });
  });

  router.get('/payments', requireAdmin(ctx, 'payments.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ items: [], total: 0, unavailable: 'No payment history is available without a billing provider.' });
  });

  return router;
}
