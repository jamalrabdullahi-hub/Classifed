import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money';
import { ValidationError } from '../src/domain/errors';
import { normalCdf, zScoreForPercentile } from '../src/protection/zscore';
import { calculatePeril } from '../src/protection/peril';
import {
  calculateExpectedLossPremium,
  calculateRepriceCredit,
  estimationWindowFor,
  firstHitProbability,
} from '../src/protection/expected-loss';

const D = (v: string | number) => new Decimal(v);

/** D for a policy, so the tests price the same thing the engine does. */
function moveFor(percentile: number, dailySigma: string, days: number) {
  return calculatePeril({
    referencePrice: D(100),
    side: 'LONG',
    dailySigma: D(dailySigma),
    horizonDays: D(days),
    z: zScoreForPercentile(percentile),
  }).statisticalMove;
}

describe('normal CDF', () => {
  it('matches known values', () => {
    // Abramowitz & Stegun 26.2.17 is accurate to 7.5e-8, so seven places is
    // the honest assertion; asserting nine would be testing luck.
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-2.5758293)).toBeCloseTo(0.005, 6);
  });

  it('inverts zScoreForPercentile', () => {
    for (const p of [0.6, 0.8, 0.95, 0.99, 0.999]) {
      expect(normalCdf(zScoreForPercentile(p).toNumber())).toBeCloseTo(p, 6);
    }
  });
});

describe('expected-loss premium', () => {
  it('reproduces the 180-day DCA case measured by Monte Carlo', () => {
    // 400,000 paths gave $171.24 on $10,000 at 95% cover, sigma 1.9%/day.
    const move = moveFor(0.95, '0.019', 180);
    const premium = calculateExpectedLossPremium({
      notional: D(10_000),
      statisticalMove: move,
      percentile: 0.95,
    });

    expect(premium.expectedLoss.toNumber()).toBeCloseTo(171.24, 1);
    expect(premium.reserveRatio.times(100).toNumber()).toBeCloseTo(1.71, 2);
    // Against 52.09% under the severity formula.
    expect(premium.severityEquivalent.dividedBy(100).toNumber()).toBeCloseTo(52.09, 1);
  });

  it('collapses to K = N(1-C)(1-e^-D) at the 50% share', () => {
    // The barrier's factor of two and the half share cancel exactly.
    for (const [percentile, sigma, days] of [
      [0.95, '0.019', 180],
      [0.997, '0.019', 30],
      [0.68, '0.0005', 365],
    ] as const) {
      const move = moveFor(percentile, sigma, days);
      const premium = calculateExpectedLossPremium({
        notional: D(10_000),
        statisticalMove: move,
        percentile,
      });

      const closedForm = D(10_000)
        .times(1 - percentile)
        .times(new Decimal(1).minus(move.negated().exp()));

      // Not exact to the last bit: the percentile arrives as a JS number, so
      // `1 - 0.95` carries float error into an otherwise exact computation.
      // 1e-9 on a figure of order $100 is far below a cent.
      expect(premium.expectedLoss.minus(closedForm).abs().toNumber()).toBeLessThan(1e-9);
    }
  });

  it('gets CHEAPER as the cover gets rarer — the inversion that was wrong before', () => {
    let previousExpected = Infinity;
    let previousSeverity = 0;

    for (const percentile of [0.68, 0.95, 0.997, 0.9999]) {
      const move = moveFor(percentile, '0.019', 180);
      const premium = calculateExpectedLossPremium({
        notional: D(10_000),
        statisticalMove: move,
        percentile,
      });

      // Expected loss falls as the event gets rarer...
      expect(premium.expectedLoss.toNumber()).toBeLessThan(previousExpected);
      // ...while the old severity reserve rose, which was the defect.
      expect(premium.severityEquivalent.toNumber()).toBeGreaterThan(previousSeverity);

      previousExpected = premium.expectedLoss.toNumber();
      previousSeverity = premium.severityEquivalent.toNumber();
    }
  });

  it('keeps the reserve inside a sane band where severity did not', () => {
    // 99.7% cover on a 180-day horizon: 0.15% of notional, against 101% before.
    const move = moveFor(0.997, '0.019', 180);
    const premium = calculateExpectedLossPremium({
      notional: D(10_000),
      statisticalMove: move,
      percentile: 0.997,
    });

    expect(premium.reserveRatio.times(100).toNumber()).toBeCloseTo(0.15, 2);
    expect(premium.severityEquivalent.dividedBy(10_000).toNumber()).toBeGreaterThan(1);
  });

  it('splits the loss at the peril between participant and pool', () => {
    const move = moveFor(0.95, '0.019', 30);
    const premium = calculateExpectedLossPremium({
      notional: D(10_000),
      statisticalMove: move,
      percentile: 0.95,
    });

    expect(premium.indemnity.plus(premium.reserveRestoration).equals(premium.lossAtPeril)).toBe(
      true,
    );
    expect(premium.indemnity.dividedBy(premium.lossAtPeril).toNumber()).toBeCloseTo(0.5, 12);
  });

  it('honours a different participant share', () => {
    const move = moveFor(0.95, '0.019', 30);
    const half = calculateExpectedLossPremium({
      notional: D(10_000),
      statisticalMove: move,
      percentile: 0.95,
    });
    const full = calculateExpectedLossPremium({
      notional: D(10_000),
      statisticalMove: move,
      percentile: 0.95,
      participantShare: D(1),
    });

    // A bigger share costs proportionally more and pays proportionally more.
    expect(full.expectedLoss.dividedBy(half.expectedLoss).toNumber()).toBeCloseTo(2, 12);
    expect(full.reserveRestoration.isZero()).toBe(true);
  });

  it('scales linearly in notional', () => {
    const move = moveFor(0.95, '0.019', 30);
    const a = calculateExpectedLossPremium({ notional: D(1_000), statisticalMove: move, percentile: 0.95 });
    const b = calculateExpectedLossPremium({ notional: D(50_000), statisticalMove: move, percentile: 0.95 });
    expect(b.expectedLoss.dividedBy(a.expectedLoss).toNumber()).toBeCloseTo(50, 12);
    expect(b.reserveRatio.equals(a.reserveRatio)).toBe(true);
  });

  it('refuses inputs that cannot be priced', () => {
    const move = moveFor(0.95, '0.019', 30);
    expect(() =>
      calculateExpectedLossPremium({ notional: D(-1), statisticalMove: move, percentile: 0.95 }),
    ).toThrow(ValidationError);
    expect(() =>
      calculateExpectedLossPremium({ notional: D(1), statisticalMove: move, percentile: 0.4 }),
    ).toThrow(ValidationError);
    expect(() =>
      calculateExpectedLossPremium({
        notional: D(1),
        statisticalMove: move,
        percentile: 0.95,
        participantShare: D(0),
      }),
    ).toThrow(ValidationError);
  });
});

