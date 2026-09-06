import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money';
import { ValidationError } from '../src/domain/errors';
import { inverseNormalCdf, zScoreForPercentile, Z_CONVENTION } from '../src/protection/zscore';
import {
  HistoricalStdDev,
  toDailySigma,
  INTERVAL_DAYS,
} from '../src/protection/volatility';
import {
  adverseExcursion,
  boundaryStanding,
  calculatePeril,
  protectionUtilization,
} from '../src/protection/peril';
import {
  calculateContribution,
  impliedVolatilityModifier,
  rebaseSettlement,
  requiredReduction,
} from '../src/protection/contribution';
import type { Candle } from '../src/ports/history';

/**
 * The mathematics, per §14: every function unit-tested, every §18 case present.
 *
 * Two of the spec's own figures are superseded here and the tests say so
 * explicitly rather than quietly asserting the new number — a reader comparing
 * the suite against the document has to be able to see which figures moved and
 * why.
 */

const D = (v: string | number) => new Decimal(v);

describe('z-score', () => {
  // The five rows of §2's table that are genuinely one-tailed quantiles.
  // These match Φ⁻¹ exactly and are the reason we can trust the approximation.
  it.each([
    [0.9, 1.281552],
    [0.95, 1.644854],
    [0.99, 2.326348],
    [0.999, 3.090232],
    [0.9999, 3.719016],
  ])('matches the spec table at %s', (percentile, expected) => {
    expect(zScoreForPercentile(percentile).toNumber()).toBeCloseTo(expected, 5);
  });

  it('is one-tailed, so 99.73% gives 2.7822 rather than the spec table\'s 3.000', () => {
    // §2 lists 3.000 for 99.73%, which is the two-tailed 3σ figure. For a
    // one-sided downside boundary the correct quantile is Φ⁻¹(0.9973).
    expect(Z_CONVENTION).toBe('one-tailed');
    expect(zScoreForPercentile(0.9973).toNumber()).toBeCloseTo(2.782155, 5);
  });

  it('is symmetric about the median', () => {
    expect(inverseNormalCdf(0.25)).toBeCloseTo(-inverseNormalCdf(0.75), 9);
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 12);
  });

  it('increases with the percentile', () => {
    let previous = -Infinity;
    for (const p of [0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 0.999, 0.99999]) {
      const z = inverseNormalCdf(p);
      expect(z).toBeGreaterThan(previous);
      previous = z;
    }
  });

  it('refuses a percentile that would put the boundary above the reference', () => {
    expect(() => zScoreForPercentile(0.5)).toThrow(ValidationError);
    expect(() => zScoreForPercentile(0.4)).toThrow(ValidationError);
    expect(() => zScoreForPercentile(1)).toThrow(ValidationError);
  });
});

describe('volatility', () => {
  /** Candles whose closes follow a fixed sequence, spaced one day apart. */
  function candles(closes: number[]): Candle[] {
    return closes.map((close, i) => ({
      time: i * 86_400,
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
    }));
  }

  const model = new HistoricalStdDev();

  it('computes the sample standard deviation of log returns', () => {
    // Closes chosen so the four log returns are exactly ±ln(1.1) alternating,
    // giving mean 0 and, with Bessel's correction, σ = ln(1.1)·√(4/3).
    const closes = [100, 110, 100, 110, 100];
    const estimate = model.calculate(candles(closes), 5, 1);

    expect(estimate.observations).toBe(4);
    expect(estimate.meanLogReturn.toNumber()).toBeCloseTo(0, 12);
    expect(estimate.sigma.toNumber()).toBeCloseTo(Math.log(1.1) * Math.sqrt(4 / 3), 12);
    expect(estimate.model).toBe('historical-stddev');
  });

  it('reports zero volatility for a flat series', () => {
    const estimate = model.calculate(candles([50, 50, 50, 50]), 4, 1);
    expect(estimate.sigma.isZero()).toBe(true);
  });

  it('removes drift rather than counting it as volatility', () => {
    // A perfectly constant 2%/day trend has zero volatility of log returns.
    const closes = [100, 102, 104.04, 106.1208, 108.243216];
    const estimate = model.calculate(candles(closes), 5, 1);
    expect(estimate.sigma.toNumber()).toBeCloseTo(0, 10);
    expect(estimate.meanLogReturn.toNumber()).toBeCloseTo(Math.log(1.02), 10);
  });

  it('refuses a window longer than the history rather than silently shortening it', () => {
    expect(() => model.calculate(candles([1, 2, 3]), 90, 1)).toThrow(ValidationError);
  });

  it('refuses a non-positive close', () => {
    expect(() => model.calculate(candles([100, 0, 100, 100]), 4, 1)).toThrow(ValidationError);
  });

  it('rescales an hourly sigma to a daily one by root-time', () => {
    const hourly = model.calculate(candles([100, 110, 100, 110, 100]), 5, INTERVAL_DAYS['1h']!);
    // σ_daily = σ_hourly / √(1/24) = σ_hourly · √24
    expect(toDailySigma(hourly).toNumber()).toBeCloseTo(
      Math.log(1.1) * Math.sqrt(4 / 3) * Math.sqrt(24),
      10,
    );
  });
});

