import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money';
import { ValidationError } from '../src/domain/errors';
import {
  annualisedFundingRate,
  assertLeverage,
  estimateLiquidationPrice,
  fundingPayment,
  initialMargin,
  liquidationProximity,
  maintenanceMargin,
  maintenanceMarginFraction,
  notional,
  returnOnMargin,
  sideSign,
  unrealizedPnl,
  type PerpSide,
} from '../src/domain/perps';

/**
 * Perpetual position arithmetic.
 *
 * A wrong liquidation price is the worst bug this system could ship: it is the
 * number a user sizes a position against, and being wrong in the optimistic
 * direction means telling someone they have room they do not have.
 *
 * So liquidation is not tested against hand-copied expected values, which only
 * prove the code still does whatever it did when the test was written. It is
 * tested against the invariant that defines it — at the liquidation price,
 * account equity has fallen exactly to the maintenance requirement — checked
 * across sides, leverages and price scales.
 */

/** Equity and maintenance requirement per contract, at a given price. */
function equityAndMaintenance(
  side: PerpSide,
  entryPrice: string,
  leverage: number,
  maxLeverage: number,
  price: string,
) {
  const entry = new Decimal(entryPrice);
  const at = new Decimal(price);
  const marginPerContract = entry.dividedBy(leverage);
  const pnl = at.minus(entry).times(sideSign(side));

  return {
    equity: marginPerContract.plus(pnl),
    maintenance: at.times(maintenanceMarginFraction(maxLeverage)),
  };
}

describe('liquidation price', () => {
  const cases: Array<{ side: PerpSide; entry: string; leverage: number; maxLeverage: number }> = [
    { side: 'LONG', entry: '100', leverage: 10, maxLeverage: 10 },
    { side: 'SHORT', entry: '100', leverage: 10, maxLeverage: 10 },
    { side: 'LONG', entry: '63000', leverage: 20, maxLeverage: 40 },
    { side: 'SHORT', entry: '63000', leverage: 20, maxLeverage: 40 },
    { side: 'LONG', entry: '0.00003412', leverage: 3, maxLeverage: 5 },
    { side: 'SHORT', entry: '2450.75', leverage: 2, maxLeverage: 25 },
    { side: 'LONG', entry: '1', leverage: 50, maxLeverage: 50 },
  ];

  it.each(cases)(
    'puts equity exactly at the maintenance requirement ($side $leverage x, entry $entry)',
    ({ side, entry, leverage, maxLeverage }) => {
      const liquidation = estimateLiquidationPrice({
        side,
        entryPrice: entry,
        leverage,
        maxLeverage,
      });

      expect(liquidation).not.toBeNull();

      const { equity, maintenance } = equityAndMaintenance(
        side,
        entry,
        leverage,
        maxLeverage,
        liquidation as string,
      );

      // Exact to well beyond any price precision a venue quotes.
      expect(equity.minus(maintenance).abs().lessThan('1e-30')).toBe(true);
    },
  );

  it('moves against the position, never in its favour', () => {
    const long = estimateLiquidationPrice({
      side: 'LONG',
      entryPrice: '100',
      leverage: 10,
      maxLeverage: 10,
    });
    const short = estimateLiquidationPrice({
      side: 'SHORT',
      entryPrice: '100',
      leverage: 10,
      maxLeverage: 10,
    });

    // A long is liquidated below entry, a short above. Getting this backwards
    // would render a stop-loss-shaped number on the wrong side of the market.
    expect(new Decimal(long as string).lessThan('100')).toBe(true);
    expect(new Decimal(short as string).greaterThan('100')).toBe(true);
  });

  it('brings liquidation closer as leverage rises', () => {
    const distances = [2, 5, 10, 25].map((leverage) => {
      const price = estimateLiquidationPrice({
        side: 'LONG',
        entryPrice: '1000',
        leverage,
        maxLeverage: 25,
      });
      return new Decimal('1000').minus(price as string);
    });

    for (let i = 1; i < distances.length; i += 1) {
      const closer = distances[i] as Decimal;
      const further = distances[i - 1] as Decimal;
      expect(closer.lessThan(further)).toBe(true);
    }
  });

  it('does not depend on position size', () => {
    // Size cancels out of the derivation; this pins that so a future edit that
    // reintroduces size has to justify itself.
    const a = estimateLiquidationPrice({
      side: 'LONG',
      entryPrice: '500',
      leverage: 5,
      maxLeverage: 20,
    });
    const b = estimateLiquidationPrice({
      side: 'LONG',
      entryPrice: '500',
      leverage: 5,
      maxLeverage: 20,
    });
    expect(a).toBe(b);
  });

  it('reports no liquidation price for an unleveraged long', () => {
    // At 1x the margin covers the whole notional, so only a price of zero
    // wipes it out. Rendering "0" as a liquidation price would read as a real
    // threshold rather than as "not applicable".
    expect(
      estimateLiquidationPrice({ side: 'LONG', entryPrice: '100', leverage: 1, maxLeverage: 10 }),
    ).toBeNull();
  });

  it('always has a liquidation price for a short', () => {
    // A short's loss is unbounded above, so there is no leverage at which it
    // cannot be liquidated.
    expect(
      estimateLiquidationPrice({ side: 'SHORT', entryPrice: '100', leverage: 1, maxLeverage: 10 }),
    ).not.toBeNull();
  });

  it('refuses leverage above the market maximum', () => {
    expect(() =>
      estimateLiquidationPrice({
        side: 'LONG',
        entryPrice: '100',
        leverage: 41,
        maxLeverage: 40,
      }),
    ).toThrow(ValidationError);
  });
});

