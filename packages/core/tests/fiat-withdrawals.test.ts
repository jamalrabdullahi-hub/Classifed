import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@flt/db';
import { Decimal } from '../src/domain/money';

/**
 * Cash withdrawals, checked through the real service.
 *
 * The database and the ledger are mocked, so these do not run the Postgres
 * constraints — the integration suite owns those. What they do assert is the
 * part a person would get wrong reading the code: exactly what is reserved,
 * exactly what the payout posts, and every refusal that has to happen *before*
 * anything is reserved.
 */

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

const h = vi.hoisted(() => ({
  settings: { enabled: true, feeBps: 100, minUsd: '10', evc: true, bank: true, paypal: true },
  available: '1000',
  rows: new Map<string, Record<string, unknown>>(),
  openCount: 0,
  claimBlocked: false,
  createError: null as unknown,
  unlockError: null as unknown,
  locks: [] as Array<Record<string, unknown>>,
  unlocks: [] as Array<Record<string, unknown>>,
  transfers: [] as Array<{ entries: Array<{ accountId: string; amount: { toFixed: () => string } }> }>,
}));

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');

  const fiatWithdrawal = {
    count: async () => h.openCount,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (h.createError) throw h.createError;
      const row = { ...data, status: 'REQUESTED' };
      h.rows.set(data.id as string, row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => h.rows.get(where.id) ?? null,
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }) => {
      const row = h.rows.get(where.id);
      if (!row || row.status !== where.status || h.claimBlocked) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };

  const client = {
    fiatWithdrawal,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  return { ...actual, prisma: client as never };
});

vi.mock('../src/services/ledger', async () => {
  const { Decimal: D } = await vi.importActual<typeof import('../src/domain/money')>(
    '../src/domain/money',
  );
  return {
    accountFor: async ({ kind, userId, asset }: { kind: string; userId?: string; asset: string }) => ({
      id: `${kind}:${userId ?? 'platform'}:${asset}`,
      kind,
    }),
    clientBalance: async () => ({ available: new D(h.available), locked: new D(0) }),
    lockFunds: async (input: Record<string, unknown>) => {
      h.locks.push(input);
    },
    unlockFunds: async (input: Record<string, unknown>) => {
      if (h.unlockError) throw h.unlockError;
      h.unlocks.push(input);
    },
    postTransfer: async (input: { entries: Array<{ accountId: string; amount: { toFixed: () => string } }> }) => {
      h.transfers.push(input);
      return input;
    },
  };
});

vi.mock('../src/services/platform-settings', () => ({
  resolveFiatRailSettings: async () => ({ wire: {}, paypal: {}, withdrawals: h.settings }),
}));

vi.mock('../src/services/audit', async () => {
  const actual = await vi.importActual<typeof import('../src/services/audit')>('../src/services/audit');
  return { ...actual, audit: async () => undefined };
});

import {
  markFiatWithdrawalPaid,
  rejectFiatWithdrawal,
  requestFiatWithdrawal,
} from '../src/services/fiat-withdrawals';

const approved = { id: 'u1', accountStatus: 'KYC_APPROVED', tradingDisabled: false } as never;

const evc = { method: 'EVC' as const, payeeName: 'Amina Yusuf', payeePhone: '615123456' };

function seed(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'w1',
    userId: 'u1',
    method: 'EVC',
    asset: 'USDC',
    reference: 'W-AAAA0001',
    amountUsd: '100',
    feeUsd: '1',
    netUsd: '99',
    status: 'REQUESTED',
    ...overrides,
  };
  h.rows.set(row.id, row);
  return row;
}

beforeEach(() => {
  h.settings = { enabled: true, feeBps: 100, minUsd: '10', evc: true, bank: true, paypal: true };
  h.available = '1000';
  h.rows.clear();
  h.openCount = 0;
  h.claimBlocked = false;
  h.createError = null;
  h.unlockError = null;
  h.locks.length = 0;
  h.unlocks.length = 0;
  h.transfers.length = 0;
});

