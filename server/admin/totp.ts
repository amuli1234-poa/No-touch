import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30-second step) — implemented with Node
 * built-ins so mandatory admin MFA needs no third-party dependency. Compatible
 * with Google Authenticator, Authy, 1Password and similar authenticator apps.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD = 30;

/** Generates a 160-bit base32 secret (20 bytes, per RFC 4226 recommendation). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Current TOTP code for a secret (used by tests and the bootstrap helper). */
export function currentTotp(secret: string, atMs = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / PERIOD));
}

/**
 * Verifies a submitted code, allowing +/- 1 time step for clock drift.
 * Comparison is constant-time.
 */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
  const submitted = code.trim();
  const key = base32Decode(secret);
  const step = Math.floor(atMs / 1000 / PERIOD);
  for (let drift = -1; drift <= 1; drift++) {
    const expected = hotp(key, step + drift);
    if (expected.length === submitted.length && timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) {
      return true;
    }
  }
  return false;
}

/** otpauth:// URI for authenticator-app enrolment (QR code payload). */
export function totpUri(secret: string, email: string, issuer = 'WickSentinel Admin'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Generates human-friendly recovery codes; only their hashes are stored. */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function hashCode(code: string): string {
  return createHmac('sha256', 'wicksentinel-recovery').update(code).digest('base64url');
}
