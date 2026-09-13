import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerAccountKind, LedgerTransferKind, Prisma } from '@flt/db';

/**
 * Crediting a swept crypto deposit.
 *
 * The load-bearing claims: the movement is a real double entry (omnibus debited,
 * participant credited, summing to zero), the reference is the sweep hash so a
 * replay credits once, and a missing or non-positive amount is refused rather
 * than quietly posting.
 *
 * The database's own constraints — the zero-sum trigger and the balance CHECK —
 * are not exercised here, because the database is mocked. What is asserted is
 * the shape of what `creditCryptoDeposit` asks the database to store.
 */

const h = vi.hoisted(() => ({
  transfers: [] as Array<Record<string, unknown>>,
  entries: [] as Array<Record<string, unknown>>,
  failTransfer: null as unknown,
}));

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');

  const tx = {
    ledgerAccount: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => ({
        id: `acct:${where.kind}:${where.userId ?? 'platform'}:${where.asset}`,
        kind: where.kind,
        userId: where.userId ?? null,
        asset: where.asset,
        balance: '0',
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => data,
      update: async () => ({}),
    },
    ledgerTransfer: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (h.failTransfer) throw h.failTransfer;
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
  };

  return {
    ...actual,
    prisma: { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) },
  };
});

beforeEach(() => {
  h.transfers.length = 0;
  h.entries.length = 0;
  h.failTransfer = null;
});

async function subject() {
  return import('../src/services/custody-deposits');
}

const base = {
  userId: 'user-1',
  asset: 'usdc',
  amountBaseUnits: '1500000',
  decimals: 6,
  reference: '0xsweephash',
};

describe('creditCryptoDeposit', () => {
  it('posts a balanced DEPOSIT and normalizes the asset symbol', async () => {
    const { creditCryptoDeposit } = await subject();
    const result = await creditCryptoDeposit(base);

    expect(result).toEqual({ credited: true });

    const transfer = h.transfers[0]!;
    expect(transfer.kind).toBe(LedgerTransferKind.DEPOSIT);
    expect(transfer.reference).toBe('crypto-deposit:0xsweephash');

    // 1.5 USDC at 6dp. The omnibus (an asset) is debited, the participant
    // (a liability) credited by the same value.
    const amounts = h.entries.map((entry) => entry.amount);
    expect(amounts).toContain('1.5');
    expect(amounts).toContain('-1.5');

    const debited = h.entries.find((entry) => entry.amount === '1.5')!;
    expect(String(debited.accountId)).toContain(`:${LedgerAccountKind.CLIENT_OMNIBUS}:`);
  });

  it('refuses a non-positive amount', async () => {
    const { creditCryptoDeposit } = await subject();
    await expect(creditCryptoDeposit({ ...base, amountBaseUnits: '0' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a deposit with no reference to make it idempotent', async () => {
    const { creditCryptoDeposit } = await subject();
    await expect(creditCryptoDeposit({ ...base, reference: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('treats a replayed sweep as already credited, not an error', async () => {
    // The unique index on (kind, reference) is what makes this safe; a second
    // credit for the same hash would be money FLT owes and cannot back.
    h.failTransfer = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });

    const { creditCryptoDeposit } = await subject();
    const result = await creditCryptoDeposit(base);
    expect(result).toEqual({ credited: false });
  });

  it('posts the network fee in the same transfer batch as the credit', async () => {
    /**
     * Credit and fee were two separate transactions. If the process died between
     * them, the participant could spend the whole deposit and the later fee
     * charge would drive USER_AVAILABLE positive — a sign-constraint violation
     * that left the deposit row retrying every pass forever. Both movements now
     * post together.
     */
    const { creditCryptoDeposit } = await subject();
    await creditCryptoDeposit({ ...base, gasFeeBaseUnits: '20000' });

    const kinds = h.transfers.map((t) => t.kind);
    expect(kinds).toContain(LedgerTransferKind.DEPOSIT);
    expect(kinds).toContain(LedgerTransferKind.FEE);
    // One transaction: both were recorded by the same mocked client.
    expect(h.transfers).toHaveLength(2);
  });

  it('refuses a fee that would consume the whole deposit', async () => {
    const { creditCryptoDeposit } = await subject();
    await expect(
      creditCryptoDeposit({ ...base, gasFeeBaseUnits: base.amountBaseUnits }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.transfers).toHaveLength(0);
  });

  it('credits without a fee when none is charged', async () => {
    const { creditCryptoDeposit } = await subject();
    await creditCryptoDeposit(base);
    expect(h.transfers).toHaveLength(1);
    expect(h.transfers[0]!.kind).toBe(LedgerTransferKind.DEPOSIT);
  });
});
