import type { Request, Response } from 'express';
import type { Store } from '../../store/store.js';
import type { ServerConfig } from '../../config.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import { writeAudit, type AuditInput } from '../../services/admin/audit.js';
import type { Telemetry } from '../../services/admin/telemetry.js';
import type { BalanceService } from '../../services/balance.js';

/** Shared context handed to every admin route module. */
export interface AdminRouteContext {
  cfg: ServerConfig;
  store: Store;
  telemetry: Telemetry;
  /**
   * Present when the app wires balance reads. Optional so a route module can be
   * mounted without Deriv connectivity; a missing service is reported as an
   * unavailable balance rather than guessed at.
   */
  balances?: BalanceService;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function parsePagination(req: Request, defaultSize = 25): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const rawSize = parseInt(String(req.query.pageSize ?? defaultSize), 10) || defaultSize;
  const pageSize = Math.min(100, Math.max(1, rawSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page, pageSize, totalPages };
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

/** Writes an audit record attributed to the acting administrator. */
export async function auditFromRequest(
  ctx: AdminRouteContext,
  req: AdminAuthedRequest,
  input: Omit<AuditInput, 'actorAdminId' | 'actorEmail' | 'sourceIp'>
): Promise<void> {
  await writeAudit(ctx.store, {
    ...input,
    actorAdminId: req.admin?.id ?? null,
    actorEmail: req.admin?.email ?? null,
    sourceIp: clientIp(req)
  });
}

/** Structured JSON error with a machine-readable code. */
export function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error, ...extra });
}