describe('first-hit probability', () => {
  it('is the reflection principle: twice the one-tailed tail', () => {
    // A move of exactly D over horizon sigma has p = 2(1-C).
    const sigma = D('0.019').times(new Decimal(180).sqrt());
    const move = moveFor(0.95, '0.019', 180);
    const magnitude = new Decimal(1).minus(move.negated().exp());

    expect(firstHitProbability(magnitude, sigma).toNumber()).toBeCloseTo(0.1, 4);
  });

  it('answers the product question: same 10% fall, different windows', () => {
    // A 10% fall is near-impossible in five hours and likely over six weeks.
    const daily = D('0.019');
    const fiveHours = daily.times(new Decimal(5 / 24).sqrt());
    const sixWeeks = daily.times(new Decimal(42).sqrt());

    const fast = firstHitProbability(D('0.10'), fiveHours);
    const slow = firstHitProbability(D('0.10'), sixWeeks);

    expect(fast.toNumber()).toBeLessThan(0.0001);
    expect(slow.toNumber()).toBeGreaterThan(0.35);
    expect(slow.greaterThan(fast)).toBe(true);
  });

  it('rises with the window and falls with the magnitude', () => {
    const daily = D('0.019');
    let previous = 0;
    for (const days of [1, 7, 30, 90, 180]) {
      const p = firstHitProbability(D('0.10'), daily.times(new Decimal(days).sqrt())).toNumber();
      expect(p).toBeGreaterThan(previous);
      previous = p;
    }

    const sigma = daily.times(new Decimal(30).sqrt());
    let last = 1;
    for (const m of ['0.05', '0.10', '0.20', '0.40']) {
      const p = firstHitProbability(D(m), sigma).toNumber();
      expect(p).toBeLessThan(last);
      last = p;
    }
  });

  it('refuses a magnitude outside (0, 1)', () => {
    expect(() => firstHitProbability(D(0), D('0.1'))).toThrow(ValidationError);
    expect(() => firstHitProbability(D(1), D('0.1'))).toThrow(ValidationError);
  });
});

