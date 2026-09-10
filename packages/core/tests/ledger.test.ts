import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LedgerAccountKind, LedgerTransferKind } from '@flt/db';
import { Decimal } from '../src/domain/money';
import { ValidationError } from '../src/domain/errors';
import { naturalBalance, postTransfer } from '../src/services/ledger';

/**
 * The guards that reject a bad transfer before it reaches the database.
 *
 * The database has its own, stronger guards — a deferred constraint trigger on
 * the zero-sum rule and a CHECK on negative balances — and those are what
 * actually make the invariants true. These tests cover the service-level
 * rejections, which exist so a caller gets a message naming the mistake rather
 * than a Postgres exception naming a trigger.
 */

const created: unknown[] = [];

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  return {
    ...actual,
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          ledgerTransfer: { create: async ({ data }: { data: unknown }) => { created.push(data); return data; } },
          ledgerEntry: { create: async ({ data }: { data: unknown }) => { created.push(data); return data; } },
          ledgerAccount: { update: async () => ({}) },
        }),
    },
  };
});

beforeEach(() => {
  created.length = 0;
});

describe('postTransfer', () => {
  /**
   * A client deposit, in the convention the database enforces: debits
   * positive, credits negative.
   *
   * Taking $100 in increases what FLT holds (the omnibus, an asset, debited)
   * and increases what FLT owes (the client, a liability, credited). Both go
   * up in plain language; in double entry they carry opposite signs, which is
   * what lets the pair sum to zero.
   *
   * The first version of this ledger required every account to be >= 0 as well
   * as requiring the sum to be zero, which made this transfer impossible to
   * record. These tests did not catch it because they mock the database.
   */
  const balanced = {
    kind: LedgerTransferKind.DEPOSIT,
    reference: 'custodian-tx-1',
    memo: 'Client deposit',
    entries: [
      { accountId: 'omnibus', amount: new Decimal('100') },
      { accountId: 'client', amount: new Decimal('-100') },
    ],
  };

  it('accepts a transfer whose entries sum to zero', async () => {
    await expect(postTransfer(balanced)).resolves.toBeDefined();
  });

  it('refuses a transfer that does not balance', async () => {
    // The failure this exists to prevent: value appearing from nowhere, which
    // is precisely a balance nothing backs.
    await expect(
      postTransfer({
        ...balanced,
        entries: [
          { accountId: 'omnibus', amount: new Decimal('100') },
          { accountId: 'client', amount: new Decimal('-99') },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a one-sided movement', async () => {
    await expect(
      postTransfer({
        ...balanced,
        entries: [{ accountId: 'client', amount: new Decimal('100') }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a zero-amount entry', async () => {
    await expect(
      postTransfer({
        ...balanced,
        entries: [
          { accountId: 'omnibus', amount: new Decimal('0') },
          { accountId: 'client', amount: new Decimal('0') },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires a memo, so a movement is never unexplained', async () => {
    await expect(postTransfer({ ...balanced, memo: '   ' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('balances across more than two entries', async () => {
    // A trade settlement moves value three ways: out of the buyer, into the
    // seller, and a cut to revenue.
    await expect(
      postTransfer({
        kind: LedgerTransferKind.TRADE_SETTLEMENT,
        reference: 'order-1',
        memo: 'Fill with fee',
        entries: [
          { accountId: 'buyer', amount: new Decimal('-100.5') },
          { accountId: 'seller', amount: new Decimal('100') },
          { accountId: 'revenue', amount: new Decimal('0.5') },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('holds at eighteen decimal places, where a float would not', async () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. Token amounts are routinely
    // this precise, and a rounding error here is money created or destroyed.
    await expect(
      postTransfer({
        ...balanced,
        entries: [
          { accountId: 'a', amount: new Decimal('0.000000000000000001') },
          { accountId: 'b', amount: new Decimal('0.000000000000000002') },
          { accountId: 'c', amount: new Decimal('-0.000000000000000003') },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('records the reference, so a replayed deposit can be rejected as a duplicate', async () => {
    await postTransfer(balanced);
    const transfer = created[0] as { reference: string };
    expect(transfer.reference).toBe('custodian-tx-1');
  });
});

describe('naturalBalance', () => {
  it('reads a liability as the positive figure a person would quote', () => {
    // A client owed 100 is stored as -100, because a liability carries a
    // natural credit balance. Nothing outside the ledger should have to know
    // that, which is what this function is for.
    expect(
      naturalBalance({ kind: LedgerAccountKind.USER_AVAILABLE, balance: '-100' }).toFixed(),
    ).toBe('100');
  });

  it('reads an asset as stored', () => {
    expect(
      naturalBalance({ kind: LedgerAccountKind.CLIENT_OMNIBUS, balance: '100' }).toFixed(),
    ).toBe('100');
  });

  it('treats revenue as a credit balance, like the client accounts', () => {
    // Revenue is FLT's own money rather than somebody else's, but it is
    // credited in the same direction, so it is stored the same way.
    expect(
      naturalBalance({ kind: LedgerAccountKind.FEE_REVENUE, balance: '-5' }).toFixed(),
    ).toBe('5');
  });
});
