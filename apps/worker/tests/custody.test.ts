import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustodyDepositStatus } from '@flt/db';

/**
 * The custody deposit pipeline's state machine.
 *
 * Detection is exercised lightly (its identity/idempotency is a database
 * constraint, tested by hand against the migration). What is asserted here is
 * the rule that matters most: a deposit is credited only once its sweep is
 * *confirmed* — never on a broadcast, and never twice.
 */

const mocks = vi.hoisted(() => ({
  providerDisabled: false,
  getWithdrawal: vi.fn(),
  sweepErc20ToOmnibus: vi.fn(),
  creditCryptoDeposit: vi.fn(),
  cryptoDepositGasFeeBaseUnits: vi.fn(),
  custodyRows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
}));

vi.mock('@flt/providers', () => ({
  custodyProvider: () =>
    mocks.providerDisabled
      ? null
      : { meta: { slug: 'privy', name: 'test', isMock: false }, getWithdrawal: mocks.getWithdrawal },
  sweepErc20ToOmnibus: mocks.sweepErc20ToOmnibus,
}));

vi.mock('@flt/core/services/custody-deposits', () => ({
  creditCryptoDeposit: mocks.creditCryptoDeposit,
  cryptoDepositGasFeeBaseUnits: mocks.cryptoDepositGasFeeBaseUnits,
  MIN_CRYPTO_DEPOSIT_USD: 5,
}));

vi.mock('@flt/core/chains', () => ({
  publicClient: () => ({ getBlockNumber: async () => 0n, getLogs: async () => [] }),
}));

vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  return {
    ...actual,
    prisma: {
      // Empty registry: detection returns nothing, so the pass exercises the
      // sweep/credit stage against the fixtures below.
      token: { findMany: async () => [], findFirst: async () => null },
      wallet: { findMany: async () => [], findFirst: async () => null },
      custodyDeposit: {
        findMany: async ({ where }: { where: { status?: unknown } }) =>
          typeof where?.status === 'string' ? [] : mocks.custodyRows,
        findUnique: async () => null,
        create: async ({ data }: { data: unknown }) => data,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          mocks.updates.push({ where, data });
          return { id: where.id, ...data };
        },
      },
    },
  };
});

import { sweepCustodyDeposits } from '../src/custody';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd1',
    userId: 'u1',
    asset: 'USDC',
    chainId: 8453,
    decimals: 6,
    amountBaseUnits: '1500000',
    depositAddress: '0x000000000000000000000000000000000000000A',
    depositTxHash: '0xdeposit',
    logIndex: 0,
    sweepTxHash: '0xsweep1',
    sweptAt: null,
    ledgerReference: null,
    status: CustodyDepositStatus.SWEEPING,
    failureReason: null,
    creditedAt: null,
    ...overrides,
  };
}

function statusUpdates(): Array<Record<string, unknown>> {
  return mocks.updates.map((entry) => entry.data);
}

beforeEach(() => {
  mocks.providerDisabled = false;
  mocks.custodyRows = [];
  mocks.updates = [];
  mocks.getWithdrawal.mockReset();
  mocks.sweepErc20ToOmnibus.mockReset();
  mocks.creditCryptoDeposit.mockReset().mockResolvedValue({ credited: true });
  mocks.cryptoDepositGasFeeBaseUnits.mockReset().mockReturnValue('0');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sweepCustodyDeposits', () => {
  it('does nothing at all when custody is disabled', async () => {
    mocks.providerDisabled = true;
    mocks.custodyRows = [row()];

    const result = await sweepCustodyDeposits();

    expect(result).toEqual({ detected: 0, swept: 0, credited: 0, failed: 0 });
    expect(mocks.creditCryptoDeposit).not.toHaveBeenCalled();
  });

  it('credits a deposit once its sweep is confirmed', async () => {
    mocks.custodyRows = [row()];
    mocks.getWithdrawal.mockResolvedValue({
      id: '0xsweep1',
      status: 'completed',
      txHash: '0xsweep1',
      failureReason: null,
    });

    const result = await sweepCustodyDeposits();

    // Credited against the sweep hash, so a replay is idempotent.
    expect(mocks.creditCryptoDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', reference: '0xsweep1', asset: 'USDC' }),
    );
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({ status: CustodyDepositStatus.CREDITED }),
    );
    expect(result.credited).toBe(1);
  });

  it('leaves a deposit uncounted while its sweep is still pending', async () => {
    mocks.custodyRows = [row()];
    mocks.getWithdrawal.mockResolvedValue({
      id: '0xsweep1',
      status: 'pending',
      txHash: '0xsweep1',
      failureReason: null,
    });

    const result = await sweepCustodyDeposits();

    // A broadcast that is not yet mined must never be credited.
    expect(mocks.creditCryptoDeposit).not.toHaveBeenCalled();
    expect(result.credited).toBe(0);
    expect(statusUpdates().some((d) => d.status === CustodyDepositStatus.CREDITED)).toBe(false);
  });

  it('marks a reverted sweep FAILED and credits nothing', async () => {
    mocks.custodyRows = [row()];
    mocks.getWithdrawal.mockResolvedValue({
      id: '0xsweep1',
      status: 'failed',
      txHash: '0xsweep1',
      failureReason: 'Reverted on-chain',
    });

    const result = await sweepCustodyDeposits();

    expect(mocks.creditCryptoDeposit).not.toHaveBeenCalled();
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({ status: CustodyDepositStatus.FAILED }),
    );
    expect(result.failed).toBe(1);
  });

  it('credits an already-confirmed (SWEPT) deposit without re-checking the chain', async () => {
    mocks.custodyRows = [row({ status: CustodyDepositStatus.SWEPT, sweptAt: new Date() })];

    const result = await sweepCustodyDeposits();

    expect(mocks.getWithdrawal).not.toHaveBeenCalled();
    expect(mocks.creditCryptoDeposit).toHaveBeenCalledTimes(1);
    expect(result.credited).toBe(1);
  });
});
