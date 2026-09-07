import { randomBytes } from 'node:crypto';
import { SubscriptionTier, type SubscriptionPlan } from '@flt/db';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  process.env.PERP_MAX_LEVERAGE ??= '10';
});

const {
  applyFeeDiscount,
  assertHas,
  assertLeverageAllowed,
  assertWithinLimit,
  fromPlan,
  maxLeverageFor,
  withinLimit,
} = await import('../src/services/entitlements');
const { ForbiddenError } = await import('../src/domain/errors');

function plan(overrides: Partial<SubscriptionPlan> = {}): SubscriptionPlan {
  return {
    tier: SubscriptionTier.PRO,
    name: 'FLT Pro',
    tagline: 'Active trader',
    priceUsd: '9.99',
    isFeatured: true,
    isAvailable: true,
    feeDiscountBps: 1_000,
    watchlistLimit: 25,
    priceAlertLimit: 50,
    historyDays: 365,
    advancedOrderTools: true,
    fullIndicators: true,
    advancedRiskAnalytics: true,
    advancedProtectionAnalytics: true,
    fundingAnalytics: true,
    advancedPnl: true,
    fullPnl: false,
    apiAccess: false,
    priorityData: true,
    prioritySupport: false,
    maxLeverage: 20,
    updatedAt: new Date(),
    updatedById: null,
    ...overrides,
  } as SubscriptionPlan;
}

describe('fee discount', () => {
  it('discounts the fee, not the notional', () => {
    // 25% off a 25 bps fee is 18 bps (18.75 floored), not 25 bps minus a
    // quarter of the trade — which would pay the trader to trade.
    expect(applyFeeDiscount(25, 2_500)).toBe(18);
    expect(applyFeeDiscount(25, 1_000)).toBe(22);
    expect(applyFeeDiscount(100, 2_500)).toBe(75);
  });

  it('rounds down, so the discount is never smaller than advertised', () => {
    // 10% off 25 bps is 22.5; the trader gets 22, not 23.
    expect(applyFeeDiscount(25, 1_000)).toBe(22);
    expect(applyFeeDiscount(1, 5_000)).toBe(0);
  });

  it('is a no-op without a discount', () => {
    expect(applyFeeDiscount(25, 0)).toBe(25);
    expect(applyFeeDiscount(25, -100)).toBe(25);
  });

  it('cannot produce a negative fee', () => {
    expect(applyFeeDiscount(25, 20_000)).toBe(0);
    expect(applyFeeDiscount(25, 10_000)).toBe(0);
  });
});

describe('leverage gate', () => {
  it('caps a free account at 2x', () => {
    const free = fromPlan(SubscriptionTier.FREE, null, null);
    expect(free.maxLeverage).toBe(2);

    expect(() => assertLeverageAllowed(free, 2)).not.toThrow();
    expect(() => assertLeverageAllowed(free, 3)).toThrow(ForbiddenError);
  });

  it('lets a paid plan past 2x', () => {
    const pro = fromPlan(SubscriptionTier.PRO, plan(), null);
    expect(() => assertLeverageAllowed(pro, 10)).not.toThrow();
  });

  it('never exceeds the platform cap, however generous the plan', () => {
    // The plan says 20x; PERP_MAX_LEVERAGE says 10. The lower wins.
    const pro = fromPlan(SubscriptionTier.PRO, plan({ maxLeverage: 20 }), null);
    expect(pro.maxLeverage).toBe(10);
    expect(() => assertLeverageAllowed(pro, 15)).toThrow(ForbiddenError);
  });

  it('never exceeds the venue cap either', () => {
    const pro = fromPlan(SubscriptionTier.PRO, plan(), null);
    // A venue listing this market at 5x beats both other ceilings.
    expect(maxLeverageFor(pro, 5)).toBe(5);
    expect(maxLeverageFor(pro, 40)).toBe(10);
  });

  it('always permits at least 1x', () => {
    const free = fromPlan(SubscriptionTier.FREE, null, null);
    expect(maxLeverageFor(free, 0)).toBe(1);
    expect(() => assertLeverageAllowed(free, 1)).not.toThrow();
  });

  it('says what the account may actually do, not just that it refused', () => {
    const free = fromPlan(SubscriptionTier.FREE, null, null);
    expect(() => assertLeverageAllowed(free, 10)).toThrow(/up to 2x/);
  });
});

describe('feature gates', () => {
  it('refuses a feature the plan does not include', () => {
    const pro = fromPlan(SubscriptionTier.PRO, plan(), null);
    expect(() => assertHas(pro, 'advancedRiskAnalytics')).not.toThrow();
    expect(() => assertHas(pro, 'apiAccess')).toThrow(ForbiddenError);
  });

  it('grants nothing when no plan row exists', () => {
    // A deployment that has not seeded plans must not accidentally hand out
    // paid features, so the fallback is deliberately mean.
    const missing = fromPlan(SubscriptionTier.ELITE, null, null);
    expect(() => assertHas(missing, 'apiAccess')).toThrow(ForbiddenError);
    expect(missing.feeDiscountBps).toBe(0);
  });

  it('names the feature rather than only refusing', () => {
    const pro = fromPlan(SubscriptionTier.PRO, plan(), null);
    expect(() => assertHas(pro, 'apiAccess')).toThrow(/API access/);
  });
});

describe('limits', () => {
  it('permits exactly the advertised count and refuses the next', () => {
    // A limit of 5 means five items, not four and not six.
    expect(withinLimit(5, 4)).toBe(true);
    expect(withinLimit(5, 5)).toBe(false);
    expect(() => assertWithinLimit(5, 4, 'watchlists')).not.toThrow();
    expect(() => assertWithinLimit(5, 5, 'watchlists')).toThrow(ForbiddenError);
  });

  it('treats null as unlimited', () => {
    expect(withinLimit(null, 10_000)).toBe(true);
    expect(() => assertWithinLimit(null, 10_000, 'alerts')).not.toThrow();
  });

  it('treats zero as off', () => {
    expect(withinLimit(0, 0)).toBe(false);
  });
});

describe('the published ladder', () => {
  it('gives each tier a distinct discount and ceiling', () => {
    const basic = fromPlan(
      SubscriptionTier.BASIC,
      plan({ tier: SubscriptionTier.BASIC, feeDiscountBps: 0, maxLeverage: 5 }),
      null,
    );
    const pro = fromPlan(
      SubscriptionTier.PRO,
      plan({ feeDiscountBps: 1_000, maxLeverage: 20 }),
      null,
    );
    const elite = fromPlan(
      SubscriptionTier.ELITE,
      plan({ tier: SubscriptionTier.ELITE, feeDiscountBps: 2_500, maxLeverage: 50 }),
      null,
    );

    expect(basic.feeDiscountBps).toBeLessThan(pro.feeDiscountBps);
    expect(pro.feeDiscountBps).toBeLessThan(elite.feeDiscountBps);

    // On a 25 bps fee the ladder is 25 / 22 / 18 bps.
    expect(applyFeeDiscount(25, basic.feeDiscountBps)).toBe(25);
    expect(applyFeeDiscount(25, pro.feeDiscountBps)).toBe(22);
    expect(applyFeeDiscount(25, elite.feeDiscountBps)).toBe(18);
  });
});
