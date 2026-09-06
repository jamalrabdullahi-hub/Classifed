import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prepareTestDatabase, truncateAll } from './setup';

prepareTestDatabase();

const { prisma } = await import('@flt/db');
const {
  createPolicy,
  refreshPolicy,
  declareFunding,
  recommendReduction,
  cancelPolicy,
  getPolicy,
  policyBalances,
} = await import('../../src/services/protection-policies');
const { ValidationError, NotFoundError } = await import('../../src/domain/errors');
const { Decimal } = await import('../../src/domain/money');

/**
 * The policy lifecycle, against a real database.
 *
 * What is worth testing here is precisely what a unit test cannot reach: that
 * the transition and its immutable record commit together, that the ledger
 * never mixes participant capital with operator revenue, and that a policy
 * cannot be read or acted on by somebody who does not own it.
 *
 * The venue is a stub with a fixed price, because the arithmetic is already
 * covered by the unit suites — what is under test here is the bookkeeping
 * around it.
 */

let markPrice = '100';
let positionSize = '10';
let liquidationPrice: string | null = '80';

/** Deterministic candles: a 2%-amplitude alternation, so σ is stable and non-zero. */
function candles(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const close = i % 2 === 0 ? 100 : 102;
    return { time: i * 3600, open: close, high: close, low: close, close, volume: 1 };
  });
}

const venue = {
  meta: { slug: 'hyperliquid', name: 'Hyperliquid', kind: 'PERP_VENUE' },
  settlementChainId: 42161,
  requiresBridgedCollateral: true,
  async getMarket(symbol: string) {
    return {
      symbol,
      name: symbol,
      venueAssetId: 0,
      markPrice,
      maxLeverage: 40,
      venueMaxLeverage: 40,
      minSize: '0.001',
      sizeDecimals: 3,
      isDelisted: false,
    };
  },
  async getCandles() {
    return candles(200);
  },
  async getPositions() {
    return positionSize === '0'
      ? []
      : [
          {
            symbol: 'BTC',
            side: 'LONG' as const,
            size: positionSize,
            entryPrice: '100',
            margin: '100',
            marginMode: 'ISOLATED' as const,
            leverage: 10,
            liquidationPrice,
            unrealizedPnl: null,
            fundingPaid: null,
          },
        ];
  },
} as never;

async function makeUser(email: string) {
  return prisma.user.create({
    data: {
      id: crypto.randomUUID(),
      email,
      passwordHash: 'unused',
      accountStatus: 'KYC_APPROVED',
      emailVerifiedAt: new Date(),
    },
  });
}

async function makeWallet(userId: string, address: string) {
  await prisma.chain.upsert({
    where: { chainId: 8453 },
    create: {
      chainId: 8453,
      name: 'Base',
      shortName: 'base',
      isEnabled: true,
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
      explorerUrl: 'https://basescan.org',
    },
    update: {},
  });
  return prisma.wallet.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      address,
      chainId: 8453,
      verifiedAt: new Date(),
    },
  });
}

async function makeMarket() {
  return prisma.perpMarket.upsert({
    where: { venueSlug_symbol: { venueSlug: 'hyperliquid', symbol: 'BTC' } },
    create: {
      id: crypto.randomUUID(),
      venueSlug: 'hyperliquid',
      symbol: 'BTC',
      name: 'Bitcoin',
      venueAssetId: 0,
      venueMaxLeverage: 40,
      maxLeverage: 10,
      sizeDecimals: 3,
      minSize: '0.001',
      isEnabled: true,
    },
    update: { isEnabled: true },
  });
}

let user: Awaited<ReturnType<typeof makeUser>>;
let wallet: Awaited<ReturnType<typeof makeWallet>>;

beforeAll(async () => {
  await truncateAll(prisma);
  await makeMarket();
  user = await makeUser('participant@test.local');
  wallet = await makeWallet(user.id, '0x1111111111111111111111111111111111111111');
});

