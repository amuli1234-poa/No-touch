import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AdminRouteContext } from './helpers.js';
import { parsePagination, paginate, fail, auditFromRequest } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import type { SupportTicketRecord, SupportTicketMessageRecord } from '../../admin/types.js';

/**
 * Support centre (`/api/admin/v1/support/*`).
 *
 * Tickets and internal notes live in the admin-only store. Internal notes
 * (`internal: true`) are only ever returned by these admin endpoints — no
 * user-facing route exposes them.
 */

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const STATUSES = ['open', 'in_progress', 'waiting_for_user', 'resolved', 'closed'] as const;

export function createSupportRouter(ctx: AdminRouteContext): Router {
  const { store } = ctx;
  const router = Router();

  router.get('/', requireAdmin(ctx, 'support.read'), (req: AdminAuthedRequest, res: Response) => {
    const { page, pageSize } = parsePagination(req);
    const status = String(req.query.status ?? '').trim();
    const priority = String(req.query.priority ?? '').trim();
    const q = String(req.query.q ?? '').trim().toLowerCase();

    let tickets = store.listTickets();
    if (status) tickets = tickets.filter((t) => t.status === status);
    if (priority) tickets = tickets.filter((t) => t.priority === priority);
    if (q) tickets = tickets.filter((t) => t.subject.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));

    const pageData = paginate(tickets, page, pageSize);
    return res.json(pageData);
  });

  router.post('/', requireAdmin(ctx, 'support.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const subject = String(req.body?.subject ?? '').trim().slice(0, 200);
    const description = String(req.body?.description ?? '').trim().slice(0, 4000);
    const priority = String(req.body?.priority ?? 'normal');
    const userId = req.body?.userId ? String(req.body.userId) : null;
    if (!subject) return fail(res, 400, 'subject_required');
    if (!PRIORITIES.includes(priority as any)) return fail(res, 400, 'invalid_priority');
    if (userId && !store.getUserById(userId)) return fail(res, 404, 'user_not_found');

    const now = Date.now();
    const ticket: SupportTicketRecord = {
      id: `TCK-${randomUUID().slice(0, 8).toUpperCase()}`,
      subject,
      description,
      priority: priority as SupportTicketRecord['priority'],
      status: 'open',
      userId,
      requesterRef: null,
      assignedAdminId: null,
      createdAt: now,
      updatedAt: now,
      createdByAdminId: req.admin!.id
    };
    await store.createTicket(ticket);

    await auditFromRequest(ctx, req, {
      action: 'support.ticket.created',
      targetType: 'ticket',
      targetId: ticket.id,
      newState: { subject, priority, userId }
    });
    return res.status(201).json({ ticket });
  });

  router.get('/:id', requireAdmin(ctx, 'support.read'), (req: AdminAuthedRequest, res: Response) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) return fail(res, 404, 'ticket_not_found');
    return res.json({
      ticket,
      messages: store.listTicketMessages(ticket.id),
      user: ticket.userId ? (() => {
        const u = store.getUserById(ticket.userId!);
        return u ? { id: u.id, loginId: u.loginId ?? null, createdAt: u.createdAt, suspended: Boolean(u.suspended) } : null;
      })() : null
    });
  });

  router.patch('/:id', requireAdmin(ctx, 'support.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) return fail(res, 404, 'ticket_not_found');

    const previous = { status: ticket.status, priority: ticket.priority, assignedAdminId: ticket.assignedAdminId };
    if (req.body?.status !== undefined) {
      if (!STATUSES.includes(String(req.body.status) as any)) return fail(res, 400, 'invalid_status');
      ticket.status = String(req.body.status) as SupportTicketRecord['status'];
    }
    if (req.body?.priority !== undefined) {
      if (!PRIORITIES.includes(String(req.body.priority) as any)) return fail(res, 400, 'invalid_priority');
      ticket.priority = String(req.body.priority) as SupportTicketRecord['priority'];
    }
    if (req.body?.assignedAdminId !== undefined) {
      const id = req.body.assignedAdminId === null ? null : String(req.body.assignedAdminId);
      if (id && !store.getAdminById(id)) return fail(res, 400, 'invalid_assignee');
      ticket.assignedAdminId = id;
    }
    await store.updateTicket(ticket);

    await auditFromRequest(ctx, req, {
      action: 'support.ticket.updated',
      targetType: 'ticket',
      targetId: ticket.id,
      previousState: previous,
      newState: { status: ticket.status, priority: ticket.priority, assignedAdminId: ticket.assignedAdminId }
    });
    return res.json({ ticket });
  });

  router.post('/:id/messages', requireAdmin(ctx, 'support.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const ticket = store.getTicket(req.params.id);
    if (!ticket) return fail(res, 404, 'ticket_not_found');
    const body = String(req.body?.body ?? '').trim().slice(0, 4000);
    const internal = Boolean(req.body?.internal);
    if (!body) return fail(res, 400, 'empty_message');

    const message: SupportTicketMessageRecord = {
      id: `msg_${randomUUID()}`,
      ticketId: ticket.id,
      internal,
      body,
      authorAdminId: req.admin!.id,
      authorKind: 'admin',
      createdAt: Date.now()
    };
    await store.addTicketMessage(message);
    await store.updateTicket(ticket); // bump updatedAt

    await auditFromRequest(ctx, req, {
      action: internal ? 'support.note.added' : 'support.reply.added',
      targetType: 'ticket',
      targetId: ticket.id,
      metadata: { messageId: message.id }
    });
    return res.status(201).json({ message });
  });

  return router;
}