describe('peril', () => {
  const z = zScoreForPercentile(0.9973);

  it('Base Day: $100 entry, 3% daily sigma, 99.73% one-tailed', () => {
    // §3 and §18 give $91.39, which used the two-tailed z = 3.000.
    // One-tailed z = 2.782155 gives D = 0.0834647 and B = $91.99.
    const peril = calculatePeril({
      referencePrice: D(100),
      side: 'LONG',
      dailySigma: D('0.03'),
      horizonDays: D(1),
      z,
    });

    expect(peril.statisticalMove.toNumber()).toBeCloseTo(0.0834647, 6);
    expect(peril.boundary.toNumber()).toBeCloseTo(91.9924, 4);
    expect(peril.zConvention).toBe('one-tailed');
  });

  it('uses the log-return form, not P·(1−D)', () => {
    const peril = calculatePeril({
      referencePrice: D(100),
      side: 'LONG',
      dailySigma: D('0.03'),
      horizonDays: D(1),
      z,
    });
    const linear = D(100).times(D(1).minus(peril.statisticalMove));
    // exp(−D) > 1 − D, so the log form is always the less aggressive boundary.
    expect(peril.boundary.greaterThan(linear)).toBe(true);
  });

  it('scales by root-time, not linearly in T', () => {
    const one = calculatePeril({
      referencePrice: D(100),
      side: 'LONG',
      dailySigma: D('0.02'),
      horizonDays: D(1),
      z,
    });
    const ten = calculatePeril({
      referencePrice: D(100),
      side: 'LONG',
      dailySigma: D('0.02'),
      horizonDays: D(10),
      z,
    });
    expect(ten.statisticalMove.dividedBy(one.statisticalMove).toNumber()).toBeCloseTo(
      Math.sqrt(10),
      10,
    );
  });

  it('§8 Omni: the reference is the current price, not the entry', () => {
    // Entry was $100 and the price is now $120. The boundary is anchored to 120.
    const peril = calculatePeril({
      referencePrice: D(120),
      side: 'LONG',
      dailySigma: D('0.02'),
      horizonDays: D(10),
      z,
    });
    expect(peril.referencePrice.toNumber()).toBe(120);
    // §8 shows $99.28 using z = 3.000; one-tailed gives D = 0.175959, B = $100.64.
    expect(peril.statisticalMove.toNumber()).toBeCloseTo(0.175959, 6);
    expect(peril.boundary.toNumber()).toBeCloseTo(100.6381, 3);
  });

  it('puts the boundary below the reference for a long and above it for a short', () => {
    for (const sigma of ['0.005', '0.03', '0.2', '1.5']) {
      const long = calculatePeril({
        referencePrice: D(100),
        side: 'LONG',
        dailySigma: D(sigma),
        horizonDays: D(3),
        z,
      });
      const short = calculatePeril({
        referencePrice: D(100),
        side: 'SHORT',
        dailySigma: D(sigma),
        horizonDays: D(3),
        z,
      });
      expect(long.boundary.lessThan(100)).toBe(true);
      expect(long.boundary.isPositive()).toBe(true);
      expect(short.boundary.greaterThan(100)).toBe(true);
    }
  });

  it('refuses inputs that cannot produce a boundary', () => {
    const base = {
      referencePrice: D(100),
      side: 'LONG' as const,
      dailySigma: D('0.03'),
      horizonDays: D(1),
      z,
    };
    expect(() => calculatePeril({ ...base, referencePrice: D(0) })).toThrow(ValidationError);
    expect(() => calculatePeril({ ...base, dailySigma: D(-1) })).toThrow(ValidationError);
    expect(() => calculatePeril({ ...base, horizonDays: D(0) })).toThrow(ValidationError);
    expect(() => calculatePeril({ ...base, z: D(0) })).toThrow(ValidationError);
  });

  describe('standing against the venue liquidation price', () => {
    const long = calculatePeril({
      referencePrice: D(100),
      side: 'LONG',
      dailySigma: D('0.03'),
      horizonDays: D(1),
      z,
    });

    it('is ahead when the boundary is hit before liquidation', () => {
      expect(boundaryStanding(long, D(80))).toBe('ahead-of-liquidation');
    });

    it('is beyond when the venue would liquidate first, making protection illusory', () => {
      expect(boundaryStanding(long, D(95))).toBe('beyond-liquidation');
    });

    it('is unknown when the venue has not reported one', () => {
      expect(boundaryStanding(long, null)).toBe('unknown');
    });

    it('mirrors the comparison for a short', () => {
      const short = calculatePeril({
        referencePrice: D(100),
        side: 'SHORT',
        dailySigma: D('0.03'),
        horizonDays: D(1),
        z,
      });
      expect(boundaryStanding(short, D(120))).toBe('ahead-of-liquidation');
      expect(boundaryStanding(short, D(105))).toBe('beyond-liquidation');
    });
  });
});