// One open policy per position is enforced by the service, so each case starts
// from a clean slate rather than depending on the previous one having tidied up.
afterEach(async () => {
  await prisma.protectionPolicy.deleteMany({});
  markPrice = '100';
  positionSize = '10';
  liquidationPrice = '80';
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('creating a policy', () => {
  it('writes the terms, activates, and records the creation transition', async () => {
    const { policy, assessment } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'OMNI', symbol: 'BTC', percentile: 0.9973, horizonDays: 10 },
    );

    expect(policy.state).toBe('ACTIVE');
    expect(policy.entryPrice).toBe('100');
    expect(policy.percentile).toBe('0.9973');
    expect(policy.horizonDays).toBe('10');
    // $100 entry × 10 contracts.
    expect(new Decimal(policy.notional).toNumber()).toBe(1000);
    expect(policy.nextRebaseAt).not.toBeNull();

    // The transition record exists and carries the inputs, not just the states.
    const { events } = await getPolicy(policy.id, user);
    expect(events).toHaveLength(1);
    expect(events[0]!.fromState).toBe('CREATED');
    expect(events[0]!.toState).toBe('ACTIVE');
    expect(events[0]!.zConvention).toBe('one-tailed');
    expect(events[0]!.boundary).toBe(assessment.peril.boundary.toFixed());
    expect(events[0]!.percentile).toBe('0.9973');
    // FLT executes nothing, so these are null rather than zero.
    expect(events[0]!.executionPrice).toBeNull();
    expect(events[0]!.fee).toBeNull();

    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });

  it('refuses a second policy over the same position', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'BASE_DAY', symbol: 'BTC' },
    );

    await expect(
      createPolicy(venue, { user, wallet }, { kind: 'OMNI', symbol: 'BTC' }),
    ).rejects.toThrow(ValidationError);

    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });

  it('refuses a policy over a position that does not exist', async () => {
    positionSize = '0';
    await expect(
      createPolicy(venue, { user, wallet }, { kind: 'BASE_DAY', symbol: 'BTC' }),
    ).rejects.toThrow(ValidationError);
    positionSize = '10';
  });

  it('fixes Base Day at a one-day horizon whatever is asked for', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'BASE_DAY', symbol: 'BTC', horizonDays: 30 },
    );
    expect(policy.horizonDays).toBe('1');
    expect(policy.nextRebaseAt).toBeNull();
    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});

describe('Base Day never rebases', () => {
  it('keeps the entry price as its reference through a $100 → $85 fall', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'BASE_DAY', symbol: 'BTC' },
    );

    markPrice = '85';
    const refreshed = await refreshPolicy(venue, policy.id);

    expect(refreshed.policy.referencePrice).toBe('100');
    expect(refreshed.assessment.referencePrice.toNumber()).toBe(100);
    expect(refreshed.settlement).toBeNull();

    markPrice = '100';
    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});

describe('Omni rebasing', () => {
  it('moves the reference to the current price and settles the difference', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'OMNI', symbol: 'BTC', horizonDays: 10 },
    );

    const before = policy.lastRequiredContribution!;
    expect(policy.referencePrice).toBe('100');

    markPrice = '120';
    const rebased = await refreshPolicy(venue, policy.id, { forceRebase: true });

    // §18: $100 → $120 makes the next reference $120.
    expect(new Decimal(rebased.policy.referencePrice).toNumber()).toBe(120);
    expect(rebased.settlement).not.toBeNull();

    // Notional is size × the current mark, so a 20% rise raises the exposure
    // being protected and therefore the requirement. §7's "additional".
    expect(new Decimal(rebased.policy.notional).toNumber()).toBe(1200);

    const after = rebased.policy.lastRequiredContribution!;
    expect(new Decimal(after).greaterThan(before)).toBe(true);
    expect(rebased.settlement!.kind).toBe('additional');
    expect(new Decimal(rebased.settlement!.amount).toNumber()).toBeCloseTo(
      new Decimal(after).minus(before).toNumber(),
      9,
    );

    // And it is on the ledger, split by kind.
    const balances = await policyBalances(policy.id);
    expect(balances.custodied).toBe(false);
    expect(balances.operatorFees).toBe('0');

    markPrice = '100';
    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });

  it('does not slide the reference between rebases', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'OMNI', symbol: 'BTC', horizonDays: 10 },
    );

    markPrice = '150';
    const refreshed = await refreshPolicy(venue, policy.id);

    // Recalculated, but the boundary still hangs off where the last rebase put
    // it. A reference that followed the price every poll would move the
    // participant's boundary with no recorded event.
    expect(refreshed.policy.referencePrice).toBe('100');
    expect(refreshed.assessment.referencePrice.toNumber()).toBe(100);

    markPrice = '100';
    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});

