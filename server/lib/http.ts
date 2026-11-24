import type { Request, Response } from 'express';

/**
 * Small HTTP helpers shared by the routes: cookie parsing/serialising with
 * HttpOnly + SameSite, JSON body reading, and constant-time-friendly error
 * shaping. Sessions are carried entirely in HttpOnly cookies — no token ever
 * reaches frontend JavaScript.
 */

export interface CookieOptions {
  maxAge?: number; // seconds
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}

export function setCookie(res: Response, name: string, value: string, opts: CookieOptions): void {
  const existing = res.getHeader('Set-Cookie');
  const cookie = serializeCookie(name, value, opts);
  const list = Array.isArray(existing) ? existing.concat(cookie) : existing ? [String(existing), cookie] : [cookie];
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res: Response, name: string, opts: CookieOptions = {}): void {
  setCookie(res, name, '', { ...opts, maxAge: 0 });
}

export function readJsonBody<T = unknown>(req: Request, limitBytes = 16 * 1024): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({} as T);
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Resolves the origin the browser is actually talking to.
 *
 * `appOrigin` is derived from the OAuth redirect URI, which is not necessarily
 * how the deployment is reached: a preview host, a partner domain, or a proxy
 * that rewrites `Host` all differ from it. When the request's own host matches
 * the Origin the browser sent, that origin is the correct base for redirects and
 * for same-origin checks. Otherwise the configured origin is used, so a
 * cross-site request can never steer a redirect.
 */
export function resolveRequestOrigin(req: Request, appOrigin: string): string {
  const origin = req.get('origin');
  if (typeof origin !== 'string' || origin === '') return appOrigin;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return appOrigin;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return appOrigin;

  const originHost = parsed.host.toLowerCase();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  const candidates = [req.get('host')?.toLowerCase(), forwardedHost];
  const matches = candidates.some(host => typeof host === 'string' && host !== '' && host === originHost);
  return matches ? parsed.origin : appOrigin;
}

/** Redirects a browser back to the SPA with an error code it can render. */
export function redirectWithError(res: Response, appOrigin: string, code: string): void {
  const url = new URL('/signin-error', appOrigin);
  url.searchParams.set('code', code);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

export { parseCookies as _parseCookies };
