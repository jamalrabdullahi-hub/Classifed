import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { env } from './env';

/**
 * All key material derives from APP_SECRET via HKDF with a distinct info label
 * per purpose, so a compromise of one derived key does not yield the others.
 */
function derivedKey(purpose: string, length = 32): Buffer {
  const secret = env().APP_SECRET;
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `fltcrypto:${purpose}`, length),
  );
}

// --- Field-level encryption -------------------------------------------------
// Used for PII that must be retrievable (KYC document numbers). Format:
//   v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
// The version prefix makes key rotation a migration rather than a rewrite.

const FIELD_VERSION = 'v1';

export function encryptField(plaintext: string): string {
  const key = derivedKey('field-encryption');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FIELD_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptField(encoded: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== FIELD_VERSION) {
    throw new Error('Malformed encrypted field');
  }
  const key = derivedKey('field-encryption');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3]!, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Deterministic, keyed fingerprint. Lets us look a value up or detect duplicates
 * without storing it in the clear. Not reversible.
 */
export function blindIndex(value: string): string {
  return createHmac('sha256', derivedKey('blind-index'))
    .update(value.trim().toLowerCase())
    .digest('hex');
}

// --- Password hashing -------------------------------------------------------
// scrypt from node:crypto. Chosen over argon2/bcrypt because it needs no native
// build step, which keeps `npm install` reliable across the team's machines.
// Format: scrypt$N$r$p$<salt-b64>$<hash-b64>

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return constantTimeEquals(actual, expected);
}

// --- Tokens and comparison --------------------------------------------------

export function hashToken(token: string): string {
  return createHmac('sha256', derivedKey('token-hash')).update(token).digest('hex');
}

export function constantTimeEquals(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which itself leaks length.
  // Compare fixed-width digests instead so the comparison is uniform.
  const digestA = createHmac('sha256', derivedKey('compare')).update(bufA).digest();
  const digestB = createHmac('sha256', derivedKey('compare')).update(bufB).digest();
  return timingSafeEqual(digestA, digestB);
}

/** Stable hash of a request body, for idempotency-key conflict detection. */
export function hashRequest(payload: unknown): string {
  return createHmac('sha256', derivedKey('request-hash'))
    .update(stableStringify(payload))
    .digest('hex');
}

/** JSON.stringify with sorted keys, so key order cannot change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Numeric confirmation code for withdrawal approval. */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= Math.floor(0xffffffff / max) * max); // reject to avoid modulo bias
  return String(value % max).padStart(digits, '0');
}
