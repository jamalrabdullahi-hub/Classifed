import { randomBytes, randomUUID } from 'node:crypto';

/**
 * UUIDv7 — time-ordered, so primary keys cluster by insertion time and history
 * reads in chronological order without a secondary sort.
 *
 * Layout: 48-bit big-endian unix ms | version 7 | 12 random bits | variant |
 * 62 random bits.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export const newId = uuidv7;

/**
 * Opaque, URL-safe random token: session tokens, email tokens, SIWE nonces.
 *
 * 32 bytes of CSPRNG output. These are secrets — store only their hash.
 */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * A short, human-transcribable code for MFA recovery. Avoids characters that
 * are ambiguous when read aloud or written down (0/O, 1/I/L).
 */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function recoveryCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length];
    if (i === 4) out += '-';
  }
  return out;
}

export function newUuid4(): string {
  return randomUUID();
}
