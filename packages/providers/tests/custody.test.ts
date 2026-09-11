import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The omnibus custody adapter.
 *
 * What is asserted here is the arithmetic and the refusal paths, not Privy —
 * provisioning's own test covers the provider call. The load-bearing claims:
 *
 *   1. A deposit address is attributed per participant, not shared.
 *   2. `getBalances` sums a symbol across chains, because the omnibus address
 *      is the same on every EVM chain and "how much USDC do we hold" spans them.
 *   3. An unreadable balance throws rather than counting as zero — an
 *      understated omnibus reads as a shortfall that is not real.
 *   4. A custody provider with no named wallet refuses loudly rather than
 *      reporting an empty, solvent-looking omnibus.
 */

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  walletFindFirst: vi.fn(),
  tokenFindMany: vi.fn(),
  readBalances: vi.fn(),
}));

vi.mock('@flt/config', () => ({ env: () => mocks.env }));

// Partial mock: the adapter reaches `prisma`, but `@flt/core/domain` (imported
// transitively for Decimal and the error classes) also reads real enum exports
// like `AccountStatus` off `@flt/db`. A wholesale mock strips those and the
// suite fails at collection.
vi.mock('@flt/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@flt/db')>();
  return {
    ...actual,
    prisma: {
      wallet: { findFirst: mocks.walletFindFirst },
      token: { findMany: mocks.tokenFindMany },
    },
  };
});

vi.mock('@flt/core/chains', () => ({
  SUPPORTED_CHAINS: [{ chainId: 8453 }, { chainId: 56 }],
  readBalances: mocks.readBalances,
  publicClient: () => ({ getTransactionReceipt: vi.fn() }),
  requireChain: () => {
    throw new Error('requireChain is not expected in these tests');
  },
  findChain: () => undefined,
}));

vi.mock('@privy-io/node/viem', () => ({ createViemAccount: vi.fn() }));
vi.mock('@privy-io/node', () => ({ PrivyClient: class {} }));

import { PrivyCustodyProvider } from '../src/custody/privy-custody';
import { sweepErc20ToOmnibus } from '../src/custody/sweep';

const provider = new PrivyCustodyProvider();

const USDC_BASE = '0x00000000000000000000000000000000000000A1';
const USDT_BASE = '0x00000000000000000000000000000000000000A2';
const USDC_BNB = '0x00000000000000000000000000000000000000B1';

beforeEach(() => {
  mocks.env = {
    OMNIBUS_EVM_ADDRESS: '0x0000000000000000000000000000000000000AbC',
    OMNIBUS_EVM_WALLET_ID: 'wallet-1',
  };
  mocks.walletFindFirst.mockReset();
  mocks.tokenFindMany.mockReset();
  mocks.readBalances.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('depositAddress', () => {
  it('attributes a deposit to the participant own provisioned wallet', async () => {
    mocks.walletFindFirst.mockResolvedValue({ address: '0xDep0sit', chainId: 8453 });

    const result = await provider.depositAddress({ userId: 'u1', asset: 'USDC', chainId: 8453 });

    expect(result).toEqual({ address: '0xDep0sit', chainId: 8453, asset: 'USDC', memo: null });

    // Per participant, not a shared omnibus address — the whole point of not
    // crediting by off-chain reference.
    expect(mocks.walletFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', connector: 'privy-embedded', chainId: 8453 },
      }),
    );
  });

  it('refuses when the participant has no wallet to receive into', async () => {
    mocks.walletFindFirst.mockResolvedValue(null);

    await expect(
      provider.depositAddress({ userId: 'u1', asset: 'USDC', chainId: 8453 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('getBalances', () => {
  it('sums a symbol across chains into whole units', async () => {
    mocks.tokenFindMany.mockResolvedValue([
      { chainId: 8453, address: USDC_BASE, symbol: 'USDC', decimals: 6 },
      { chainId: 8453, address: USDT_BASE, symbol: 'USDT', decimals: 6 },
      { chainId: 56, address: USDC_BNB, symbol: 'USDC', decimals: 6 },
    ]);

    mocks.readBalances.mockImplementation(async (chainId: number) => {
      if (chainId === 8453) {
        return {
          native: { tokenAddress: 'native', balance: '0', ok: true },
          tokens: [
            { tokenAddress: USDC_BASE, balance: '1500000', ok: true },
            { tokenAddress: USDT_BASE, balance: '2500000', ok: true },
          ],
        };
      }
      return {
        native: { tokenAddress: 'native', balance: '0', ok: true },
        tokens: [{ tokenAddress: USDC_BNB, balance: '500000', ok: true }],
      };
    });

    const balances = await provider.getBalances();
    const usdc = balances.find((entry) => entry.asset === 'USDC');
    const usdt = balances.find((entry) => entry.asset === 'USDT');

    // 1.5 USDC on Base + 0.5 USDC on BNB.
    expect(usdc?.total).toBe('2');
    expect(usdt?.total).toBe('2.5');
    expect(usdc?.available).toBe('2');
  });

  it('throws on an unreadable balance instead of reporting zero', async () => {
    mocks.tokenFindMany.mockResolvedValue([
      { chainId: 8453, address: USDC_BASE, symbol: 'USDC', decimals: 6 },
    ]);
    mocks.readBalances.mockResolvedValue({
      native: { tokenAddress: 'native', balance: '0', ok: true },
      tokens: [{ tokenAddress: USDC_BASE, balance: '0', ok: false }],
    });

    await expect(provider.getBalances()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('refuses loudly when no omnibus wallet is configured', async () => {
    mocks.env = {};

    await expect(provider.getBalances()).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });
});

describe('sweepErc20ToOmnibus', () => {
  it('refuses when there is no omnibus address to sweep to', async () => {
    mocks.env = {};

    await expect(
      sweepErc20ToOmnibus({
        wallet: { address: '0x0000000000000000000000000000000000000001' } as never,
        tokenAddress: '0x0000000000000000000000000000000000000002',
        amountBaseUnits: '1000000',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });
});
