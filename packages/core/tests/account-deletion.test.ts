import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account deletion, checked through the real service with the database mocked:
 * every refusal happens before anything changes, and a successful request
 * suspends, disables trading and signs the person out.
 */

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

const h = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  existing: null as Record<string, unknown> | null,
  created: [] as Array<Record<string, unknown>>,
  userUpdates: [] as Array<Record<string, unknown>>,
  revoked: [] as string[],
}));

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  const counter = (name: string) => ({ count: async () => h.counts[name] ?? 0 });
  const client = {
    ledgerAccount: counter('ledgerAccount'),
    perpOrder: counter('perpOrder'),
    perpPositionSnapshot: counter('perpPositionSnapshot'),
    userAlgorithm: counter('userAlgorithm'),
    custodyDeposit: counter('custodyDeposit'),
    fiatDeposit: counter('fiatDeposit'),
    withdrawal: counter('withdrawal'),
    fiatWithdrawal: counter('fiatWithdrawal'),
    accountDeletionRequest: {
      findFirst: async () => h.existing,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, status: 'REQUESTED' };
        h.created.push(row);
        return row;
      },
    },
    user: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        h.userUpdates.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { ...actual, prisma: client as never };
});

vi.mock('../src/services/sessions', () => ({
  revokeAllSessions: async (_db: unknown, userId: string) => {
    h.revoked.push(userId);
    return 1;
  },
}));

vi.mock('../src/services/audit', () => ({
  AuditAction: { ACCOUNT_DELETION_REQUESTED: 'account.deletion.requested' },
  audit: async () => undefined,
}));

const { requestAccountDeletion, deletionBlockers } = await import('../src/services/account-deletion');

const user = {
  id: 'u1',
  email: 'a@b.c',
  accountStatus: 'KYC_APPROVED',
  tradingDisabled: false,
} as never;

beforeEach(() => {
  h.counts = {};
  h.existing = null;
  h.created = [];
  h.userUpdates = [];
  h.revoked = [];
});

describe('account deletion', () => {
  const cases: Array<[string, string]> = [
    ['ledgerAccount', 'balance'],
    ['perpOrder', 'openOrders'],
    ['perpPositionSnapshot', 'openPositions'],
    ['userAlgorithm', 'runningAlgorithms'],
    ['custodyDeposit', 'depositsInFlight'],
    ['fiatDeposit', 'depositsInFlight'],
    ['withdrawal', 'withdrawalsInFlight'],
    ['fiatWithdrawal', 'withdrawalsInFlight'],
  ];

  for (const [table, blocker] of cases) {
    it(`refuses while ${table} has open rows`, async () => {
      h.counts[table] = 1;
      expect(await deletionBlockers('u1')).toEqual([blocker]);
      await expect(requestAccountDeletion(user)).rejects.toThrow();
      expect(h.created).toHaveLength(0);
      expect(h.userUpdates).toHaveLength(0);
      expect(h.revoked).toHaveLength(0);
    });
  }

  it('suspends, disables trading and signs out on success', async () => {
    const row = await requestAccountDeletion(user);
    expect(row.status).toBe('REQUESTED');
    expect(h.created[0]).toMatchObject({ previousAccountStatus: 'KYC_APPROVED', previousTradingDisabled: false });
    expect(h.userUpdates[0]).toMatchObject({ accountStatus: 'SUSPENDED', tradingDisabled: true });
    expect(h.revoked).toEqual(['u1']);
  });

  it('returns an existing open request instead of creating another', async () => {
    h.existing = { id: 'r0', status: 'REQUESTED' };
    const row = await requestAccountDeletion(user);
    expect(row.id).toBe('r0');
    expect(h.created).toHaveLength(0);
  });
});
