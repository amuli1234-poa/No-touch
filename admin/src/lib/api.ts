/**
 * Typed client for the WickSentinel Admin API (`/api/admin/v1`).
 *
 * Credentials are sent as HttpOnly cookies (never readable by JS). The
 * double-submit CSRF token is held in memory only and echoed in the
 * `X-CSRF-Token` header on every state-changing request, as the server
 * requires. On any 401 the session is cleared and the app returns to login.
 */

const BASE = '/api/admin/v1';

export interface AdminIdentity {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  extraPermissions: string[];
  permissions: string[];
  mfaEnrolled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

/**
 * A request whose outcome could not be established.
 *
 * `network_error` means the browser never got a response. That is genuinely
 * ambiguous for a mutation: the server may have committed the write and then
 * failed to answer (a crash, a proxy reset, a dropped connection). Callers must
 * not report it as "the change did not happen" — see `CopyControlSwitch`.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: Record<string, unknown>
  ) {
    super(code);
  }
}

/** True when the request may or may not have been applied by the server. */
export function isOutcomeUnknown(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status >= 500);
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'network_error', { message: 'Cannot reach the server.' });
  }

  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, 'unauthorized');
  }

  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, payload?.error ?? `http_${res.status}`, payload ?? undefined);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path)
};

/** Builds a query string, omitting empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
