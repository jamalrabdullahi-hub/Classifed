import { randomBytes } from 'node:crypto';
import { AdminRole, LedgerTransferKind, type AdminUser } from '@flt/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

/**
 * The operator capital-allocation path.
 *
 * `adjustClientBalance` is the only way a balance is written that no deposit
 * produced, so what is tested here is the shape of the movement and the guards
 * around it: a two-sided `ADJUSTMENT` (omnibus debited, client credited,
 * summing to zero), attributed and reasoned, and refused for a role without
 * `ADJUST_LEDGER`, a non-positive amount, or a missing reason. Prisma is
 * mocked — these assertions are about the request, not the database.
 */

const USER = { id: 'u1', email: 'jamal@example.test' };

interface CapturedEntry {
  accountId: string;
  amount: string;
}
const captured: {
  transfer: { kind?: string; reference?: string; memo?: string; createdByAdminId?: string | null } | null;
  entries: CapturedEntry[];
  accounts: Array<{ id: string; kind: string; userId: string | null; asset: string }>;
  adminActions: Array<{ action: string; entityId: string | null; reason: string | null }>;
} = { transfer: null, entries: [], accounts: [], adminActions: [] };

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  const tx = {
    ledgerAccount: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(
        async ({ data }: { data: { id: string; kind: string; userId: string | null; asset: string } }) => {
          captured.accounts.push(data);
          return data;
        },
      ),
      update: vi.fn(async () => ({})),
    },
    ledgerTransfer: {
      create: vi.fn(async ({ data }: { data: NonNullable<typeof captured.transfer> }) => {
        captured.transfer = data;
        return data;
      }),
    },
    ledgerEntry: {
      create: vi.fn(async ({ data }: { data: CapturedEntry }) => {
        captured.entries.push(data);
        return data;
      }),
    },
    adminAction: {
      create: vi.fn(async ({ data }: { data: { action: string; entityId: string | null; reason: string | null } }) => {
        captured.adminActions.push(data);
        return data;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return {
    ...actual,
    prisma: {
      user: { findUnique: vi.fn(async () => USER) },
      // The asset must exist in the registry: a balance in an asset FLT does
      // not custody could never be withdrawn or reconciled.
      token: { findFirst: vi.fn(async () => ({ symbol: 'USDC', decimals: 6 })) },
      $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
});

const { adjustClientBalance } = await import('../src/services/admin');
const { ValidationError, ForbiddenError } = await import('../src/domain/errors');

function admin(role: AdminRole = AdminRole.SUPER_ADMIN): AdminUser {
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

const context = { admin: admin(), ip: '127.0.0.1', userAgent: 'test', requestId: 'req-1' };

beforeEach(() => {
  captured.transfer = null;
  captured.entries.length = 0;
  captured.accounts.length = 0;
  captured.adminActions.length = 0;
});

describe('adjustClientBalance', () => {
  it('posts a balanced ADJUSTMENT crediting the client from the omnibus', async () => {
    const result = await adjustClientBalance(context, {
      userId: USER.id,
      asset: 'usdc',
      amount: '1',
      reason: 'Fund this account for a live test',
    });

    expect(captured.transfer?.kind).toBe(LedgerTransferKind.ADJUSTMENT);
    expect(captured.transfer?.createdByAdminId).toBe('admin-1');

    // Debits positive, credits negative — the omnibus (asset) is debited, the
    // client (liability) credited, and the pair sums to zero, exactly as a
    // deposit would.
    const kindOf = new Map(captured.accounts.map((account) => [account.id, account.kind]));
    const omnibus = captured.entries.find((e) => kindOf.get(e.accountId) === 'CLIENT_OMNIBUS');
    const client = captured.entries.find((e) => kindOf.get(e.accountId) === 'USER_AVAILABLE');
    expect(omnibus?.amount).toBe('1');
    expect(client?.amount).toBe('-1');
    expect(Number(omnibus?.amount) + Number(client?.amount)).toBe(0);

    // Asset is normalised, and the credited amount is reported.
    expect(result).toMatchObject({ asset: 'USDC', credited: '1' });

    // Attributed and reasoned — the whole point of routing it through the ledger.
    expect(captured.adminActions[0]?.action).toBe('admin.ledger.adjusted');
    expect(captured.adminActions[0]?.entityId).toBe(USER.id);
    expect(captured.adminActions[0]?.reason).toBe('Fund this account for a live test');
  });

  it('refuses a role that lacks ADJUST_LEDGER', async () => {
    await expect(
      adjustClientBalance(
        { ...context, admin: admin(AdminRole.OPERATOR) },
        { userId: USER.id, asset: 'USDC', amount: '1', reason: 'not allowed' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a non-positive amount', async () => {
    await expect(
      adjustClientBalance(context, { userId: USER.id, asset: 'USDC', amount: '0', reason: 'zero' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires a reason', async () => {
    await expect(
      adjustClientBalance(context, { userId: USER.id, asset: 'USDC', amount: '1', reason: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
