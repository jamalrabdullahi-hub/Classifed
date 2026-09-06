import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import type { PerpSide } from '../domain/perps';
import { zScoreForPercentile, Z_CONVENTION, type ZConvention } from './zscore';
import {
  adverseExcursion,
  boundaryStanding,
  calculatePeril,
  protectionUtilization,
  type BoundaryStanding,
  type Peril,
} from './peril';
import {
  calculateContribution,
  rebaseSettlement,
  requiredReduction,
  type Contribution,
  type ContributionModifiers,
  type RebaseSettlement,
  type ReductionRequirement,
} from './contribution';

/**
 * The three policies, as one framework.
 *
 * They differ in exactly two respects and nothing else:
 *
 * |             | reference price | path-aware |
 * |-------------|-----------------|------------|
 * | Base Day    | entry, fixed    | no         |
 * | Base Smooth | entry, fixed    | yes        |
 * | Omni        | current, rebased| no         |
 *
 * Everything downstream — D, B, R_stat, K — is the same arithmetic in all
 * three. Writing them as three variations on one evaluator rather than three
 * implementations is what makes the framework claim in the spec's final
 * requirement true rather than aspirational.
 *
 * ## Advisory only
 *
 * §4 and §7 describe automatic position reduction. This engine computes the
 * reduction and reports it; it does not execute it. That is not an omission to
 * be filled in later — no key capable of acting on a position exists on the
 * server. The agent key that can submit an order is generated in the browser
 * and never transmitted, so automatic reduction is impossible by construction,
 * and every field named `...Reduction` here is a recommendation to the
 * participant, who holds the only key that can act.
 *
 * Likewise, no contribution is held. `requiredContribution` is what protection
 * *would* cost. Nothing is collected, nothing is released, and no claim can be
 * paid, because the pool that would pay it does not exist yet.
 */

export type ProtectionPolicyKind = 'BASE_DAY' | 'BASE_SMOOTH' | 'OMNI';

/** The position facts every policy reads. Deliberately not a database row. */
export interface ProtectedPosition {
  side: PerpSide;
  /** Entry price, which Base policies anchor to permanently. */
  entryPrice: Decimal;
  /** Latest underlying price. */
  currentPrice: Decimal;
  /** Protected notional in USD. Position size × price — not margin. */
  notional: Decimal;
  /** The venue's own liquidation price, when it has reported one. */
  liquidationPrice: Decimal | null;
}

export interface PolicyTerms {
  /** e.g. 0.9973. Read one-tailed — see `zscore.ts`. */
  percentile: number;
  /** Protection horizon, in days. Base Day is fixed at 1. */
  horizonDays: Decimal;
  /** Per-day standard deviation of log returns. */
  dailySigma: Decimal;
  modifiers?: Partial<ContributionModifiers>;
}

export interface PolicyAssessment {
  policy: ProtectionPolicyKind;
  /** The price the boundary is anchored to. Entry for Base, current for Omni. */
  referencePrice: Decimal;
  z: Decimal;
  zConvention: ZConvention;
  percentile: number;
  peril: Peril;
  contribution: Contribution;
  /** Whether the venue would liquidate before the boundary is reached. */
  standing: BoundaryStanding;
  /** Warnings a caller must surface. Empty is the normal case. */
  warnings: PolicyWarning[];
  /** Present only for Base Smooth. */
  smooth?: SmoothState;
  /** Present only for Omni, and only when a previous requirement is known. */
  settlement?: RebaseSettlement;
}

export interface SmoothState {
  /** x_t — adverse excursion from entry, clipped at zero. */
  excursion: Decimal;
  /** D_start — where progressive protection begins. */
  startAt: Decimal;
  /** D_liq — the adverse move that reaches the venue's liquidation price. */
  liquidationAt: Decimal;
  /** U_t in [0, 1]. */
  utilization: Decimal;
  /** N_target = N_initial · (1 − U). */
  targetNotional: Decimal;
  /** N_current − N_target, floored at zero. Advisory — see the module note. */
  recommendedReduction: Decimal;
}

export type PolicyWarningCode =
  | 'BOUNDARY_BEYOND_LIQUIDATION'
  | 'LIQUIDATION_PRICE_UNKNOWN'
  | 'ZERO_VOLATILITY';

export interface PolicyWarning {
  code: PolicyWarningCode;
  message: string;
}

// ── Base Day ────────────────────────────────────────────────────────────────

/**
 * Entry-anchored, one day, unsmoothed.
 *
 * The reference is the entry price and is never moved, whatever the price does
 * afterwards (§3). `currentPrice` is read only to describe where the position
 * stands, never to shift the boundary.
 */
export function assessBaseDay(
  position: ProtectedPosition,
  terms: Omit<PolicyTerms, 'horizonDays'>,
): PolicyAssessment {
  return assessAnchored('BASE_DAY', position, {
    ...terms,
    horizonDays: new Decimal(1),
  });
}

// ── Base Smooth ─────────────────────────────────────────────────────────────

export interface SmoothTerms extends PolicyTerms {
  /**
   * The adverse excursion at which progressive protection begins, as a
   * fraction. Below it there is no intervention at all.
   */
  startAt: Decimal;
  /** Notional at the time the policy was written, for N_target. */
  initialNotional: Decimal;
}

