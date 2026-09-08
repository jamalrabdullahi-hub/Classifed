import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeAll } from 'vitest';

describe('agent key encryption', () => {
  beforeAll(() => {
    process.env.DATABASE_URL ??= 'postgresql://unused';
    process.env.APP_SECRET ??= randomBytes(48).toString('base64');
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    process.env.AGENT_KEY_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex, test-only
  });

  it('round-trips a generated key through encrypt/decrypt', async () => {
    const { generateAgentKeypair, encryptPrivateKey, decryptPrivateKey } = await import(
      '../src/security/agent-keys'
    );

    const { privateKey, address } = generateAgentKeypair();
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const encrypted = encryptPrivateKey(privateKey);
    expect(encrypted.ciphertext).not.toContain(privateKey.slice(2));

    const decrypted = decryptPrivateKey(encrypted);
    expect(decrypted).toBe(privateKey);
  });

  it('fails loudly on a tampered ciphertext rather than decrypting garbage', async () => {
    const { generateAgentKeypair, encryptPrivateKey, decryptPrivateKey } = await import(
      '../src/security/agent-keys'
    );

    const { privateKey } = generateAgentKeypair();
    const encrypted = encryptPrivateKey(privateKey);

    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from('tampered-not-the-real-ciphertext').toString('base64'),
    };

    expect(() => decryptPrivateKey(tampered)).toThrow();
  });

  it('two encryptions of the same key never produce the same ciphertext', async () => {
    const { generateAgentKeypair, encryptPrivateKey } = await import('../src/security/agent-keys');
    const { privateKey } = generateAgentKeypair();

    const a = encryptPrivateKey(privateKey);
    const b = encryptPrivateKey(privateKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });
});
