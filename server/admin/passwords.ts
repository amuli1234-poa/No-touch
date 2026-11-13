import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * Password hashing with scrypt (Node built-in — no native dependency).
 *
 * Format: `scrypt$N$r$p$<saltB64url>$<hashB64url>`. Parameters are stored with
 * each hash so they can be raised later without invalidating existing records.
 * Verification is constant-time.
 */

const N = 16384; // 2^14 — ~16 MB working set, comfortably interactive.
const r = 8;
const p = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = parseInt(parts[1], 10);
  const rr = parseInt(parts[2], 10);
  const pp = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (!Number.isFinite(n) || !Number.isFinite(rr) || !Number.isFinite(pp)) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, { N: n, r: rr, p: pp, maxmem: MAXMEM });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Minimum password policy for administrator accounts. */
export function validatePasswordStrength(password: string): { ok: boolean; reason?: string } {
  if (typeof password !== 'string' || password.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters.' };
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return { ok: false, reason: 'Password must include upper and lower case letters.' };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, reason: 'Password must include a number.' };
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { ok: false, reason: 'Password must include a symbol.' };
  }
  return { ok: true };
}