/**
 * Entry-anchored, path-aware, progressive.
 *
 * The boundary arithmetic is Base Day's. What is added is utilization: where
 * the position sits between `startAt` and the venue's liquidation price, and
 * therefore how much of it the policy says should be closed.
 *
 * D_liq is derived from the **venue's** liquidation price, not from our own
 * boundary — the venue is the thing that will actually close the position, and
 * a utilization scaled to a boundary the venue ignores would reach 1 while the
 * position was still open.
 */
export function assessBaseSmooth(
  position: ProtectedPosition,
  terms: SmoothTerms,
): PolicyAssessment {
  const base = assessAnchored('BASE_SMOOTH', position, terms);

  if (!position.liquidationPrice) {
    // Without the venue's liquidation price there is no scale to measure
    // utilization against. Reporting a fabricated one would be worse than
    // reporting none, so the policy degrades to its Base Day half and says so.
    return base;
  }

  const liquidationAt = adverseExcursion(
    position.entryPrice,
    position.liquidationPrice,
    position.side,
  );

  if (liquidationAt.lessThanOrEqualTo(terms.startAt)) {
    throw new ValidationError(
      'Progressive protection would begin at or past the liquidation boundary, ' +
        'which leaves no range to intervene over. Lower the start point.',
      {
        startAt: terms.startAt.toString(),
        liquidationAt: liquidationAt.toString(),
      },
    );
  }

  const excursion = adverseExcursion(position.entryPrice, position.currentPrice, position.side);
  const utilization = protectionUtilization(excursion, terms.startAt, liquidationAt);
  const targetNotional = terms.initialNotional.times(new Decimal(1).minus(utilization));
  const overTarget = position.notional.minus(targetNotional);

  return {
    ...base,
    smooth: {
      excursion,
      startAt: terms.startAt,
      liquidationAt,
      utilization,
      targetNotional,
      recommendedReduction: overTarget.isNegative() ? new Decimal(0) : overTarget,
    },
  };
}

// ── Omni ────────────────────────────────────────────────────────────────────

export interface OmniTerms extends PolicyTerms {
  /**
   * The contribution the previous rebase required. Omitted on the first
   * calculation, where there is nothing to settle against.
   */
  previousContribution?: Decimal;
}

/**
 * Current-price anchored, rebased, volatility-sensitive.
 *
 * The one structural difference from the Base policies: the reference is
 * `currentPrice`, so a position that has run from $100 to $120 gets a boundary
 * measured from $120 (§8). σ is re-estimated at each rebase too, which is what
 * makes the requirement move.
 */
export function assessOmni(position: ProtectedPosition, terms: OmniTerms): PolicyAssessment {
  const assessment = evaluate('OMNI', position, position.currentPrice, terms);

  if (!terms.previousContribution) return assessment;

  return {
    ...assessment,
    settlement: rebaseSettlement(
      terms.previousContribution,
      assessment.contribution.requiredContribution,
    ),
  };
}

/**
 * The minimum position reduction that restores compliance when a participant
 * cannot fund a shortfall (§7, §18). Advisory: the caller shows it, the
 * participant acts.
 */
export function shortfallReduction(
  assessment: PolicyAssessment,
  availableContribution: Decimal,
): ReductionRequirement {
  return requiredReduction(assessment.contribution, availableContribution);
}

// ── Shared evaluation ───────────────────────────────────────────────────────

function assessAnchored(
  policy: ProtectionPolicyKind,
  position: ProtectedPosition,
  terms: PolicyTerms,
): PolicyAssessment {
  return evaluate(policy, position, position.entryPrice, terms);
}

function evaluate(
  policy: ProtectionPolicyKind,
  position: ProtectedPosition,
  referencePrice: Decimal,
  terms: PolicyTerms,
): PolicyAssessment {
  const z = zScoreForPercentile(terms.percentile);

  const peril = calculatePeril({
    referencePrice,
    side: position.side,
    dailySigma: terms.dailySigma,
    horizonDays: terms.horizonDays,
    z,
  });

  const contribution = calculateContribution({
    notional: position.notional,
    statisticalMove: peril.statisticalMove,
    modifiers: terms.modifiers,
  });

  const standing = boundaryStanding(peril, position.liquidationPrice);
  const warnings: PolicyWarning[] = [];

  if (standing === 'beyond-liquidation') {
    warnings.push({
      code: 'BOUNDARY_BEYOND_LIQUIDATION',
      message:
        'The venue would liquidate this position before the protection boundary is reached, ' +
        'so the boundary describes an event that cannot occur. Reduce leverage, shorten the ' +
        'horizon, or lower the protection percentile.',
    });
  }

  if (standing === 'unknown') {
    warnings.push({
      code: 'LIQUIDATION_PRICE_UNKNOWN',
      message:
        'The venue has not reported a liquidation price for this position, so the boundary ' +
        'cannot be checked against it.',
    });
  }

  if (terms.dailySigma.isZero()) {
    warnings.push({
      code: 'ZERO_VOLATILITY',
      message:
        'The volatility estimate is zero, which makes the boundary equal to the reference ' +
        'price and the required contribution zero. Check the price history.',
    });
  }

  return {
    policy,
    referencePrice,
    z,
    zConvention: Z_CONVENTION,
    percentile: terms.percentile,
    peril,
    contribution,
    standing,
    warnings,
  };
}