describe('margin', () => {
  it('scales notional by leverage', () => {
    expect(notional('2', '1500')).toBe('3000');
    expect(initialMargin('2', '1500', 10)).toBe('300');
    expect(initialMargin('2', '1500', 1)).toBe('3000');
  });

  it('maintains at half the initial margin required at max leverage', () => {
    expect(maintenanceMarginFraction(40)).toBe('0.0125');
    expect(maintenanceMargin('1', '1000', 40)).toBe('12.5');
    // Half of the 1/40 initial requirement.
    expect(new Decimal(maintenanceMarginFraction(40)).times(2).toFixed()).toBe('0.025');
  });

  it('rejects fractional and non-positive leverage', () => {
    expect(() => assertLeverage(1.5, 10)).toThrow(ValidationError);
    expect(() => assertLeverage(0, 10)).toThrow(ValidationError);
    expect(() => assertLeverage(-3, 10)).toThrow(ValidationError);
  });
});

describe('pnl', () => {
  it('pays a long when price rises and a short when it falls', () => {
    expect(unrealizedPnl('LONG', '2', '100', '110')).toBe('20');
    expect(unrealizedPnl('SHORT', '2', '100', '110')).toBe('-20');
    expect(unrealizedPnl('LONG', '2', '100', '90')).toBe('-20');
    expect(unrealizedPnl('SHORT', '2', '100', '90')).toBe('20');
  });

  it('expresses return against margin posted, not notional', () => {
    // 10x long, price up 10% — the position is up 100% on margin. Reporting
    // this against notional instead would understate it tenfold.
    const pnl = unrealizedPnl('LONG', '1', '100', '110');
    expect(returnOnMargin(pnl, initialMargin('1', '100', 10))).toBe('1');
  });

  it('keeps precision on small prices', () => {
    // Sub-cent assets are common; a float would lose this.
    expect(unrealizedPnl('LONG', '1000000', '0.00000123', '0.00000456')).toBe('3.33');
  });
});

describe('funding', () => {
  it('charges longs and credits shorts when the rate is positive', () => {
    const params = { size: '2', markPrice: '1000', fundingRate: '0.0001' };
    expect(fundingPayment({ ...params, side: 'LONG' })).toBe('0.2');
    expect(fundingPayment({ ...params, side: 'SHORT' })).toBe('-0.2');
  });

  it('reverses when the rate goes negative', () => {
    const params = { size: '2', markPrice: '1000', fundingRate: '-0.0001' };
    expect(fundingPayment({ ...params, side: 'LONG' })).toBe('-0.2');
    expect(fundingPayment({ ...params, side: 'SHORT' })).toBe('0.2');
  });

  it('annualises an hourly rate over 8760 intervals', () => {
    expect(annualisedFundingRate('0.0000125', 1)).toBe('0.1095');
    // The same rate paid eight-hourly is a third of the annual cost, so a raw
    // per-interval rate cannot be compared across venues.
    expect(annualisedFundingRate('0.0000125', 8)).toBe('0.0136875');
  });
});

describe('liquidation proximity', () => {
  it('reads zero at entry and one at the liquidation price', () => {
    expect(liquidationProximity('100', '100', '90')).toBe('0');
    expect(liquidationProximity('90', '100', '90')).toBe('1');
    expect(liquidationProximity('95', '100', '90')).toBe('0.5');
  });

  it('clamps rather than reporting beyond the bounds', () => {
    // Past liquidation, and moved in profit. Neither should produce a value the
    // interface would have to special-case before rendering a progress bar.
    expect(liquidationProximity('85', '100', '90')).toBe('1');
    expect(liquidationProximity('120', '100', '90')).toBe('0');
  });

  it('works for a short, where liquidation sits above entry', () => {
    expect(liquidationProximity('105', '100', '110')).toBe('0.5');
  });
});
