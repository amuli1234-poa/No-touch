import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AdminRouteContext } from './helpers.js';
import { fail, auditFromRequest } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import type { AnnouncementRecord } from '../../admin/types.js';

/**
 * Announcements (`/api/admin/v1/announcements/*`).
 *
 * Draft -> scheduled -> published -> archived lifecycle. Publishing records the
 * acting administrator and timestamp in both the record and the audit log.
 * There is no user-facing delivery channel wired up (no notification service
 * exists), so publishing records intent; the delivery gap is documented.
 */

const KINDS = ['platform', 'maintenance', 'feature', 'subscription'] as const;
const AUDIENCES = ['all', 'subscribers', 'free'] as const;
const STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;

export function createAnnouncementsRouter(ctx: AdminRouteContext): Router {
  const { store } = ctx;
  const router = Router();

  router.get('/', requireAdmin(ctx, 'announcements.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ items: store.listAnnouncements() });
  });

  router.post('/', requireAdmin(ctx, 'announcements.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const title = String(req.body?.title ?? '').trim().slice(0, 200);
    const body = String(req.body?.body ?? '').trim().slice(0, 8000);
    const kind = String(req.body?.kind ?? 'platform');
    const audience = String(req.body?.audience ?? 'all');
    if (!title) return fail(res, 400, 'title_required');
    if (!KINDS.includes(kind as any)) return fail(res, 400, 'invalid_kind');
    if (!AUDIENCES.includes(audience as any)) return fail(res, 400, 'invalid_audience');

    const now = Date.now();
    const announcement: AnnouncementRecord = {
      id: `ann_${randomUUID()}`,
      title,
      body,
      kind: kind as AnnouncementRecord['kind'],
      audience: audience as AnnouncementRecord['audience'],
      status: 'draft',
      publishAt: null,
      publishedAt: null,
      publishedBy: null,
      createdBy: req.admin!.id,
      createdAt: now,
      updatedAt: now
    };
    await store.upsertAnnouncement(announcement);
    await auditFromRequest(ctx, req, {
      action: 'announcement.created',
      targetType: 'announcement',
      targetId: announcement.id,
      newState: { title, kind, audience }
    });
    return res.status(201).json({ announcement });
  });

  router.patch('/:id', requireAdmin(ctx, 'announcements.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const announcement = store.getAnnouncement(req.params.id);
    if (!announcement) return fail(res, 404, 'announcement_not_found');

    const previous = { status: announcement.status, title: announcement.title, body: announcement.body, audience: announcement.audience, publishAt: announcement.publishAt };

    if (req.body?.title !== undefined) announcement.title = String(req.body.title).trim().slice(0, 200);
    if (req.body?.body !== undefined) announcement.body = String(req.body.body).trim().slice(0, 8000);
    if (req.body?.audience !== undefined) {
      if (!AUDIENCES.includes(String(req.body.audience) as any)) return fail(res, 400, 'invalid_audience');
      announcement.audience = String(req.body.audience) as AnnouncementRecord['audience'];
    }
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!STATUSES.includes(status as any)) return fail(res, 400, 'invalid_status');
      announcement.status = status as AnnouncementRecord['status'];
    }
    if (req.body?.publishAt !== undefined) {
      const at = req.body.publishAt === null ? null : Date.parse(String(req.body.publishAt));
      if (at !== null && !Number.isFinite(at)) return fail(res, 400, 'invalid_publish_at');
      announcement.publishAt = at;
    }
    if (announcement.status === 'published' && announcement.publishedAt === null) {
      announcement.publishedAt = Date.now();
      announcement.publishedBy = req.admin!.id;
    }
    await store.upsertAnnouncement(announcement);

    await auditFromRequest(ctx, req, {
      action: 'announcement.updated',
      targetType: 'announcement',
      targetId: announcement.id,
      previousState: previous,
      newState: { status: announcement.status, title: announcement.title, body: announcement.body, audience: announcement.audience, publishAt: announcement.publishAt }
    });
    return res.json({ announcement });
  });

  router.post('/:id/publish', requireAdmin(ctx, 'announcements.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const announcement = store.getAnnouncement(req.params.id);
    if (!announcement) return fail(res, 404, 'announcement_not_found');
    const previous = { status: announcement.status, publishedAt: announcement.publishedAt };
    announcement.status = 'published';
    announcement.publishedAt = Date.now();
    announcement.publishedBy = req.admin!.id;
    await store.upsertAnnouncement(announcement);

    await auditFromRequest(ctx, req, {
      action: 'announcement.published',
      targetType: 'announcement',
      targetId: announcement.id,
      previousState: previous,
      newState: { status: 'published', publishedAt: announcement.publishedAt }
    });
    return res.json({ announcement });
  });

  router.post('/:id/archive', requireAdmin(ctx, 'announcements.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const announcement = store.getAnnouncement(req.params.id);
    if (!announcement) return fail(res, 404, 'announcement_not_found');
    const previous = { status: announcement.status };
    announcement.status = 'archived';
    await store.upsertAnnouncement(announcement);
    await auditFromRequest(ctx, req, {
      action: 'announcement.archived',
      targetType: 'announcement',
      targetId: announcement.id,
      previousState: previous,
      newState: { status: 'archived' }
    });
    return res.json({ announcement });
  });

  return router;
}