describe('Base Day path invariance (§18)', () => {
  it('keeps $100 as the reference through $100 → $95 → $85', () => {
    // Base Day is entry-anchored and never rebased. The boundary computed at
    // entry is the boundary at every later price, so recomputing it at each
    // step with the same entry must give the same number.
    const z = zScoreForPercentile(0.9973);
    const entry = D(100);
    const boundaries = [100, 95, 85].map(
      () =>
        calculatePeril({
          referencePrice: entry,
          side: 'LONG',
          dailySigma: D('0.03'),
          horizonDays: D(1),
          z,
        }).boundary,
    );

    for (const b of boundaries) {
      expect(b.equals(boundaries[0]!)).toBe(true);
      expect(b.toNumber()).toBeCloseTo(91.9924, 4);
    }
    // And emphatically not moved to 95 or 85.
    expect(boundaries[0]!.toNumber()).not.toBeCloseTo(95, 0);
    expect(boundaries[0]!.toNumber()).not.toBeCloseTo(85, 0);
  });
});

describe('Base Smooth utilization (§4, §18)', () => {
  const start = D('0.02');
  const liq = D('0.10');

  it('is zero before protection begins and one at the liquidation boundary', () => {
    expect(protectionUtilization(D(0), start, liq).toNumber()).toBe(0);
    expect(protectionUtilization(D('0.02'), start, liq).toNumber()).toBe(0);
    expect(protectionUtilization(D('0.10'), start, liq).toNumber()).toBe(1);
    expect(protectionUtilization(D('0.50'), start, liq).toNumber()).toBe(1);
  });

  it('is exactly half-way at the mid-point', () => {
    expect(protectionUtilization(D('0.06'), start, liq).toNumber()).toBeCloseTo(0.5, 12);
  });

  it('never decreases as the adverse excursion worsens', () => {
    let previous = D(-1);
    for (let x = 0; x <= 0.15; x += 0.001) {
      const u = protectionUtilization(D(x.toFixed(4)), start, liq);
      expect(u.greaterThanOrEqualTo(previous)).toBe(true);
      expect(u.greaterThanOrEqualTo(0)).toBe(true);
      expect(u.lessThanOrEqualTo(1)).toBe(true);
      previous = u;
    }
  });

  it('refuses a start point at or beyond the liquidation boundary', () => {
    expect(() => protectionUtilization(D('0.05'), D('0.10'), D('0.10'))).toThrow(ValidationError);
    expect(() => protectionUtilization(D('0.05'), D('0.12'), D('0.10'))).toThrow(ValidationError);
  });

  it('treats favourable movement as no excursion at all', () => {
    expect(adverseExcursion(D(100), D(120), 'LONG').toNumber()).toBe(0);
    expect(adverseExcursion(D(100), D(85), 'LONG').toNumber()).toBeCloseTo(0.15, 12);
    expect(adverseExcursion(D(100), D(85), 'SHORT').toNumber()).toBe(0);
    expect(adverseExcursion(D(100), D(120), 'SHORT').toNumber()).toBeCloseTo(0.2, 12);
  });

  it('reduces the target notional in proportion to utilization', () => {
    // N_target = N_initial · (1 − U)
    const initial = D(1000);
    const u = protectionUtilization(D('0.06'), start, liq);
    expect(initial.times(D(1).minus(u)).toNumber()).toBeCloseTo(500, 9);
  });
});

