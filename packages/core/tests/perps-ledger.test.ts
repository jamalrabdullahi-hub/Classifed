import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerAccountKind, LedgerTransferKind } from '@flt/db';
import { Decimal } from '../src/domain/money';

/**
 * Perp ledger accounting: funding the venue, and settling a closed position.
 *
 * The load-bearing claims: the venue funding moves USDC omnibus -> venue margin
 * (both assets, opposite signs); and a settlement releases the margin, books
 * realized PnL between the participant and the venue, and takes the fee — each
 * an idempotent, balanced transfer. The database constraints are not run here.
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
      ledgerAccount: tx.ledgerAccount,
    },
  };
});

beforeEach(() => {
  h.transfers.length = 0;
  h.entries.length = 0;
});

async function subject() {
  return import('../src/services/perps-ledger');
}

describe('fundVenueMargin', () => {
  it('moves USDC from the omnibus into venue margin', async () => {
    const { fundVenueMargin } = await subject();
    await fundVenueMargin({ amount: new Decimal(6), reference: 'fund:1' });

    expect(h.transfers[0]!.kind).toBe(LedgerTransferKind.TRADE_SETTLEMENT);
    const venue = h.entries.find((e) => e.accountId.includes(LedgerAccountKind.VENUE_MARGIN));
    const omnibus = h.entries.find((e) => e.accountId.includes(LedgerAccountKind.CLIENT_OMNIBUS));
    expect(venue?.amount).toBe('6');
    expect(omnibus?.amount).toBe('-6');
  });
});

describe('settlePerpRealized', () => {
  it('releases margin, books realized profit, and takes the fee', async () => {
    const { settlePerpRealized } = await subject();
    await settlePerpRealized({
      userId: 'u1',
      reference: 'pos:1',
      margin: new Decimal(3),
      pnl: new Decimal(1),
      fee: new Decimal('0.05'),
    });

    const refs = h.transfers.map((t) => t.reference);
    expect(refs).toEqual(['perp-unlock:pos:1', 'perp-pnl:pos:1', 'perp-fee:pos:1']);

    // Profit raises the venue and what the participant is owed.
    const venuePnl = h.entries.find((e) => e.accountId.includes(LedgerAccountKind.VENUE_MARGIN));
    expect(venuePnl?.amount).toBe('1');
    const amounts = h.entries.map((e) => e.amount);
    expect(amounts).toContain('-1'); // participant available (profit owed)
    expect(amounts).toContain('0.05'); // fee out of available
    expect(amounts).toContain('-0.05'); // fee into revenue
    expect(amounts).toContain('3'); // margin unlocked
    expect(amounts).toContain('-3'); // margin back to available
  });
});
