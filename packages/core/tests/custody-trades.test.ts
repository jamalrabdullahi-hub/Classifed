import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerTransferKind, Prisma, prisma } from '@flt/db';

/**
 * Settling a spot trade, checked as accounting.
 *
 * The load-bearing claims: the sell leg and the buy leg each balance on their
 * own (two assets, two transfers), the participant is credited `received -
 * fee` rather than the gross amount, and a replay settles once.
 *
 * The database's zero-sum trigger and sign constraints are not run here — the
 * database is mocked. What is asserted is the shape of what `settleSpotTrade`
 * asks it to store.
 */

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  transfers: [] as Array<Record<string, unknown>>,
  entries: [] as Array<Record<string, unknown>>,
  failTransfer: null as unknown,
  quote: null as Record<string, unknown> | null,
  sellToken: null as Record<string, unknown> | null,
  buyToken: null as Record<string, unknown> | null,
}));

vi.mock('@flt/config', () => ({ env: () => h.env }));

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
    prisma: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      quote: { findUnique: async () => h.quote },
      token: {
        findFirst: async ({ where }: { where: { address?: string } }) =>
          h.sellToken && where.address === h.sellToken.address ? h.sellToken : h.buyToken,
      },
    },
  };
});

beforeEach(() => {
  h.env = {};
  h.transfers.length = 0;
  h.entries.length = 0;
  h.failTransfer = null;
  h.quote = null;
  h.sellToken = null;
  h.buyToken = null;
});

async function subject() {
  return import('../src/services/custody-trades');
}

const trade = {
  userId: 'user-1',
  reference: 'tx-123',
  sellAsset: 'USDC',
  sellDecimals: 6,
  buyAsset: 'BTC',
  buyDecimals: 8,
  sellBaseUnits: '10000000', // 10 USDC
  receivedBaseUnits: '100000000', // 1.0 BTC landed in the omnibus
  feeBaseUnits: '1000000', // 0.01 BTC fee
};

describe('settleSpotTrade', () => {
  it('moves the sold asset and credits the bought asset net of fee', async () => {
    const { settleSpotTrade } = await subject();
    const result = await settleSpotTrade(trade);

    expect(result).toEqual({ settled: true });

    // Two transfers, one per asset.
    expect(h.transfers).toHaveLength(2);
    expect(h.transfers.map((t) => t.reference)).toEqual([
      'trade-sell:tx-123',
      'trade-buy:tx-123',
    ]);
    for (const transfer of h.transfers) {
      expect(transfer.kind).toBe(LedgerTransferKind.TRADE_SETTLEMENT);
    }

    const amounts = h.entries.map((entry) => entry.amount);
    // Sell leg: 10 out of locked, 10 out of the omnibus.
    expect(amounts).toContain('10');
    expect(amounts).toContain('-10');
    // Buy leg: 1 BTC into the omnibus, 0.99 to the participant, 0.01 to revenue.
    expect(amounts).toContain('1');
    expect(amounts).toContain('-0.99');
    expect(amounts).toContain('-0.01');
  });

  it('refuses a fee that is the whole of what was received', async () => {
    const { settleSpotTrade } = await subject();
    await expect(
      settleSpotTrade({ ...trade, feeBaseUnits: trade.receivedBaseUnits }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a non-positive received amount', async () => {
    const { settleSpotTrade } = await subject();
    await expect(
      settleSpotTrade({ ...trade, receivedBaseUnits: '0' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('treats a replayed settlement as already settled, not an error', async () => {
    h.failTransfer = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });

    const { settleSpotTrade } = await subject();
    expect(await settleSpotTrade(trade)).toEqual({ settled: false });
  });
});

describe('settleCustodyTradeAfterConfirm', () => {
  const quote = {
    id: 'q1',
    chainId: 8453,
    sellTokenAddress: '0xusdc',
    buyTokenAddress: '0xbtc',
    sellAmount: '10000000',
    feeAmount: '1000000',
  };

  beforeEach(() => {
    h.env = { CUSTODY_PROVIDER: 'privy' };
    h.quote = quote;
    h.sellToken = { address: '0xusdc', symbol: 'USDC', decimals: 6 };
    h.buyToken = { address: '0xbtc', symbol: 'BTC', decimals: 8 };
  });

  it('does nothing when custody is off', async () => {
    h.env = {};
    const { settleCustodyTradeAfterConfirm } = await subject();
    await settleCustodyTradeAfterConfirm(prisma, {
      transactionId: 'tx1',
      userId: 'u1',
      quoteId: 'q1',
      receivedBaseUnits: '100000000',
    });
    expect(h.transfers).toHaveLength(0);
  });

  it('settles the swap from the received amount', async () => {
    const { settleCustodyTradeAfterConfirm } = await subject();
    await settleCustodyTradeAfterConfirm(prisma, {
      transactionId: 'tx1',
      userId: 'u1',
      quoteId: 'q1',
      receivedBaseUnits: '100000000',
    });
    expect(h.transfers.map((t) => t.reference)).toEqual(['trade-sell:tx1', 'trade-buy:tx1']);
  });

  it('does not settle when no received amount could be read', async () => {
    const { settleCustodyTradeAfterConfirm } = await subject();
    await settleCustodyTradeAfterConfirm(prisma, {
      transactionId: 'tx1',
      userId: 'u1',
      quoteId: 'q1',
      receivedBaseUnits: null,
    });
    expect(h.transfers).toHaveLength(0);
  });
});

describe('releaseCustodyTradeLock', () => {
  beforeEach(() => {
    h.env = { CUSTODY_PROVIDER: 'privy' };
    h.quote = {
      id: 'q1',
      chainId: 8453,
      sellTokenAddress: '0xusdc',
      buyTokenAddress: '0xbtc',
      sellAmount: '10000000',
      feeAmount: null,
    };
    h.sellToken = { address: '0xusdc', symbol: 'USDC', decimals: 6 };
    h.buyToken = { address: '0xbtc', symbol: 'BTC', decimals: 8 };
  });

  it('releases the reservation with an UNLOCK transfer', async () => {
    const { releaseCustodyTradeLock } = await subject();
    await releaseCustodyTradeLock(prisma, { transactionId: 'tx1', userId: 'u1', quoteId: 'q1' });
    expect(h.transfers).toHaveLength(1);
    expect(h.transfers[0]!.kind).toBe(LedgerTransferKind.UNLOCK);
  });

  it('does nothing when custody is off', async () => {
    h.env = {};
    const { releaseCustodyTradeLock } = await subject();
    await releaseCustodyTradeLock(prisma, { transactionId: 'tx1', userId: 'u1', quoteId: 'q1' });
    expect(h.transfers).toHaveLength(0);
  });
});