describe('mid-term repricing credit', () => {
  const base = {
    paidPremium: D(100),
    newPremium: D(30),
    horizonDays: D(180),
  };

  it('credits the unused part when switching to cheaper cover', () => {
    // Half-way through: $50 of the $100 is unearned, new cover costs $30.
    const result = calculateRepriceCredit({ ...base, elapsedDays: D(90) });
    expect(result.unearnedPremium.toNumber()).toBe(50);
    expect(result.credit.toNumber()).toBe(20);
    expect(result.direction).toBe('CREDIT');
  });

  it('refunds the whole premium when nothing has elapsed', () => {
    const result = calculateRepriceCredit({ ...base, newPremium: D(0), elapsedDays: D(0) });
    expect(result.unearnedPremium.toNumber()).toBe(100);
    expect(result.credit.toNumber()).toBe(100);
  });

  it('earns the premium pro rata, so late switching returns little', () => {
    let previous = Infinity;
    for (const elapsed of [0, 45, 90, 135, 180]) {
      const result = calculateRepriceCredit({ ...base, elapsedDays: D(elapsed) });
      expect(result.unearnedPremium.toNumber()).toBeLessThan(previous);
      previous = result.unearnedPremium.toNumber();
    }
    expect(previous).toBe(0);
  });

  it('blocks the timing attack: cover cannot be held then reclaimed in full', () => {
    // Hold through 80% of the window, then switch out. Only 20% comes back —
    // not the whole premium, which would make the risky period free.
    const result = calculateRepriceCredit({ ...base, newPremium: D(0), elapsedDays: D(144) });
    expect(result.unearnedPremium.toNumber()).toBeCloseTo(20, 9);
    expect(result.credit.toNumber()).toBeLessThan(base.paidPremium.toNumber());
  });

  it('asks for more when the replacement costs above the unused part', () => {
    const result = calculateRepriceCredit({
      ...base,
      newPremium: D(80),
      elapsedDays: D(90),
    });
    expect(result.direction).toBe('ADDITIONAL');
    expect(result.credit.toNumber()).toBe(-30);
  });

  it('never returns more than was paid, even past expiry', () => {
    const result = calculateRepriceCredit({ ...base, elapsedDays: D(400) });
    expect(result.elapsedFraction.toNumber()).toBe(1);
    expect(result.unearnedPremium.isZero()).toBe(true);
  });

  it('refuses impossible inputs', () => {
    expect(() => calculateRepriceCredit({ ...base, elapsedDays: D(-1) })).toThrow(ValidationError);
    expect(() => calculateRepriceCredit({ ...base, horizonDays: D(0), elapsedDays: D(1) })).toThrow(
      ValidationError,
    );
  });
});

describe('estimation window matched to the timeframe', () => {
  it('uses hourly bars for intraday perils and daily bars for multi-month ones', () => {
    expect(estimationWindowFor(1).interval).toBe('1h');
    expect(estimationWindowFor(5).interval).toBe('1h');
    expect(estimationWindowFor(30).interval).toBe('4h');
    expect(estimationWindowFor(180).interval).toBe('1d');
  });

  it('always spans several times the horizon it prices', () => {
    // A six-week deviation cannot be estimated from seven days of history,
    // however many bars that is.
    for (const days of [1, 3, 7, 14, 30, 90, 180, 365]) {
      const w = estimationWindowFor(days);
      expect(w.spanDays).toBeGreaterThanOrEqual(Math.min(days, 365));
      expect(w.window).toBeGreaterThan(100);
    }
  });

  it('refuses a non-positive horizon', () => {
    expect(() => estimationWindowFor(0)).toThrow(ValidationError);
    expect(() => estimationWindowFor(-5)).toThrow(ValidationError);
  });
});
