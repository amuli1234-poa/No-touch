import { randomUUID } from 'node:crypto';
import type { Store } from '../../store/store.js';
import type { AuditRecord } from '../../admin/types.js';

/**
 * Append-only administrative audit log.
 *
 * Records are written once and never updated or deleted by the application.
 * `redact()` strips anything that looks like a secret before persistence, so
 * passwords, tokens, OAuth codes and session cookies can never enter the log
 * even if a caller passes them by mistake.
 */

const SECRET_KEY_PATTERN = /pass|secret|token|cookie|authorization|code|otp|mfa|hash|credential/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditInput {
  actorAdminId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  previousState?: unknown;
  newState?: unknown;
  reason?: string | null;
  correlationId?: string;
  sourceIp?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(store: Store, input: AuditInput): Promise<AuditRecord> {
  const record: AuditRecord = {
    id: `aud_${randomUUID()}`,
    timestamp: Date.now(),
    actorAdminId: input.actorAdminId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    previousState: redact(input.previousState ?? null),
    newState: redact(input.newState ?? null),
    reason: input.reason ?? null,
    correlationId: input.correlationId ?? randomUUID(),
    sourceIp: input.sourceIp ?? null,
    metadata: (redact(input.metadata ?? {}) as Record<string, unknown>) ?? {}
  };
  await store.appendAudit(record);
  return record;
}
