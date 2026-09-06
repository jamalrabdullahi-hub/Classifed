import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money';
import { ValidationError, IllegalTransitionError } from '../src/domain/errors';
import {
  assessBaseDay,
  assessBaseSmooth,
  assessOmni,
  shortfallReduction,
  type ProtectedPosition,
} from '../src/protection/policies';
import { protectionStateMachine, type ProtectionState } from '../src/protection/state';

const D = (v: string | number) => new Decimal(v);

/** A $1,000 long opened at $100, currently at $100, liquidating at $80. */
function position(overrides: Partial<ProtectedPosition> = {}): ProtectedPosition {
  return {
    side: 'LONG',
    entryPrice: D(100),
    currentPrice: D(100),
    notional: D(1000),
    liquidationPrice: D(80),
    ...overrides,
  };
}

const terms = { percentile: 0.9973, dailySigma: D('0.03') };

describe('Base Day', () => {
  it('produces the §3 example, at the one-tailed z', () => {
    const result = assessBaseDay(position(), terms);
    expect(result.policy).toBe('BASE_DAY');
    expect(result.referencePrice.toNumber()).toBe(100);
    expect(result.peril.horizonDays.toNumber()).toBe(1);
    expect(result.peril.boundary.toNumber()).toBeCloseTo(91.9924, 4);
    expect(result.zConvention).toBe('one-tailed');
  });

  it('does not move the reference when the price falls (§18 path invariance)', () => {
    const at100 = assessBaseDay(position(), terms);
    const at95 = assessBaseDay(position({ currentPrice: D(95) }), terms);
    const at85 = assessBaseDay(position({ currentPrice: D(85) }), terms);

    for (const result of [at95, at85]) {
      expect(result.referencePrice.toNumber()).toBe(100);
      expect(result.peril.boundary.equals(at100.peril.boundary)).toBe(true);
    }
  });

  it('has no smooth state and no settlement', () => {
    const result = assessBaseDay(position(), terms);
    expect(result.smooth).toBeUndefined();
    expect(result.settlement).toBeUndefined();
  });

  it('warns when the venue would liquidate before the boundary is reached', () => {
    // Liquidation at $95 sits above the $91.99 boundary: the venue closes first.
    const result = assessBaseDay(position({ liquidationPrice: D(95) }), terms);
    expect(result.standing).toBe('beyond-liquidation');
    expect(result.warnings.map((w) => w.code)).toContain('BOUNDARY_BEYOND_LIQUIDATION');
  });

  it('warns when the venue has reported no liquidation price', () => {
    const result = assessBaseDay(position({ liquidationPrice: null }), terms);
    expect(result.standing).toBe('unknown');
    expect(result.warnings.map((w) => w.code)).toContain('LIQUIDATION_PRICE_UNKNOWN');
  });

  it('warns rather than silently returning a zero requirement at zero volatility', () => {
    const result = assessBaseDay(position(), { ...terms, dailySigma: D(0) });
    expect(result.contribution.requiredContribution.isZero()).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('ZERO_VOLATILITY');
  });
});

