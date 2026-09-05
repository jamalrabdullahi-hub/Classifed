import { describe, expect, it } from 'vitest';
import { AuditAction, redact } from '../src/services/audit';

/**
 * Audit redaction.
 *
 * The backstop that keeps secrets out of the audit trail. It is a denylist,
 * which is the weaker design, so these tests exist to make the coverage
 * explicit and to catch a regression in the traversal — a secret nested inside
 * an array inside an object is exactly the case a naive implementation misses.
 */

describe('redaction', () => {
  it('redacts at the top level', () => {
    expect(redact({ email: 'a@b.com', password: 'hunter2' })).toEqual({
      email: 'a@b.com',
      password: '[redacted]',
    });
  });

  it('redacts regardless of key casing', () => {
    expect(redact({ PasswordHash: 'x', TOKEN: 'y', apiKey: 'z' })).toEqual({
      PasswordHash: '[redacted]',
      TOKEN: '[redacted]',
      apiKey: '[redacted]',
    });
  });

  it('redacts inside nested objects and arrays', () => {
    const result = redact({
      user: { profile: { secret: 'x' } },
      items: [{ token: 'a' }, { token: 'b' }],
    }) as Record<string, unknown>;

    expect((result.user as never)['profile']['secret']).toBe('[redacted]');
    expect((result.items as { token: string }[])[0]!.token).toBe('[redacted]');
    expect((result.items as { token: string }[])[1]!.token).toBe('[redacted]');
  });

  it('covers the wallet secrets this product must never record', () => {
    const result = redact({
      seedPhrase: 'a b c',
      mnemonic: 'd e f',
      privateKey: '0xabc',
      signature: '0xdef',
    }) as Record<string, string>;

    for (const value of Object.values(result)) {
      expect(value).toBe('[redacted]');
    }
  });

  it('leaves ordinary values alone', () => {
    expect(redact({ amount: '100', symbol: 'USDC', count: 3, ok: true })).toEqual({
      amount: '100',
      symbol: 'USDC',
      count: 3,
      ok: true,
    });
  });

  it('passes through primitives and null', () => {
    expect(redact(null)).toBeNull();
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(undefined)).toBeUndefined();
  });

  it('serializes dates rather than emitting an empty object', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(redact({ at: date })).toEqual({ at: '2026-01-01T00:00:00.000Z' });
  });

  it('stops at a depth limit rather than recursing forever', () => {
    // A cyclic structure must not hang the audit write.
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});

describe('action names', () => {
  it('are unique, so the log stays greppable', () => {
    const values = Object.values(AuditAction);
    expect(new Set(values).size).toBe(values.length);
  });

  it('prefix operator actions with admin.', () => {
    for (const [key, value] of Object.entries(AuditAction)) {
      if (key.startsWith('ADMIN_')) {
        expect(value, key).toMatch(/^admin\./);
      }
    }
  });
});
