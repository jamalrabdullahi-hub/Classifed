import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerAccountKind } from '@flt/db';

/**
 * The custody portfolio, read from the ledger.
 *
 * The load-bearing claims: balances come from ledger accounts (a liability
 * stored negative reads as a positive holding), buying power counts only the
 * spendable stablecoin, and a holding with no price is marked incomplete rather
 * than valued at zero.
 */

const h = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  tokens: [] as Array<Record<string, unknown>>,
}));

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  return {
    ...actual,
    prisma: {
      ledgerAccount: { findMany: async () => h.accounts },
      token: { findMany: async () => h.tokens },
    },
  };
});

beforeEach(() => {
  h.accounts = [];
  h.tokens = [];
});

async function subject() {
  return import('../src/services/portfolio-usd');
}

describe('custodyPortfolio', () => {
  it('reads balances from the ledger and values them', async () => {
    // Liabilities are stored negative; naturalBalance negates for reading.
    h.accounts = [
      { asset: 'USDC', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-10.5' },
      { asset: 'USDC', kind: LedgerAccountKind.USER_LOCKED, balance: '-1' },
      { asset: 'BTC', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-0.5' },
    ];
    h.tokens = [
      { symbol: 'USDC', name: 'USD Coin', decimals: 6, marketData: null },
      { symbol: 'BTC', name: 'Bitcoin', decimals: 8, marketData: { priceUsd: '60000' } },
    ];

    const portfolio = await (await subject()).custodyPortfolio('user-1');
    const usdc = portfolio.holdings.find((entry) => entry.asset === 'USDC');
    const btc = portfolio.holdings.find((entry) => entry.asset === 'BTC');

    // USDC: 10.5 available + 1 locked = 11.5 at $1.
    expect(usdc?.available).toBe('10.5');
    expect(usdc?.locked).toBe('1');
    expect(usdc?.valueUsd).toBe('11.50');
    // BTC: 0.5 at $60,000.
    expect(btc?.valueUsd).toBe('30000.00');

    expect(portfolio.totalUsd).toBe('30011.50');
    // Buying power is the spendable stablecoin only, not locked, not BTC.
    expect(portfolio.buyingPowerUsd).toBe('10.50');
  });

  it('marks a holding it cannot price as incomplete, not zero', async () => {
    h.accounts = [
      { asset: 'USDC', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-10' },
      { asset: 'MOON', kind: LedgerAccountKind.USER_AVAILABLE, balance: '-5' },
    ];
    h.tokens = [
      { symbol: 'USDC', name: 'USD Coin', decimals: 6, marketData: null },
      { symbol: 'MOON', name: null, decimals: 18, marketData: null },
    ];

    const portfolio = await (await subject()).custodyPortfolio('user-1');
    const moon = portfolio.holdings.find((entry) => entry.asset === 'MOON');

    expect(moon?.complete).toBe(false);
    expect(moon?.valueUsd).toBeNull();
    // The unpriced holding is excluded from the total, not counted as $0.
    expect(portfolio.totalUsd).toBe('10.00');
  });

  it('reports zeros when there is nothing held', async () => {
    const portfolio = await (await subject()).custodyPortfolio('user-1');
    expect(portfolio).toEqual({ totalUsd: '0.00', buyingPowerUsd: '0.00', holdings: [] });
  });
});