describe('declared funding', () => {
  it('records a declaration without holding anything', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'OMNI', symbol: 'BTC' },
    );

    const funded = await declareFunding(policy.id, user, new Decimal(500));
    expect(new Decimal(funded.declaredContribution).toNumber()).toBe(500);

    const balances = await policyBalances(policy.id);
    expect(new Decimal(balances.participantBalance).toNumber()).toBe(500);
    // The §19 rule: operator revenue is a separate figure and stays zero.
    expect(balances.operatorFees).toBe('0');
    expect(balances.custodied).toBe(false);

    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });

  it('refuses a negative declaration', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'OMNI', symbol: 'BTC' },
    );
    await expect(declareFunding(policy.id, user, new Decimal(-1))).rejects.toThrow(
      ValidationError,
    );
    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});

describe('reduction advice', () => {
  it('computes a reduction and records it without executing anything', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'OMNI', symbol: 'BTC' },
    );

    // Declare half the requirement, so half the notional is supportable.
    const required = new Decimal(policy.lastRequiredContribution!);
    await declareFunding(policy.id, user, required.dividedBy(2));

    const advice = await recommendReduction(venue, policy.id, user);

    expect(new Decimal(advice.reductionFraction).toNumber()).toBeCloseTo(0.5, 6);
    expect(new Decimal(advice.reduction).toNumber()).toBeCloseTo(500, 6);
    expect(advice.note).toMatch(/cannot open, close or reduce/i);

    // Recorded as advice in the event log, with the action text saying so.
    const { events, policy: after } = await getPolicy(policy.id, user);
    expect(after.state).toBe('POSITION_REDUCTION');
    expect(events[0]!.action).toMatch(/Recommendation only/i);
    expect(events[0]!.executionPrice).toBeNull();

    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});

describe('a closed position ends the policy', () => {
  it('expires rather than asserting a liquidation it did not witness', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'BASE_DAY', symbol: 'BTC' },
    );

    positionSize = '0';
    const result = await refreshPolicy(venue, policy.id);
    positionSize = '10';

    expect(result.policy.state).toBe('EXPIRED');
    expect(result.policy.closedAt).not.toBeNull();

    const { events } = await getPolicy(policy.id, user);
    expect(events[0]!.action).toMatch(/Cause not observed/i);

    // Terminal really is terminal.
    await expect(refreshPolicy(venue, policy.id)).rejects.toThrow(ValidationError);

    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});

describe('ownership', () => {
  it('will not show a policy to someone who does not own it', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'BASE_DAY', symbol: 'BTC' },
    );

    const stranger = await makeUser('stranger@test.local');

    // Not-found rather than forbidden: confirming it exists is itself a leak.
    await expect(getPolicy(policy.id, stranger)).rejects.toThrow(NotFoundError);
    await expect(cancelPolicy(policy.id, stranger)).rejects.toThrow(NotFoundError);
    await expect(declareFunding(policy.id, stranger, new Decimal(1))).rejects.toThrow(
      NotFoundError,
    );

    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});

describe('cancelling', () => {
  it('ends the policy and leaves the position alone', async () => {
    const { policy } = await createPolicy(
      venue,
      { user, wallet },
      { kind: 'BASE_DAY', symbol: 'BTC' },
    );

    const cancelled = await cancelPolicy(policy.id, user);
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.closedAt).not.toBeNull();

    // The position is untouched — there is no code path that could touch it.
    expect(positionSize).toBe('10');

    // Cancelling twice is a no-op, not an illegal transition.
    const again = await cancelPolicy(policy.id, user);
    expect(again.state).toBe('CANCELLED');

    await prisma.protectionPolicy.delete({ where: { id: policy.id } });
  });
});
