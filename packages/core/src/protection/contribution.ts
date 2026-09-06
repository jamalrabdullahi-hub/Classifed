import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';

/**
 * Layer 2 of §17: how much protection capital is required.
 *
 * Strictly separate from layer 1. The peril calculator says the price could
 * move D; this says what that costs to protect against. Nothing here reads a
 * price, and nothing in `peril.ts` reads a notional.
 *
 * ## The formula, and the spec's contradiction
 *
 * §6 defines the statistical base risk as
 *
 *     R_stat = exp(z · σ · √T) − 1 = exp(D) − 1
 *
 * §15's worked response instead shows `requiredContribution: 189.70` on
 * notional 1000 with D = 0.1897 — which is the linear `N · D`. The two differ:
 * exp(0.1897) − 1 = 0.208931, so §6 gives **$208.93** where §15 shows $189.70,
 * 10.1% apart.
 *
 * **§6 wins**, as a documented substitution. Three reasons: it is the stated
 * formula rather than an example's arithmetic; `exp(D) − 1 > D` for all D > 0,
 * so it collects slightly more, which is the correct direction to err for a
 * fund that pays claims; and it is the only form consistent with the log-return
 * boundary the rest of the spec insists on — the linear figure is a first-order
 * approximation to it.
 *
 * ## Modifiers
 *
 * Kept as four separate named factors rather than one blended number, because
 * §6 requires each be individually visible and an auditor cannot verify a
 * product they cannot decompose. Each defaults to 1 — an honest identity — and
 * stays there until a real data source exists. A fabricated IV adjustment would
 * be worse than none.
 */

export interface ContributionModifiers {
  /** §10 — implied vs historical volatility. */
  iv: Decimal;
  /** Market depth at the size being protected. */
  liquidity: Decimal;
  /** Overnight/weekend gap risk the diffusion model does not capture. */
  gap: Decimal;
  /** §11 — empirical tail heaviness beyond the Gaussian assumption. */
  tail: Decimal;
}

export const NO_MODIFIERS: ContributionModifiers = {
  iv: new Decimal(1),
  liquidity: new Decimal(1),
  gap: new Decimal(1),
  tail: new Decimal(1),
};

export interface ContributionInputs {
  /** Protected notional, in USD. */
  notional: Decimal;
  /** D = z·σ·√T, from the peril calculator. */
  statisticalMove: Decimal;
  modifiers?: Partial<ContributionModifiers>;
  /**
   * Permits a modifier below 1, which reduces the requirement. Off by default:
   * §6 says modifiers are ≥ 1 "unless explicitly configured otherwise", and a
   * discount that arrives by accident is a solvency hole.
   */
  allowReducingModifiers?: boolean;
}

export interface Contribution {
  notional: Decimal;
  statisticalMove: Decimal;
  /** R_stat = exp(D) − 1. */
  statisticalRisk: Decimal;
  /** K_stat = N · R_stat, before modifiers. */
  baseContribution: Decimal;
  modifiers: ContributionModifiers;
  /** The four modifiers multiplied together, shown so the product is checkable. */
  combinedModifier: Decimal;
  /** K = K_stat · M_IV · M_liquidity · M_gap · M_tail. */
  requiredContribution: Decimal;
}

export function calculateContribution(inputs: ContributionInputs): Contribution {
  const { notional, statisticalMove } = inputs;

  if (!notional.isFinite() || notional.isNegative()) {
    throw new ValidationError('Protected notional must be non-negative', {
      notional: notional.toString(),
    });
  }
  if (!statisticalMove.isFinite() || statisticalMove.isNegative()) {
    throw new ValidationError('Statistical move must be non-negative', {
      statisticalMove: statisticalMove.toString(),
    });
  }

  const modifiers: ContributionModifiers = {
    ...NO_MODIFIERS,
    ...inputs.modifiers,
  };

  for (const [name, value] of Object.entries(modifiers)) {
    if (!value.isFinite() || value.lessThanOrEqualTo(0)) {
      throw new ValidationError(`Modifier ${name} must be a positive number`, {
        [name]: value.toString(),
      });
    }
    if (!inputs.allowReducingModifiers && value.lessThan(1)) {
      throw new ValidationError(
        `Modifier ${name} is below 1, which would reduce the required contribution. ` +
          'Set allowReducingModifiers to permit this deliberately.',
        { [name]: value.toString() },
      );
    }
  }

  const statisticalRisk = statisticalMove.exp().minus(1);
  const baseContribution = notional.times(statisticalRisk);
  const combinedModifier = modifiers.iv
    .times(modifiers.liquidity)
    .times(modifiers.gap)
    .times(modifiers.tail);

  return {
    notional,
    statisticalMove,
    statisticalRisk,
    baseContribution,
    modifiers,
    combinedModifier,
    requiredContribution: baseContribution.times(combinedModifier),
  };
}

