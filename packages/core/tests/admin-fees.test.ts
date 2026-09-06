import { randomBytes } from 'node:crypto';
import { AdminRole, FeeType, type AdminUser } from '@flt/db';
import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

/**
 * Guards on operator-set pricing.
 *
 * These run before the database is touched, which is the point: an operator
 * typing 2000 basis points should be told the rule is impossible, not have it
 * saved and then silently clamped to 1000 the first time somebody trades. A
 * rule that does not mean what its author thought is worse than a refused one.
 *
 * Prisma is mocked because none of these cases reach it — every assertion here
 * is about a request that should be rejected on its way in, plus one that
 * should be rejected on the operator's role.
 */
vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  return {
    ...actual,
    prisma: {
      feeConfig: { findUnique: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async () => {
        throw new Error('the transaction should not be reached');
      }),
    },
  };
});

const { upsertFeeConfig, setAccountType } = await import('../src/services/admin');
const { ValidationError, ForbiddenError } = await import('../src/domain/errors');

function operator(role: AdminRole = AdminRole.SUPER_ADMIN): AdminUser {
  return {
    id: 'admin-1',
    email: 'ops@flt.test',
    name: 'Ops',
    passwordHash: 'x',
    role,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AdminUser;
}

const base = {
  name: 'Test rule',
  feeType: FeeType.PERCENTAGE,
  bps: 25,
  priority: 0,
  isEnabled: true,
  reason: 'testing',
};

describe('fee rule guards', () => {
  it('refuses a rate above the aggregator cap rather than clamping it silently', async () => {
    await expect(
      upsertFeeConfig({ admin: operator() }, { ...base, bps: 2_000 }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts the cap exactly', async () => {
    // 1000 bps is legal, so it must get past validation and fail later at the
    // mocked transaction — proving the guard let it through.
    await expect(
      upsertFeeConfig({ admin: operator() }, { ...base, bps: 1_000 }),
    ).rejects.toThrow('the transaction should not be reached');
  });

  it('refuses a percentage rule with no rate', async () => {
    await expect(
      upsertFeeConfig({ admin: operator() }, { ...base, bps: null }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a fractional or negative rate', async () => {
    await expect(
      upsertFeeConfig({ admin: operator() }, { ...base, bps: 12.5 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      upsertFeeConfig({ admin: operator() }, { ...base, bps: -1 }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a fixed rule with no amount', async () => {
    await expect(
      upsertFeeConfig(
        { admin: operator() },
        { ...base, feeType: FeeType.FIXED, bps: null, fixedAmount: null },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a validity window that ends before it starts', async () => {
    await expect(
      upsertFeeConfig(
        { admin: operator() },
        {
          ...base,
          validFrom: new Date('2026-06-01'),
          validUntil: new Date('2026-01-01'),
        },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an unnamed rule', async () => {
    await expect(
      upsertFeeConfig({ admin: operator() }, { ...base, name: '   ' }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an operator without the fee permission', async () => {
    // A VIEWER can read the panel and must not be able to reprice the platform.
    await expect(
      upsertFeeConfig({ admin: operator(AdminRole.VIEWER) }, base),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('tier guards', () => {
  it('refuses an operator without the fee permission', async () => {
    await expect(
      setAccountType(
        { admin: operator(AdminRole.VIEWER) },
        { userId: 'u1', accountType: 'INSTITUTION', reason: 'testing' },
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});