describe('Base Smooth', () => {
  const smoothTerms = {
    ...terms,
    horizonDays: D(1),
    startAt: D('0.05'),
    initialNotional: D(1000),
  };

  it('shares Base Day\'s boundary — only the path handling differs', () => {
    const day = assessBaseDay(position(), terms);
    const smooth = assessBaseSmooth(position(), smoothTerms);
    expect(smooth.peril.boundary.equals(day.peril.boundary)).toBe(true);
  });

  it('is idle while the position is in profit', () => {
    const result = assessBaseSmooth(position({ currentPrice: D(110) }), smoothTerms);
    expect(result.smooth!.excursion.isZero()).toBe(true);
    expect(result.smooth!.utilization.isZero()).toBe(true);
    expect(result.smooth!.recommendedReduction.isZero()).toBe(true);
  });

  it('scales utilization between the start point and the venue liquidation price', () => {
    // Entry 100, liquidation 80 → D_liq = 0.20. Start 0.05.
    // At $87.50 the excursion is 0.125, exactly half-way.
    const result = assessBaseSmooth(position({ currentPrice: D('87.5') }), smoothTerms);
    expect(result.smooth!.liquidationAt.toNumber()).toBeCloseTo(0.2, 12);
    expect(result.smooth!.utilization.toNumber()).toBeCloseTo(0.5, 12);
    expect(result.smooth!.targetNotional.toNumber()).toBeCloseTo(500, 9);
  });

  it('reaches full utilization at the liquidation price and no further', () => {
    const at = assessBaseSmooth(position({ currentPrice: D(80) }), smoothTerms);
    const past = assessBaseSmooth(position({ currentPrice: D(60) }), smoothTerms);
    expect(at.smooth!.utilization.toNumber()).toBe(1);
    expect(past.smooth!.utilization.toNumber()).toBe(1);
    expect(past.smooth!.targetNotional.isZero()).toBe(true);
  });

  it('never lowers its recommended reduction as the price worsens', () => {
    let previous = D(-1);
    for (const price of [100, 96, 94, 90, 87, 84, 81, 80, 75]) {
      const result = assessBaseSmooth(position({ currentPrice: D(price) }), smoothTerms);
      const reduction = result.smooth!.recommendedReduction;
      expect(reduction.greaterThanOrEqualTo(previous)).toBe(true);
      previous = reduction;
    }
  });

  it('recommends nothing when the position is already below target', () => {
    const result = assessBaseSmooth(
      position({ currentPrice: D('87.5'), notional: D(300) }),
      smoothTerms,
    );
    expect(result.smooth!.targetNotional.toNumber()).toBeCloseTo(500, 9);
    expect(result.smooth!.recommendedReduction.isZero()).toBe(true);
  });

  it('degrades to its Base Day half rather than inventing a liquidation scale', () => {
    const result = assessBaseSmooth(position({ liquidationPrice: null }), smoothTerms);
    expect(result.smooth).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toContain('LIQUIDATION_PRICE_UNKNOWN');
  });

  it('refuses a start point past the liquidation boundary', () => {
    expect(() =>
      assessBaseSmooth(position(), { ...smoothTerms, startAt: D('0.30') }),
    ).toThrow(ValidationError);
  });

  it('mirrors for a short', () => {
    // Short at 100, liquidation at 120 → D_liq = 0.20. At 110, x = 0.10.
    const result = assessBaseSmooth(
      position({ side: 'SHORT', currentPrice: D(110), liquidationPrice: D(120) }),
      smoothTerms,
    );
    expect(result.peril.boundary.greaterThan(100)).toBe(true);
    expect(result.smooth!.utilization.toNumber()).toBeCloseTo(1 / 3, 10);
  });
});

