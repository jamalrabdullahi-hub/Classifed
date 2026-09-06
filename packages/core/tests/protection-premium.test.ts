import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money';
import { ValidationError } from '../src/domain/errors';
import { calculateContribution } from '../src/protection/contribution';
import { calculatePeril } from '../src/protection/peril';
import { zScoreForPercentile } from '../src/protection/zscore';
import {
  calculatePremium,
  contractsForUsd,
  waterfallLeverageBound,
  DEFAULT_OPERATOR_FEE_BPS,
} from '../src/protection/premium';
import { estimateLiquidationPrice, maintenanceMarginFraction } from '../src/domain/perps';

const D = (v: string | number) => new Decimal(v);

describe('premium', () => {
  const contribution = calculateContribution({
    notional: D(1000),
    statisticalMove: D('0.1'),
  });

  it('charges the operator fee on top of the contribution, not out of it', () => {
    const premium = calculatePremium(contribution, 1_000);

    // exp(0.1) − 1 = 0.10517, so K = $105.17 on $1,000.
    expect(premium.contribution.toNumber()).toBeCloseTo(105.1709, 4);
    expect(premium.operatorFee.toNumber()).toBeCloseTo(10.5171, 4);
    expect(premium.totalPremium.toNumber()).toBeCloseTo(115.688, 3);

    // The pool keeps the full K. Deducting the fee would leave it short of
    // what the mathematics says it needs.
    expect(premium.contribution.equals(contribution.requiredContribution)).toBe(true);
    expect(premium.totalPremium.minus(premium.operatorFee).equals(premium.contribution)).toBe(
      true,
    );
  });

  it('defaults to 10%', () => {
    expect(DEFAULT_OPERATOR_FEE_BPS).toBe(1_000);
    const premium = calculatePremium(contribution);
    expect(premium.operatorFee.dividedBy(premium.contribution).toNumber()).toBeCloseTo(0.1, 12);
  });

  it('keeps the two amounts separately visible', () => {
    const premium = calculatePremium(contribution, 1_000);
    // The total is never the only number available — a caller can always say
    // which part is risk capital and which is revenue.
    expect(premium.contribution.plus(premium.operatorFee).equals(premium.totalPremium)).toBe(true);
  });

  it('reports the total as a rate on notional', () => {
    const premium = calculatePremium(contribution, 1_000);
    expect(premium.rateOnNotional.times(100).toNumber()).toBeCloseTo(11.5688, 3);
  });

  it('handles a zero fee and refuses an absurd one', () => {
    expect(calculatePremium(contribution, 0).totalPremium.equals(contribution.requiredContribution)).toBe(
      true,
    );
    expect(() => calculatePremium(contribution, 5_001)).toThrow(ValidationError);
    expect(() => calculatePremium(contribution, -1)).toThrow(ValidationError);
    expect(() => calculatePremium(contribution, 12.5)).toThrow(ValidationError);
  });

  it('scales linearly with notional', () => {
    const bigger = calculateContribution({ notional: D(10_000), statisticalMove: D('0.1') });
    const a = calculatePremium(contribution);
    const b = calculatePremium(bigger);
    expect(b.totalPremium.dividedBy(a.totalPremium).toNumber()).toBeCloseTo(10, 12);
    expect(b.rateOnNotional.equals(a.rateOnNotional)).toBe(true);
  });
});

