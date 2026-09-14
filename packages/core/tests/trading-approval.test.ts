import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Trading is a separate approval on top of identity verification.
 *
 * `assertMayTrade` still guards money leaving (withdrawals); placing trades
 * additionally needs `tradingApprovedAt`. These pin that difference.
 */

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

const base = {
  id: 'u1',
  accountStatus: 'KYC_APPROVED',
  tradingDisabled: false,
  tradingApprovedAt: null as Date | null,
};

describe('trading approval', () => {
  it('lets a verified but unapproved account withdraw-level checks pass, but not trade', async () => {
    const { assertMayTrade, assertMayPlaceTrades } = await import('../src/services/kyc');
    const user = { ...base } as never;
    expect(() => assertMayTrade(user)).not.toThrow();
    expect(() => assertMayPlaceTrades(user)).toThrow(/approved for trading/i);
  });

  it('lets a verified and approved account trade', async () => {
    const { assertMayPlaceTrades, mayPlaceTrades } = await import('../src/services/kyc');
    const user = { ...base, tradingApprovedAt: new Date() } as never;
    expect(() => assertMayPlaceTrades(user)).not.toThrow();
    expect(mayPlaceTrades(user)).toBe(true);
  });

  it('still refuses an approved account that is unverified, suspended or disabled', async () => {
    const { assertMayPlaceTrades } = await import('../src/services/kyc');
    const approved = new Date();
    expect(() => assertMayPlaceTrades({ ...base, tradingApprovedAt: approved, accountStatus: 'KYC_REVIEW' } as never)).toThrow();
    expect(() => assertMayPlaceTrades({ ...base, tradingApprovedAt: approved, accountStatus: 'SUSPENDED' } as never)).toThrow();
    expect(() => assertMayPlaceTrades({ ...base, tradingApprovedAt: approved, tradingDisabled: true } as never)).toThrow(/disabled/i);
  });
});
