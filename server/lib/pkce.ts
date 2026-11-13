import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636) and OAuth state helpers, per Deriv's documented flow:
 * code_challenge = BASE64URL(SHA256(code_verifier)); code_challenge_method=S256.
 *
 * Every value is generated with a CSPRNG and used exactly once.
 */

const UNRESERVED =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** RFC 7636: 43–128 unreserved characters. */
export function createCodeVerifier(length = 64): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += UNRESERVED[bytes[i] % UNRESERVED.length];
  }
  return out;
}

export function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** Opaque, high-entropy state used for CSRF protection and replay rejection. */
export function createState(): string {
  return base64url(randomBytes(32));
}

/** Opaque random id used as a server-side key (OAuth transaction, session id). */
export function createOpaqueId(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** Timing-safe string comparison for state / id equality checks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}