describe('the waterfall bound', () => {
  const z = zScoreForPercentile(0.9973);

  const VENUE_MAX = 40;

  function perilAt(side: 'LONG' | 'SHORT', dailySigma: string, days: number) {
    return calculatePeril({
      referencePrice: D(100),
      side,
      dailySigma: D(dailySigma),
      horizonDays: D(days),
      z,
    });
  }

  /**
   * Does insurance actually fire before the venue liquidates, at this leverage?
   *
   * Null when the venue has no liquidation price to compare against — a 1x long
   * cannot be liquidated by any price above zero, so the waterfall holds
   * trivially and there is nothing to test.
   */
  function insuranceFirst(
    leverage: number,
    side: 'LONG' | 'SHORT',
    dailySigma: string,
    days: number,
  ): boolean | null {
    const peril = perilAt(side, dailySigma, days);
    const liquidation = estimateLiquidationPrice({
      side,
      entryPrice: '100',
      leverage,
      maxLeverage: VENUE_MAX,
    });
    if (!liquidation) return null;

    return side === 'LONG'
      ? peril.boundary.greaterThan(liquidation)
      : peril.boundary.lessThan(liquidation);
  }

  it('permits exactly the leverages where insurance fires first, and no more', () => {
    const mmf = new Decimal(maintenanceMarginFraction(VENUE_MAX));

    for (const side of ['LONG', 'SHORT'] as const) {
      for (const sigma of ['0.005', '0.02', '0.05']) {
        for (const days of [1, 10]) {
          const peril = perilAt(side, sigma, days);
          const limit = waterfallLeverageBound(peril.statisticalMove, mmf, side).maxWholeLeverage;

          // At the bound the waterfall still holds...
          const at = insuranceFirst(limit, side, sigma, days);
          if (at !== null) expect(at).toBe(true);

          // ...and one notch above it, it does not. That is what makes this a
          // bound rather than a conservative guess. Skipped where the next
          // notch exceeds what the venue would accept anyway.
          if (limit + 1 <= VENUE_MAX) {
            expect(insuranceFirst(limit + 1, side, sigma, days)).toBe(false);
          }
        }
      }
    }
  });

  it('loosens as volatility falls, because liquidation may sit closer to entry', () => {
    // Lower σ puts the boundary nearer entry, which sounds tighter — but the
    // constraint is that liquidation must sit *below* the boundary, and a
    // nearer boundary is easier to clear at high leverage, not harder. So the
    // permitted leverage rises as σ falls, toward the 1/mmf ceiling.
    const mmf = D('0.0125');
    let previous = 0;
    for (const sigma of ['0.05', '0.03', '0.02', '0.01', '0.005']) {
      const peril = perilAt('LONG', sigma, 1);
      const bound = waterfallLeverageBound(peril.statisticalMove, mmf, 'LONG').maxLeverage;
      expect(bound.toNumber()).toBeGreaterThan(previous);
      previous = bound.toNumber();
    }
    // Never past the ceiling the maintenance requirement itself imposes.
    expect(previous).toBeLessThanOrEqual(1 / 0.0125);
  });

  it('is what actually bites at the leverage people trade', () => {
    // BTC at roughly 1.9%/day, the figure measured against live Hyperliquid.
    const mmf = new Decimal(maintenanceMarginFraction(VENUE_MAX));

    const oneDay = perilAt('LONG', '0.019', 1);
    const tenDay = perilAt('LONG', '0.019', 10);

    // A one-day Base policy leaves room for meaningful leverage.
    expect(
      waterfallLeverageBound(oneDay.statisticalMove, mmf, 'LONG').maxWholeLeverage,
    ).toBeGreaterThan(10);

    // A ten-day Omni horizon does not: the boundary is far enough from entry
    // that only low leverage keeps liquidation below it.
    expect(
      waterfallLeverageBound(tenDay.statisticalMove, mmf, 'LONG').maxWholeLeverage,
    ).toBeLessThan(10);
  });

  it('never permits less than 1x', () => {
    const bound = waterfallLeverageBound(D('2.5'), D('0.0125'), 'LONG');
    expect(bound.maxWholeLeverage).toBeGreaterThanOrEqual(1);
  });

  it('refuses a nonsensical maintenance fraction', () => {
    expect(() => waterfallLeverageBound(D('0.1'), D(1), 'LONG')).toThrow(ValidationError);
    expect(() => waterfallLeverageBound(D('0.1'), D(-0.1), 'LONG')).toThrow(ValidationError);
    expect(() => waterfallLeverageBound(D(-1), D('0.0125'), 'LONG')).toThrow(ValidationError);
  });

  it('is asymmetric between long and short, because liquidation is', () => {
    const mmf = D('0.0125');
    const move = D('0.05');
    const long = waterfallLeverageBound(move, mmf, 'LONG').maxLeverage;
    const short = waterfallLeverageBound(move, mmf, 'SHORT').maxLeverage;
    // A short's loss is unbounded above, so the same D permits slightly less
    // leverage. Equal bounds would mean one side's arithmetic was wrong.
    expect(short.lessThan(long)).toBe(true);
  });
});

describe('sizing in dollars', () => {
  it('converts USD to contracts at the stated price', () => {
    expect(contractsForUsd(D(1000), D(80_000), 5).toNumber()).toBeCloseTo(0.0125, 9);
    expect(contractsForUsd(D(1000), D(3), 2).toNumber()).toBe(333.33);
  });

  it('rounds down, never up', () => {
    // 1000 / 79_999 = 0.01250015…, which must not become 0.0126.
    const contracts = contractsForUsd(D(1000), D(79_999), 4);
    expect(contracts.toNumber()).toBe(0.0125);
    expect(contracts.times(79_999).lessThanOrEqualTo(1000)).toBe(true);
  });

  it('never builds a position worth more than the dollars approved', () => {
    for (const usd of [10, 137.42, 1000, 99_999.99]) {
      for (const price of [0.00031, 3.5, 79_999.13]) {
        const contracts = contractsForUsd(D(usd), D(price), 4);
        expect(contracts.times(price).lessThanOrEqualTo(usd)).toBe(true);
      }
    }
  });

  it('refuses a non-positive price', () => {
    expect(() => contractsForUsd(D(1000), D(0), 4)).toThrow(ValidationError);
    expect(() => contractsForUsd(D(-1), D(100), 4)).toThrow(ValidationError);
  });
});
