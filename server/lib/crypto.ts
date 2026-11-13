import { createCipheriv, createDecipheriv, createHmac, randomBytes, hkdfSync } from 'node:crypto';

/**
 * Symmetric helpers for server-side secrets:
 *  - `sign` / `verify` protect the opaque session cookie value (HMAC-SHA256).
 *  - `seal` / `open` encrypt the Deriv access token at rest (AES-256-GCM), so a
 *    database read does not directly reveal a bearer token.
 *
 * The key material is derived from SESSION_SECRET; only this process holds it.
 */

function deriveKey(secret: string, info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from('wicksentinel'), Buffer.from(info), length));
}

export function sign(value: string, secret: string, context = 'cookie-sign'): string {
  const mac = createHmac('sha256', deriveKey(secret, context)).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function verifySigned(token: string, secret: string, context = 'cookie-sign'): string | null {
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;
  const value = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = createHmac('sha256', deriveKey(secret, context)).update(value).digest('base64url');
  if (mac.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? value : null;
}

export function seal(plaintext: string, secret: string): string {
  const key = deriveKey(secret, 'token-seal');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function open(sealed: string, secret: string): string | null {
  try {
    const key = deriveKey(secret, 'token-seal');
    const buf = Buffer.from(sealed, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
