import { randomUUID } from 'node:crypto';

import type { Store } from '../store/store.js';
import type { ExecutionAuditRecord } from './types.js';

/**
 * Execution audit trail.
 *
 * Every execution-relevant action — allowed, denied or errored — is recorded.
 * A refusal is as important as a success: without it there is no evidence that
 * a control actually fired. The log is append-only.
 *
 * Redaction is mandatory. Credentials, tokens and anything named like a secret
 * are stripped before a detail object is written, so the audit can never become
 * a place a token leaks. This mirrors the admin audit contract.
 */

const SENSITIVE_KEY = /(token|secret|password|authorization|otp|cookie|bearer|apikey|api_key|client_secret)/i;
const REDACTED = '[redacted]';

/**
 * Deep-copies `value`, replacing any sensitive key's value with a marker and
 * truncating long strings so the audit cannot bloat.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface AuditInput {
  userId: string | null;
  action: string;
  outcome: 'allowed' | 'denied' | 'error';
  accountId?: string | null;
  intentId?: string | null;
  detail?: Record<string, unknown>;
}

export class ExecutionAuditor {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, options: { now?: () => number } = {}) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
  }

  /** Records an audit entry with its detail redacted. */
  async record(input: AuditInput): Promise<ExecutionAuditRecord> {
    const entry: ExecutionAuditRecord = {
      id: `aud_${randomUUID()}`,
      timestamp: this.now(),
      userId: input.userId,
      action: input.action,
      outcome: input.outcome,
      accountId: input.accountId ?? null,
      intentId: input.intentId ?? null,
      detail: (redact(input.detail ?? {}) as Record<string, unknown>) ?? {}
    };
    await this.store.appendExecutionAudit(entry);
    return entry;
  }

  list(): ExecutionAuditRecord[] {
    return this.store.listExecutionAudit();
  }
}
