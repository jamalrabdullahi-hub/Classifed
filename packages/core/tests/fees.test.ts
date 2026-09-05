import { randomBytes } from 'node:crypto';
import { AccountType, FeeType, type DbClient, type FeeConfig } from '@flt/db';
import { beforeAll, describe, expect, it } from 'vitest';

const RECIPIENT = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  process.env.FLT_FEE_RECIPIENT_ADDRESS = RECIPIENT;
});

const { MAX_FEE_BPS, resolveFee } = await import('../src/services/fees');
const { resetEnvCache } = await import('@flt/config');

/**
 * Fee resolution.
 *
 * The resolver decides what a user is charged, so the ordering rules are worth
 * testing directly rather than through the quote path. A stub client stands in
 * for the database: the query is a simple filter and what matters here is which
 * of the matching rules wins.
 */
function stubDb(configs: Partial<FeeConfig>[]): DbClient {
  const rows = configs.map((config, index) => ({
    id: config.id ?? `rule-${index}`,
    name: config.name ?? `Rule ${index}`,
    feeType: config.feeType ?? FeeType.PERCENTAGE,
    bps: config.bps ?? null,
    fixedAmount: config.fixedAmount ?? null,
    fixedFeeTokenAddress: config.fixedFeeTokenAddress ?? null,
    chainId: config.chainId ?? null,
    tokenAddress: config.tokenAddress ?? null,
    accountType: config.accountType ?? null,
    validFrom: config.validFrom ?? null,
    validUntil: config.validUntil ?? null,
    priority: config.priority ?? 0,
    isEnabled: config.isEnabled ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as FeeConfig[];

  return {
    feeConfig: { findMany: async () => rows },
  } as unknown as DbClient;
}

const context = {
  chainId: 8453,
  accountType: AccountType.INVESTOR,
  feeTokenAddress: USDC,
  referenceAmount: '1000000',
};

describe('specificity', () => {
  it('prefers a token rule over a chain rule over a default', async () => {
    const fee = await resolveFee(
      stubDb([
        { name: 'default', bps: 10 },
        { name: 'chain', bps: 20, chainId: 8453 },
        { name: 'token', bps: 30, chainId: 8453, tokenAddress: USDC },
      ]),
      context,
    );

    expect(fee.bps).toBe(30);
    expect(fee.config?.name).toBe('token');
  });

  it('falls back to the chain rule when no token rule matches', async () => {
    const fee = await resolveFee(
      stubDb([
        { name: 'default', bps: 10 },
        { name: 'chain', bps: 20, chainId: 8453 },
        // Matches a different token, so it must not apply.
        { name: 'other-token', bps: 90, chainId: 8453, tokenAddress: WETH },
      ]),
      context,
    );

    expect(fee.bps).toBe(20);
    expect(fee.config?.name).toBe('chain');
  });

  it('matches a token rule regardless of address casing', async () => {
    const fee = await resolveFee(
      stubDb([{ name: 'token', bps: 30, tokenAddress: USDC.toLowerCase() }]),
      context,
    );
    expect(fee.bps).toBe(30);
  });

  it('breaks a tie between equally specific rules by priority', async () => {
    const fee = await resolveFee(
      stubDb([
        { name: 'standard', bps: 25, chainId: 8453, priority: 0 },
        { name: 'promotional', bps: 5, chainId: 8453, priority: 10 },
      ]),
      context,
    );

    // The promotional override wins without the rule it overrides being deleted.
    expect(fee.bps).toBe(5);
    expect(fee.config?.name).toBe('promotional');
  });

  it('resolves to nothing when no rule matches', async () => {
    const fee = await resolveFee(stubDb([]), context);
    expect(fee.bps).toBe(0);
    expect(fee.config).toBeNull();
  });
});

describe('fixed fees', () => {
  it('converts a fixed amount to basis points of the trade', async () => {
    // 10000 base units of a 1000000-unit trade is 1%.
    const fee = await resolveFee(
      stubDb([{ name: 'flat', feeType: FeeType.FIXED, fixedAmount: '10000' }]),
      context,
    );
    expect(fee.bps).toBe(100);
  });

  it('is a larger proportion of a smaller trade, which is what flat means', async () => {
    const db = stubDb([{ name: 'flat', feeType: FeeType.FIXED, fixedAmount: '10000' }]);

    const small = await resolveFee(db, { ...context, referenceAmount: '100000' });
    const large = await resolveFee(db, { ...context, referenceAmount: '10000000' });

    expect(small.bps).toBeGreaterThan(large.bps);
  });

  it('caps a misconfigured fixed fee rather than consuming the trade', async () => {
    const fee = await resolveFee(
      stubDb([{ name: 'broken', feeType: FeeType.FIXED, fixedAmount: '999999999' }]),
      context,
    );
    expect(fee.bps).toBe(MAX_FEE_BPS);
  });

  it('resolves to nothing for a zero-size reference', async () => {
    const fee = await resolveFee(
      stubDb([{ name: 'flat', feeType: FeeType.FIXED, fixedAmount: '10000' }]),
      { ...context, referenceAmount: '0' },
    );
    expect(fee.bps).toBe(0);
  });
});

describe('caps and configuration', () => {
  it('never emits more than the aggregator accepts, and records the intent', async () => {
    const fee = await resolveFee(stubDb([{ name: 'greedy', bps: 5000 }]), context);

    expect(fee.bps).toBe(MAX_FEE_BPS);
    // The difference between what was asked for and what was applied stays
    // visible rather than being silently swallowed.
    expect(fee.requestedBps).toBe(5000);
    expect(fee.description).toContain('capped');
  });

  it('charges nothing when there is no recipient to pay', async () => {
    process.env.FLT_FEE_RECIPIENT_ADDRESS = '';
    resetEnvCache();

    const fee = await resolveFee(stubDb([{ name: 'default', bps: 50 }]), context);
    expect(fee.bps).toBe(0);
    expect(fee.recipientAddress).toBeNull();

    process.env.FLT_FEE_RECIPIENT_ADDRESS = RECIPIENT;
    resetEnvCache();
  });
});
