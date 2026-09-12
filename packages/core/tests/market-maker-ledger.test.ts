import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerAccountKind, LedgerTransferKind } from '@flt/db';
import { Decimal } from '../src/domain/money';
import { ValidationError } from '../src/domain/errors';

/**
 * The market-making book's ledger movements (docs/adr/0007).
 *
 * The load-bearing claims: house capital is seeded into venue margin against
 * FLT's own equity, never a client balance; a realized result moves between the
 * same two accounts; and a zero result posts nothing. The database constraints
 * are not run here — these cover the service-level shape and signs.
 */

const h = vi.hoisted(() => ({
  transfers: [] as Array<Record<string, unknown>>,
  entries: [] as Array<{ accountId: string; amount: string }>,
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
        h.transfers.push(data);
        return data;
      },
    },
    ledgerEntry: {
      create: async ({ data }: { data: { accountId: string; amount: string } }) => {
        h.entries.push(data);
        return data;
      },
    },
  };

  return {
    ...actual,
    prisma: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

beforeEach(() => {
  h.transfers.length = 0;
  h.entries.length = 0;
});

async function subject() {
  return import('../src/services/market-maker-ledger');
}

function amountOf(kind: LedgerAccountKind): string | undefined {
  return h.entries.find((e) => e.accountId.includes(kind))?.amount;
}

describe('fundMakerMargin', () => {
  it('moves FLT equity into venue margin', async () => {
    const { fundMakerMargin } = await subject();
    await fundMakerMargin({ amount: new Decimal(6), reference: 'maker-fund:1' });

    expect(h.transfers[0]!.kind).toBe(LedgerTransferKind.TRADE_SETTLEMENT);
    expect(amountOf(LedgerAccountKind.VENUE_MARGIN)).toBe('6');
    expect(amountOf(LedgerAccountKind.PLATFORM_EQUITY)).toBe('-6');
  });

  it('refuses a non-positive amount', async () => {
    const { fundMakerMargin } = await subject();
    await expect(
      fundMakerMargin({ amount: new Decimal(0), reference: 'maker-fund:0' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('unwindMakerMargin', () => {
  it('returns venue margin to FLT equity', async () => {
    const { unwindMakerMargin } = await subject();
    await unwindMakerMargin({ amount: new Decimal(4), reference: 'maker-unwind:1' });

    expect(amountOf(LedgerAccountKind.PLATFORM_EQUITY)).toBe('4');
    expect(amountOf(LedgerAccountKind.VENUE_MARGIN)).toBe('-4');
  });
});

describe('bookMakerPnl', () => {
  it('books a profit against equity', async () => {
    const { bookMakerPnl } = await subject();
    await bookMakerPnl({ pnl: new Decimal('1.25'), reference: 'maker-pnl:p1' });

    expect(h.transfers).toHaveLength(1);
    expect(amountOf(LedgerAccountKind.VENUE_MARGIN)).toBe('1.25');
    expect(amountOf(LedgerAccountKind.PLATFORM_EQUITY)).toBe('-1.25');
  });

  it('books a loss with the signs flipped', async () => {
    const { bookMakerPnl } = await subject();
    await bookMakerPnl({ pnl: new Decimal('-0.75'), reference: 'maker-pnl:p2' });

    expect(amountOf(LedgerAccountKind.VENUE_MARGIN)).toBe('-0.75');
    expect(amountOf(LedgerAccountKind.PLATFORM_EQUITY)).toBe('0.75');
  });

  it('posts nothing for a zero result', async () => {
    const { bookMakerPnl } = await subject();
    await bookMakerPnl({ pnl: new Decimal(0), reference: 'maker-pnl:p3' });
    expect(h.transfers).toHaveLength(0);
  });
});
