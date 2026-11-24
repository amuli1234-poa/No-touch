import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { parsePagination, paginate } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';

/**
 * Bot Builder administration (`/api/admin/v1/bots/*`).
 *
 * Read-only operational visibility over the existing import + run records.
 * Nothing here executes, edits or deletes a bot: the execution gateway and its
 * demo-only safety architecture stay exactly as they are.
 *
 * The compatibility verdict shown is the one recorded at import time. This
 * module never upgrades a `partial` or `unsupported` bot to "supported" — the
 * platform must not claim support it does not have.
 */

export function createBotsRouter(ctx: AdminRouteContext): Router {
  const { store } = ctx;
  const router = Router();

  router.get('/summary', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    const bots = store.listAllImportedBots();
    const runs = store.listAllBotRuns();
    const byCompatibility = bots.reduce<Record<string, number>>((acc, b) => {
      acc[b.compatibility] = (acc[b.compatibility] ?? 0) + 1;
      return acc;
    }, {});
    return res.json({
      generatedAt: Date.now(),
      bots: {
        total: bots.length,
        imported: bots.filter((b) => b.status === 'imported').length,
        paused: bots.filter((b) => b.status === 'paused').length,
        archived: bots.filter((b) => b.status === 'archived').length,
        byCompatibility
      },
      runs: {
        total: runs.length,
        running: runs.filter((r) => r.runtimeStatus === 'running').length,
        failed: runs.filter((r) => r.runtimeStatus === 'failed').length,
        stopped: runs.filter((r) => r.runtimeStatus === 'stopped').length
      },
      /** The engine is demo-only by construction; state that, do not imply live. */
      safety: {
        accountMode: 'demo',
        note: 'Imported bot runs are demo-only. A run refuses a real account outright.'
      }
    });
  });

  router.get('/imports', requireAdmin(ctx, 'monitoring.read'), (req: AdminAuthedRequest, res: Response) => {
    const { page, pageSize } = parsePagination(req);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const compat = String(req.query.compatibility ?? '').trim();

    let bots = store.listAllImportedBots();
    if (q) {
      bots = bots.filter((b) => {
        if (b.name.toLowerCase().includes(q)) return true;
        if (b.originalFilename.toLowerCase().includes(q)) return true;
        return b.userId.toLowerCase().includes(q);
      });
    }
    if (compat) bots = bots.filter((b) => b.compatibility === compat);

    const pageData = paginate(bots, page, pageSize);
    return res.json({
      ...pageData,
      items: pageData.items.map((b) => ({
        id: b.id,
        userId: b.userId,
        name: b.name,
        originalFilename: b.originalFilename,
        compatibility: b.compatibility,
        compatibilityReason: b.compatibilityReason,
        status: b.status,
        /** The verdict as recorded; never re-derived into a rosier value. */
        warnings: b.warnings?.length ?? 0,
        unknownBlocks: b.bot?.unknownBlocks ?? [],
        revision: b.revision ?? 0,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt
      }))
    });
  });

  router.get('/runs', requireAdmin(ctx, 'monitoring.read'), (req: AdminAuthedRequest, res: Response) => {
    const { page, pageSize } = parsePagination(req);
    const status = String(req.query.status ?? '').trim();

    let runs = store.listAllBotRuns();
    if (status) runs = runs.filter((r) => r.runtimeStatus === status);

    const pageData = paginate(runs, page, pageSize);
    return res.json({
      ...pageData,
      items: pageData.items.map((r) => ({
        runId: r.runId,
        botId: r.botId,
        userId: r.userId,
        accountMode: r.accountMode,
        runtimeStatus: r.runtimeStatus,
        startedAt: r.startedAt,
        stoppedAt: r.stoppedAt,
        lastEvaluationAt: r.lastEvaluationAt,
        lastExecutionId: r.lastExecutionId
      }))
    });
  });

  return router;
}
