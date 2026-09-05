import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Cryptographic primitives.
 *
 * The environment has to be set before importing, because the module reads
 * ENCRYPTION_KEY through the validated config on first use.
 */
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

const { calldataHash, decryptSecret, deviceFingerprint, encryptSecret, hashRequest, hashToken, safeEqual } =
  await import('../src/services/crypto/hashing');

describe('token hashing', () => {
  it('is stable and one-way', () => {
    const token = 'a-session-token';
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('produces different hashes for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('constant-time comparison', () => {
  it('matches equal strings and rejects others', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    // Different lengths must not throw — timingSafeEqual does.
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('request hashing', () => {
  it('ignores key order, so an idempotency replay is not a false conflict', () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    expect(hashRequest({ x: { a: 1, b: 2 } })).toBe(hashRequest({ x: { b: 2, a: 1 } }));
  });

  it('distinguishes different bodies', () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    // Array order is meaningful, unlike object key order.
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
  });

  it('treats an absent key and an undefined value as the same', () => {
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }));
  });
});

describe('secret encryption', () => {
  it('round-trips', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('produces different ciphertext each time, so the IV is not reused', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it('refuses tampered ciphertext rather than returning garbage', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP');
    const bytes = Buffer.from(encrypted, 'base64');
    // Flip a bit in the ciphertext body. GCM authenticates on decrypt.
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    expect(() => decryptSecret(bytes.toString('base64'))).toThrow();
  });

  it('refuses a payload too short to contain an IV and tag', () => {
    expect(() => decryptSecret(Buffer.from('short').toString('base64'))).toThrow();
  });
});

describe('device fingerprinting', () => {
  it('is stable for the same device and different across devices', () => {
    expect(deviceFingerprint('Mozilla/5.0', 'cookie-a')).toBe(
      deviceFingerprint('Mozilla/5.0', 'cookie-a'),
    );
    expect(deviceFingerprint('Mozilla/5.0', 'cookie-a')).not.toBe(
      deviceFingerprint('Mozilla/5.0', 'cookie-b'),
    );
  });

  it('does not embed the user agent in the clear', () => {
    expect(deviceFingerprint('Mozilla/5.0', 'c')).not.toContain('Mozilla');
  });

  it('handles a missing user agent or cookie', () => {
    expect(deviceFingerprint(null, null)).toHaveLength(64);
  });
});

describe('calldata hashing', () => {
  const to = '0x0000000000000000000000000000000000001234';
  const data = '0xDEADBEEF';

  it('is case-insensitive, since wallets format hex differently', () => {
    // A mismatch here would flag an honest transaction as tampered.
    expect(calldataHash(to.toUpperCase(), data.toLowerCase(), '0')).toBe(
      calldataHash(to.toLowerCase(), data.toUpperCase(), '0'),
    );
  });

  it('changes when any component changes', () => {
    const base = calldataHash(to, data, '0');
    expect(calldataHash(to, data, '1')).not.toBe(base);
    expect(calldataHash(to, '0xdeadbeee', '0')).not.toBe(base);
    expect(calldataHash('0x0000000000000000000000000000000000005678', data, '0')).not.toBe(base);
  });
});
