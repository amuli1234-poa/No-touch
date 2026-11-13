import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { parsePagination, paginate } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';

/**
 * Audit centre (`/api/admin/v1/audit/*`).
 *
 * Read-only. The append-only log has no update or delete endpoint — records can
 * only be created, and only by the server.
 */

export function createAuditRouter(ctx: AdminRouteContext): Router {
  const { store } = ctx;
  const router = Router();

  router.get('/', requireAdmin(ctx, 'audit.read'), (req: AdminAuthedRequest, res: Response) => {
    const { page, pageSize } = parsePagination(req, 50);
    const actor = String(req.query.actor ?? '').trim().toLowerCase();
    const action = String(req.query.action ?? '').trim().toLowerCase();
    const targetType = String(req.query.targetType ?? '').trim().toLowerCase();
    const targetId = String(req.query.targetId ?? '').trim();
    const from = req.query.from ? Date.parse(String(req.query.from)) : null;
    const to = req.query.to ? Date.parse(String(req.query.to)) : null;

    let logs = store.listAudit();
    if (actor) logs = logs.filter((l) => (l.actorEmail ?? '').toLowerCase().includes(actor) || (l.actorAdminId ?? '').toLowerCase().includes(actor));
    if (action) logs = logs.filter((l) => l.action.toLowerCase().includes(action));
    if (targetType) logs = logs.filter((l) => (l.targetType ?? '').toLowerCase() === targetType);
    if (targetId) logs = logs.filter((l) => (l.targetId ?? '') === targetId);
    if (from && Number.isFinite(from)) logs = logs.filter((l) => l.timestamp >= from);
    if (to && Number.isFinite(to)) logs = logs.filter((l) => l.timestamp <= to);

    logs = logs.slice().reverse(); // newest first
    const pageData = paginate(logs, page, pageSize);
    return res.json(pageData);
  });

  return router;
}