// ── §10: implied volatility ─────────────────────────────────────────────────

/**
 * M_IV = 1 + β · max(0, IV/HV − 1).
 *
 * One-sided by construction: IV above historical raises the requirement, IV
 * below it does not lower it. §10's instruction not to substitute IV for
 * historical volatility is the point — both measurements stay available and IV
 * only ever adds.
 */
export function impliedVolatilityModifier(
  historicalVolatility: Decimal,
  impliedVolatility: Decimal,
  beta: Decimal,
): Decimal {
  if (historicalVolatility.lessThanOrEqualTo(0)) {
    throw new ValidationError('Historical volatility must be positive to form a ratio', {
      historicalVolatility: historicalVolatility.toString(),
    });
  }
  const excess = impliedVolatility.dividedBy(historicalVolatility).minus(1);
  return excess.isPositive() ? new Decimal(1).plus(beta.times(excess)) : new Decimal(1);
}

// ── §7: rebasing settlement ─────────────────────────────────────────────────

export type SettlementKind = 'release' | 'additional' | 'unchanged';

export interface RebaseSettlement {
  kind: SettlementKind;
  previousContribution: Decimal;
  requiredContribution: Decimal;
  /** Always non-negative. Read together with `kind`, which gives it direction. */
  amount: Decimal;
}

/**
 * A discriminated result rather than a signed delta, so no caller can mistake
 * the direction of a number that moves participant money. §7's own examples:
 * 10 → 7 releases 3; 10 → 13 requires an additional 3.
 */
export function rebaseSettlement(
  previousContribution: Decimal,
  requiredContribution: Decimal,
): RebaseSettlement {
  const delta = requiredContribution.minus(previousContribution);
  const kind: SettlementKind = delta.isZero()
    ? 'unchanged'
    : delta.isNegative()
      ? 'release'
      : 'additional';

  return {
    kind,
    previousContribution,
    requiredContribution,
    amount: delta.abs(),
  };
}

// ── §18: minimum position reduction ─────────────────────────────────────────

/**
 * The smallest protected notional that the available capital can support.
 *
 * K scales linearly in N at fixed D, so N_max = K_available / (R_stat · M). Used
 * when a participant cannot fund a shortfall: the engine computes the reduction
 * and *tells them*. It does not execute it — no key exists server-side that
 * could, and pretending otherwise would be the most dangerous lie in the system.
 */
export interface ReductionRequirement {
  /** The largest notional the available contribution covers. */
  maxNotional: Decimal;
  /** Current notional − maxNotional, floored at zero. */
  reduction: Decimal;
  /** The fraction of the position that must be closed, in [0, 1]. */
  reductionFraction: Decimal;
}

export function requiredReduction(
  contribution: Contribution,
  availableContribution: Decimal,
): ReductionRequirement {
  const perUnit = contribution.statisticalRisk.times(contribution.combinedModifier);

  if (perUnit.lessThanOrEqualTo(0)) {
    // Zero volatility, so no contribution is required at any size.
    return {
      maxNotional: contribution.notional,
      reduction: new Decimal(0),
      reductionFraction: new Decimal(0),
    };
  }

  const uncapped = availableContribution.dividedBy(perUnit);
  const maxNotional = Decimal.min(uncapped, contribution.notional);
  const reduction = contribution.notional.minus(maxNotional);

  return {
    maxNotional,
    reduction,
    reductionFraction: contribution.notional.isZero()
      ? new Decimal(0)
      : reduction.dividedBy(contribution.notional),
  };
}