describe('requestFiatWithdrawal', () => {
  it('reserves exactly the amount and rounds the fee up to the cent', async () => {
    // 100.555 is cut to 100.55; 1% of that is 1.0055, which rounds UP to 1.01
    // so the fee is never a fraction of a cent FLT cannot collect.
    const row = await requestFiatWithdrawal(approved, { ...evc, amountUsd: '100.555' });

    expect((h.locks[0]!.amount as Decimal).toFixed()).toBe('100.55');
    expect(row.feeUsd).toBe('1.01');
    expect(row.netUsd).toBe('99.54');
  });

  it('refuses when cash withdrawals are closed, reserving nothing', async () => {
    h.settings.enabled = false;
    await expect(requestFiatWithdrawal(approved, { ...evc, amountUsd: '50' })).rejects.toThrow(/not open/);
    expect(h.locks).toHaveLength(0);
  });

  it('refuses a method the operator has switched off', async () => {
    h.settings.paypal = false;
    await expect(
      requestFiatWithdrawal(approved, {
        method: 'PAYPAL',
        payeeName: 'Amina Yusuf',
        payeeEmail: 'amina@example.com',
        amountUsd: '50',
      }),
    ).rejects.toThrow(/not available/);
    expect(h.locks).toHaveLength(0);
  });

  it('refuses below the minimum', async () => {
    await expect(requestFiatWithdrawal(approved, { ...evc, amountUsd: '9.99' })).rejects.toThrow(/minimum/);
    expect(h.locks).toHaveLength(0);
  });

  it('refuses more than the available balance, reserving nothing', async () => {
    h.available = '50';
    await expect(requestFiatWithdrawal(approved, { ...evc, amountUsd: '100' })).rejects.toThrow(
      /more than your available/,
    );
    expect(h.locks).toHaveLength(0);
  });

  it('refuses a suspended account before touching the balance', async () => {
    await expect(
      requestFiatWithdrawal({ id: 'u1', accountStatus: 'SUSPENDED', tradingDisabled: false } as never, {
        ...evc,
        amountUsd: '50',
      }),
    ).rejects.toMatchObject({ code: 'KYC_REQUIRED' });
    expect(h.locks).toHaveLength(0);
  });

  it('refuses an EVC payout without a usable number', async () => {
    await expect(
      requestFiatWithdrawal(approved, { ...evc, payeePhone: '12', amountUsd: '50' }),
    ).rejects.toThrow(/EVC number/);
  });

  it('refuses a malformed PayPal address', async () => {
    await expect(
      requestFiatWithdrawal(approved, {
        method: 'PAYPAL',
        payeeName: 'Amina Yusuf',
        payeeEmail: 'not-an-email',
        amountUsd: '50',
      }),
    ).rejects.toThrow(/PayPal email/);
  });

  it('refuses a malformed SWIFT code', async () => {
    await expect(
      requestFiatWithdrawal(approved, {
        method: 'BANK',
        payeeName: 'Amina Yusuf',
        bankName: 'Premier Bank',
        accountNumber: 'SO12345678',
        swift: 'BAD',
        amountUsd: '50',
      }),
    ).rejects.toThrow(/SWIFT/);
  });

  it('releases the reservation if the request cannot be recorded', async () => {
    h.createError = new Error('database unavailable');
    await expect(requestFiatWithdrawal(approved, { ...evc, amountUsd: '40' })).rejects.toThrow(
      /database unavailable/,
    );
    expect(h.locks).toHaveLength(1);
    expect(h.unlocks).toHaveLength(1);
    expect((h.unlocks[0]!.amount as Decimal).toFixed()).toBe('40');
  });
});

describe('markFiatWithdrawalPaid', () => {
  it('spends the reservation into FLT equity and fee revenue, summing to zero', async () => {
    seed();
    await markFiatWithdrawalPaid('admin-1', 'w1', { payoutReference: 'EVC-778812' });

    const entries = h.transfers[0]!.entries;
    const byKind = Object.fromEntries(entries.map((e) => [e.accountId.split(':')[0], e.amount.toFixed()]));

    expect(byKind).toEqual({ USER_LOCKED: '100', PLATFORM_EQUITY: '-99', FEE_REVENUE: '-1' });
    const sum = entries.reduce((total, e) => total.plus(e.amount.toFixed()), new Decimal(0));
    expect(sum.toFixed()).toBe('0');
    expect(h.rows.get('w1')!.status).toBe('PAID');
  });

  it('leaves out the fee entry when there is no fee', async () => {
    seed({ feeUsd: '0', netUsd: '100' });
    await markFiatWithdrawalPaid('admin-1', 'w1', { payoutReference: 'BANK-4411' });
    expect(h.transfers[0]!.entries).toHaveLength(2);
  });

  it('refuses a payout recorded without a reference', async () => {
    seed();
    await expect(markFiatWithdrawalPaid('admin-1', 'w1', { payoutReference: ' ' })).rejects.toThrow(
      /payout reference/,
    );
    expect(h.transfers).toHaveLength(0);
  });

  it('refuses a withdrawal that is already paid', async () => {
    seed({ status: 'PAID' });
    await expect(markFiatWithdrawalPaid('admin-1', 'w1', { payoutReference: 'X-1234' })).rejects.toThrow(
      /already paid/,
    );
    expect(h.transfers).toHaveLength(0);
  });

  it('posts nothing when another operator claimed it first', async () => {
    seed();
    h.claimBlocked = true;
    await expect(markFiatWithdrawalPaid('admin-1', 'w1', { payoutReference: 'X-1234' })).rejects.toThrow(
      /Another operator/,
    );
    expect(h.transfers).toHaveLength(0);
  });
});

describe('rejectFiatWithdrawal', () => {
  it('releases the reservation and marks it rejected', async () => {
    seed();
    await rejectFiatWithdrawal('admin-1', 'w1', { note: 'Name does not match the account holder' });

    expect((h.unlocks[0]!.amount as Decimal).toFixed()).toBe('100');
    expect(h.rows.get('w1')!.status).toBe('REJECTED');
  });

  it('treats a reservation already released as released', async () => {
    seed();
    h.unlockError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    await rejectFiatWithdrawal('admin-1', 'w1', { note: 'Duplicate request, already refunded' });
    expect(h.rows.get('w1')!.status).toBe('REJECTED');
  });

  it('refuses a rejection without a reason the participant can read', async () => {
    seed();
    await expect(rejectFiatWithdrawal('admin-1', 'w1', { note: 'no' })).rejects.toThrow(/at least 8/);
    expect(h.unlocks).toHaveLength(0);
  });
});