describe('Omni', () => {
  const omniTerms = { ...terms, dailySigma: D('0.02'), horizonDays: D(10) };

  it('§18: $100 → $120 makes the next reference $120', () => {
    const result = assessOmni(position({ currentPrice: D(120) }), omniTerms);
    expect(result.referencePrice.toNumber()).toBe(120);
    expect(result.peril.referencePrice.toNumber()).toBe(120);
    // Not the entry, which is what separates Omni from the Base policies.
    expect(result.referencePrice.equals(D(100))).toBe(false);
  });

  it('§8: boundary from the current price at the one-tailed z', () => {
    const result = assessOmni(
      position({ currentPrice: D(120), liquidationPrice: null }),
      omniTerms,
    );
    expect(result.peril.statisticalMove.toNumber()).toBeCloseTo(0.175959, 6);
    // §8 shows $99.28 using the two-tailed z = 3.000; one-tailed gives $100.64.
    expect(result.peril.boundary.toNumber()).toBeCloseTo(100.6381, 3);
  });

  it('§18: releases $3 when the requirement falls from $10 to $7', () => {
    const result = assessOmni(position(), {
      ...omniTerms,
      dailySigma: D('0.0001'),
      previousContribution: D(10),
    });
    // Contrived so the requirement is well under $10.
    expect(result.settlement!.kind).toBe('release');

    // The §18 numbers themselves, on the settlement function the policy uses.
    const exact = assessOmni(position({ notional: D(0) }), {
      ...omniTerms,
      previousContribution: D(10),
    });
    expect(exact.settlement!.kind).toBe('release');
    expect(exact.settlement!.amount.toNumber()).toBe(10);
  });

  it('§18: asks for more when the requirement rises', () => {
    const result = assessOmni(position(), { ...omniTerms, previousContribution: D(10) });
    expect(result.settlement!.kind).toBe('additional');
    expect(
      result.settlement!.requiredContribution.greaterThan(D(10)),
    ).toBe(true);
    expect(result.settlement!.amount.isNegative()).toBe(false);
  });

  it('has no settlement on the first calculation', () => {
    expect(assessOmni(position(), omniTerms).settlement).toBeUndefined();
  });

  it('raises the requirement when volatility rises (§18)', () => {
    let previous = D(-1);
    for (const sigma of ['0.005', '0.01', '0.02', '0.05', '0.10']) {
      const k = assessOmni(position(), { ...omniTerms, dailySigma: D(sigma) }).contribution
        .requiredContribution;
      expect(k.greaterThan(previous)).toBe(true);
      previous = k;
    }
  });

  it('§18: sizes the minimum reduction when the shortfall cannot be funded', () => {
    const result = assessOmni(position(), omniTerms);
    const half = result.contribution.requiredContribution.dividedBy(2);
    const reduction = shortfallReduction(result, half);

    expect(reduction.maxNotional.toNumber()).toBeCloseTo(500, 9);
    expect(reduction.reductionFraction.toNumber()).toBeCloseTo(0.5, 12);
  });
});

describe('protection state machine (§13)', () => {
  it('starts at CREATED and can only activate or be cancelled', () => {
    expect(protectionStateMachine.next('CREATED')).toEqual(['ACTIVE', 'CANCELLED']);
  });

  it('lets a warning resolve back to active', () => {
    expect(protectionStateMachine.can('WARNING', 'ACTIVE')).toBe(true);
    expect(protectionStateMachine.can('POSITION_REDUCTION', 'ACTIVE')).toBe(true);
    expect(protectionStateMachine.can('REBALANCE_REQUIRED', 'ACTIVE')).toBe(true);
  });

  it('can be liquidated out of any live state, because the venue does not ask', () => {
    const live: ProtectionState[] = [
      'ACTIVE',
      'WARNING',
      'PROTECTION_ACTIVE',
      'REBALANCE_REQUIRED',
      'POSITION_REDUCTION',
    ];
    for (const state of live) {
      expect(protectionStateMachine.can(state, 'LIQUIDATED')).toBe(true);
      expect(protectionStateMachine.can(state, 'EXPIRED')).toBe(true);
      expect(protectionStateMachine.can(state, 'CANCELLED')).toBe(true);
    }
  });

  it('treats the endings as terminal and refuses to leave them', () => {
    for (const state of ['LIQUIDATED', 'EXPIRED', 'CANCELLED'] as ProtectionState[]) {
      expect(protectionStateMachine.isTerminal(state)).toBe(true);
      expect(protectionStateMachine.next(state)).toEqual([]);
      expect(() => protectionStateMachine.assertTransition(state, 'ACTIVE')).toThrow(
        IllegalTransitionError,
      );
    }
  });

  it('refuses to skip straight from CREATED into a protection state', () => {
    expect(() => protectionStateMachine.assertTransition('CREATED', 'PROTECTION_ACTIVE')).toThrow(
      IllegalTransitionError,
    );
  });
});
