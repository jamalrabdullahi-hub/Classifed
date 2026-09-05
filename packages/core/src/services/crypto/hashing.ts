import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@flt/config';

/**
 * Hashing and symmetric encryption.
 *
 * Pure Node built-ins, deliberately free of native dependencies so the modules
 * on the hot path — session resolution on every request — carry no compiled
 * binary into the bundle. Password hashing lives in `./passwords`.
 *
 * The distinction that matters: **passwords are slow-hashed, tokens are
 * fast-hashed.** A password is low-entropy and needs Argon2id to make guessing
 * expensive. A session token is 256 bits of CSPRNG output, so SHA-256 is
 * sufficient and its speed is a feature.
 */

/**
 * Hash for a high-entropy secret: session tokens, email tokens, recovery codes.
 *
 * The plaintext exists only in the user's cookie or inbox. We store the hash,
 * so a database read cannot impersonate anyone.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison, for anything an attacker could probe by timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Stable hash of a request body, for idempotency-key conflict detection. */
export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted at every level, so two structurally
 * identical bodies hash identically regardless of key order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

  return `{${entries.join(',')}}`;
}

/**
 * AES-256-GCM, for MFA secrets at rest.
 *
 * A TOTP secret cannot be hashed — we need it back to verify a code — so it is
 * encrypted with a key held outside the database. A dump of the database alone
 * then yields no working second factors.
 *
 * Format: base64(iv | authTag | ciphertext). The IV is random per encryption,
 * which is what makes GCM safe to reuse a key with.
 */
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encryptionKey(): Buffer {
  const key = Buffer.from(env().ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext is too short to be valid');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  // GCM authenticates on final(); a tampered ciphertext throws rather than
  // returning garbage.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * A stable, non-identifying device fingerprint.
 *
 * Salted with APP_SECRET so the stored value is not a plain hash of the user
 * agent and cannot be correlated across deployments.
 */
export function deviceFingerprint(userAgent: string | null, deviceCookie: string | null): string {
  return createHash('sha256')
    .update(env().APP_SECRET)
    .update('|device|')
    .update(userAgent ?? 'unknown')
    .update('|')
    .update(deviceCookie ?? 'none')
    .digest('hex');
}

/** SHA-256 over the fields of a transaction that must not change. */
export function calldataHash(to: string, data: string, value: string): string {
  return createHash('sha256')
    .update(to.toLowerCase())
    .update('|')
    .update(data.toLowerCase())
    .update('|')
    .update(value)
    .digest('hex');
}