describe('contribution', () => {
  it('uses §6 exp(D)−1, not §15\'s linear N·D', () => {
    // §15's example response shows 189.70 on notional 1000 with D = 0.1897.
    // §6's formula gives exp(0.1897) − 1 = 0.2088869, so $208.89. §6 wins;
    // the difference is 10.1%.
    const result = calculateContribution({
      notional: D(1000),
      statisticalMove: D('0.1897'),
    });
    expect(result.statisticalRisk.toNumber()).toBeCloseTo(0.2088869, 7);
    expect(result.requiredContribution.toNumber()).toBeCloseTo(208.8869, 4);
    expect(result.requiredContribution.toNumber()).not.toBeCloseTo(189.7, 1);
  });

  it('always collects more than the linear approximation, for every D > 0', () => {
    for (const d of ['0.0001', '0.01', '0.0834647', '0.1897', '0.5', '1.2', '3']) {
      const move = D(d);
      const risk = calculateContribution({ notional: D(1), statisticalMove: move })
        .statisticalRisk;
      expect(risk.greaterThan(move)).toBe(true);
    }
  });

  it('requires nothing at zero volatility', () => {
    const result = calculateContribution({ notional: D(1000), statisticalMove: D(0) });
    expect(result.requiredContribution.isZero()).toBe(true);
  });

  it('scales linearly in notional at fixed D', () => {
    const one = calculateContribution({ notional: D(1000), statisticalMove: D('0.1') });
    const ten = calculateContribution({ notional: D(10_000), statisticalMove: D('0.1') });
    expect(ten.requiredContribution.dividedBy(one.requiredContribution).toNumber()).toBeCloseTo(
      10,
      12,
    );
  });

  it('rising volatility never decreases the requirement (§18)', () => {
    const z = zScoreForPercentile(0.9973);
    let previous = D(-1);
    for (let sigma = 0; sigma <= 0.5; sigma += 0.005) {
      const peril = calculatePeril({
        referencePrice: D(100),
        side: 'LONG',
        dailySigma: D(sigma.toFixed(4)),
        horizonDays: D(1),
        z,
      });
      const k = calculateContribution({
        notional: D(1000),
        statisticalMove: peril.statisticalMove,
      }).requiredContribution;
      expect(k.greaterThanOrEqualTo(previous)).toBe(true);
      previous = k;
    }
  });

  it('keeps each modifier separately visible and multiplies them into K', () => {
    const result = calculateContribution({
      notional: D(1000),
      statisticalMove: D('0.1'),
      modifiers: { iv: D('1.2'), gap: D('1.05') },
    });

    expect(result.modifiers.iv.toNumber()).toBe(1.2);
    expect(result.modifiers.liquidity.toNumber()).toBe(1);
    expect(result.modifiers.gap.toNumber()).toBe(1.05);
    expect(result.modifiers.tail.toNumber()).toBe(1);
    expect(result.combinedModifier.toNumber()).toBeCloseTo(1.26, 12);
    expect(result.requiredContribution.toNumber()).toBeCloseTo(
      result.baseContribution.times(1.26).toNumber(),
      12,
    );
  });

  it('refuses a modifier below 1 unless that is configured deliberately', () => {
    expect(() =>
      calculateContribution({
        notional: D(1000),
        statisticalMove: D('0.1'),
        modifiers: { tail: D('0.5') },
      }),
    ).toThrow(ValidationError);

    const permitted = calculateContribution({
      notional: D(1000),
      statisticalMove: D('0.1'),
      modifiers: { tail: D('0.5') },
      allowReducingModifiers: true,
    });
    expect(permitted.combinedModifier.toNumber()).toBe(0.5);
  });

  it('adds for implied volatility above historical and never subtracts below it', () => {
    // §10's example: HV 30%, IV 45% → ratio 1.5.
    const beta = D('0.5');
    expect(impliedVolatilityModifier(D('0.30'), D('0.45'), beta).toNumber()).toBeCloseTo(1.25, 12);
    expect(impliedVolatilityModifier(D('0.30'), D('0.30'), beta).toNumber()).toBe(1);
    expect(impliedVolatilityModifier(D('0.30'), D('0.10'), beta).toNumber()).toBe(1);
  });
});

