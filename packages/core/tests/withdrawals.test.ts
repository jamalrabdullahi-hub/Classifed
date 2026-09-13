import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerAccountKind, LedgerTransferKind, WithdrawalStatus } from '@flt/db';

/**
 * Withdrawals: reserve on request, debit only on confirmation, release on
 * failure.
 *
 * The load-bearing claims: the amount is locked before anything is broadcast
 * (so it cannot back two things), the ledger is debited only when the
 * withdrawal is confirmed, and a failure gives the reservation back. The
 * database's own constraints are not run here — the database is mocked.
 */

const h = vi.hoisted(() => ({
  token: null as Record<string, unknown> | null,
  withdrawal: null as Record<string, unknown> | null,
  accounts: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
  transfers: [] as Array<Record<string, unknown>>,
  entries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');

  const tx = {
    ledgerAccount: {
      // Mirror the seeded accounts so `accountFor` sees the same balance
      // `clientBalance` does — a real database has one table behind both.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const seeded = h.accounts.find(
          (account) => account.kind === where.kind && account.asset === where.asset,
        );
        return {
          id: `acct:${where.kind}:${where.userId ?? 'platform'}:${where.asset}`,
          kind: where.kind,
          userId: where.userId ?? null,
          asset: where.asset,
          balance: seeded ? String(seeded.balance) : '0',
        };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => data,
      update: async () => ({}),
    },
    ledgerTransfer: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.transfers.push(data);
        return data;
      },
    },
    ledgerEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.entries.push(data);
        return data;
      },
    },
    withdrawal: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        h.updates.push({ where, data });
        return { ...h.withdrawal, ...data };
      },
    },
  };

  return {
    ...actual,
    prisma: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      token: { findFirst: async () => h.token },
      ledgerAccount: { findMany: async () => h.accounts },
      withdrawal: {
        findUnique: async () => h.withdrawal,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          h.created.push(data);
          return { ...data, txHash: null, failureReason: null };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          h.updates.push({ where, data });
          return { ...h.withdrawal, ...data };
        },
      },
    },
  };
});

beforeEach(() => {
  h.token = { symbol: 'USDC', decimals: 6, isEnabled: true };
  h.withdrawal = null;
  h.accounts = [];
  h.created.length = 0;
  h.updates.length = 0;
  h.transfers.length = 0;
  h.entries.length = 0;
});

async function subject() {
  return import('../src/services/withdrawals');
}

const destination = '0x0000000000000000000000000000000000000001';

/**
 * A participant allowed to move money. `requestWithdrawal` calls
 * `assertMayTrade`, the same gate quotes and perps use, so anything else is
 * refused before a balance is even read.
 */
const approved = { id: 'u1', accountStatus: 'KYC_APPROVED', tradingDisabled: false } as never;

describe('requestWithdrawal', () => {
  it('reserves the amount and records a pending withdrawal', async () => {
    h.accounts = [{ asset: 'USDC', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-100' }];

    const { requestWithdrawal } = await subject();
    await requestWithdrawal(approved, {
      asset: 'usdc',
      chainId: 8453,
      amount: '10',
      destinationAddress: destination,
    });

    // 10 USDC at 6 decimals, and the funds moved to locked first.
    expect(h.created[0]!.amountBaseUnits).toBe('10000000');
    expect(h.transfers.some((t) => t.kind === LedgerTransferKind.LOCK)).toBe(true);
  });

  it('refuses a suspended account, so suspension stops money leaving', async () => {
    /**
     * Suspension is what an operator applies to an account they believe is
     * compromised or fraudulent. It has to stop the withdrawal, not only the
     * trading — this gate was missing, which made it cosmetic on the one action
     * that takes funds out of custody.
     */
    h.accounts = [{ asset: 'USDC', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-100' }];
    const { requestWithdrawal } = await subject();

    await expect(
      requestWithdrawal({ id: 'u1', accountStatus: 'SUSPENDED', tradingDisabled: false } as never, {
        asset: 'USDC',
        chainId: 8453,
        amount: '10',
        destinationAddress: destination,
      }),
    ).rejects.toMatchObject({ code: 'KYC_REQUIRED' });

    // Nothing was reserved: it was refused before the balance was touched.
    expect(h.transfers).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });

  it('refuses an account with trading disabled', async () => {
    h.accounts = [{ asset: 'USDC', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-100' }];
    const { requestWithdrawal } = await subject();

    await expect(
      requestWithdrawal(
        { id: 'u1', accountStatus: 'KYC_APPROVED', tradingDisabled: true } as never,
        { asset: 'USDC', chainId: 8453, amount: '10', destinationAddress: destination },
      ),
    ).rejects.toMatchObject({ code: 'TRADING_DISABLED' });
    expect(h.transfers).toHaveLength(0);
  });

  it('refuses more than the available balance', async () => {
    h.accounts = [{ asset: 'USDC', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-5' }];

    const { requestWithdrawal } = await subject();
    await expect(
      requestWithdrawal(approved, {
        asset: 'USDC',
        chainId: 8453,
        amount: '10',
        destinationAddress: destination,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(h.created).toHaveLength(0);
  });
});

describe('confirmWithdrawal', () => {
  it('debits the reservation and the omnibus when confirmed', async () => {
    h.withdrawal = {
      id: 'w1',
      userId: 'u1',
      asset: 'USDC',
      decimals: 6,
      amountBaseUnits: '10000000',
      destinationAddress: destination,
      txHash: '0xhash',
      status: WithdrawalStatus.SENT,
    };

    const { confirmWithdrawal } = await subject();
    expect(await confirmWithdrawal('w1')).toEqual({ completed: true });

    expect(h.transfers.some((t) => t.reference === 'withdrawal:w1')).toBe(true);
    const amounts = h.entries.map((entry) => entry.amount);
    expect(amounts).toContain('10');
    expect(amounts).toContain('-10');
    expect(h.updates.some((u) => u.data.status === WithdrawalStatus.COMPLETED)).toBe(true);
  });
});

describe('failWithdrawal', () => {
  it('releases the reservation and marks it failed', async () => {
    h.withdrawal = {
      id: 'w1',
      userId: 'u1',
      asset: 'USDC',
      decimals: 6,
      amountBaseUnits: '10000000',
      destinationAddress: destination,
      txHash: null,
      status: WithdrawalStatus.PENDING,
    };

    const { failWithdrawal } = await subject();
    await failWithdrawal('w1', 'Broadcast reverted');

    expect(h.transfers.some((t) => t.kind === LedgerTransferKind.UNLOCK)).toBe(true);
    expect(h.updates.some((u) => u.data.status === WithdrawalStatus.FAILED)).toBe(true);
  });
});