describe('rebasing settlement (§7, §18)', () => {
  it('releases $3 when the requirement falls from $10 to $7', () => {
    const settlement = rebaseSettlement(D(10), D(7));
    expect(settlement.kind).toBe('release');
    expect(settlement.amount.toNumber()).toBe(3);
  });

  it('asks for $3 more when the requirement rises from $10 to $13', () => {
    const settlement = rebaseSettlement(D(10), D(13));
    expect(settlement.kind).toBe('additional');
    expect(settlement.amount.toNumber()).toBe(3);
  });

  it('is unchanged when the requirement does not move', () => {
    const settlement = rebaseSettlement(D(10), D(10));
    expect(settlement.kind).toBe('unchanged');
    expect(settlement.amount.isZero()).toBe(true);
  });

  it('never reports a negative amount, so direction can only come from the kind', () => {
    for (const [previous, required] of [
      [10, 7],
      [7, 10],
      [0, 5],
      [5, 0],
    ] as const) {
      expect(rebaseSettlement(D(previous), D(required)).amount.isNegative()).toBe(false);
    }
  });
});

describe('minimum position reduction (§18)', () => {
  const contribution = calculateContribution({
    notional: D(1000),
    statisticalMove: D('0.1897'),
  });

  it('computes the largest notional the available capital supports', () => {
    // K required is $208.89 on $1,000. With exactly half of that available,
    // exactly half the position can be protected.
    const half = contribution.requiredContribution.dividedBy(2);
    const reduction = requiredReduction(contribution, half);
    expect(reduction.maxNotional.toNumber()).toBeCloseTo(500, 9);
    expect(reduction.reduction.toNumber()).toBeCloseTo(500, 9);
    expect(reduction.reductionFraction.toNumber()).toBeCloseTo(0.5, 12);
  });

  it('requires no reduction when the contribution already covers the position', () => {
    const reduction = requiredReduction(contribution, D(500));
    expect(reduction.reduction.isZero()).toBe(true);
    expect(reduction.maxNotional.toNumber()).toBe(1000);
  });

  it('requires closing everything when nothing is available', () => {
    const reduction = requiredReduction(contribution, D(0));
    expect(reduction.maxNotional.isZero()).toBe(true);
    expect(reduction.reductionFraction.toNumber()).toBe(1);
  });

  it('accounts for the modifiers when sizing the reduction', () => {
    const modified = calculateContribution({
      notional: D(1000),
      statisticalMove: D('0.1897'),
      modifiers: { tail: D(2) },
    });
    // Twice the requirement per unit, so the same capital supports half as much.
    const half = contribution.requiredContribution.dividedBy(2);
    expect(requiredReduction(modified, half).maxNotional.toNumber()).toBeCloseTo(250, 9);
  });

  it('asks for no reduction at zero volatility, where nothing is required', () => {
    const flat = calculateContribution({ notional: D(1000), statisticalMove: D(0) });
    expect(requiredReduction(flat, D(0)).reduction.isZero()).toBe(true);
  });
});
