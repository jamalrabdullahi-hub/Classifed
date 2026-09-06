import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import type { PerpSide } from '../domain/perps';
import { Z_CONVENTION, type ZConvention } from './zscore';

/**
 * Layer 1 of §17: what the risk *is*.
 *
 * §12 is enforced by the signatures in this file. `perilBoundary` takes a
 * **price** and never a position, so a boundary cannot be computed from
 * leveraged P&L even by accident. A 9% underlying move is a 9% peril at 2x and
 * at 20x; leverage changes the trader's loss, not the peril.
 *
 * The statistical adverse movement:
 *
 *     D = z · σ · √T
 *
 * and the boundary uses the log-return form the spec insists on (§1):
 *
 *     B = P_reference · exp(−D)     for a long
 *     B = P_reference · exp(+D)     for a short
 *
 * Not `P · (1 − D)`. The difference is small at D = 0.09 and large at D = 0.19,
 * and the exponential form is the one consistent with computing σ on log
 * returns in the first place. It also cannot produce a negative price, which
 * the linear form can at high volatility.
 *
 * The short case is the spec's own formula with the sign of D flipped: the
 * peril for a short is the price rising. The spec only writes the long case.
 */

export interface PerilInputs {
  /** The price the boundary is anchored to. Entry for Base policies, current for Omni. */
  referencePrice: Decimal;
  side: PerpSide;
  /** Per-day standard deviation of log returns. */
  dailySigma: Decimal;
  /** Protection horizon in days. */
  horizonDays: Decimal;
  z: Decimal;
}

export interface Peril {
  referencePrice: Decimal;
  side: PerpSide;
  dailySigma: Decimal;
  horizonDays: Decimal;
  z: Decimal;
  zConvention: ZConvention;
  /** σ scaled to the horizon: σ·√T. */
  horizonSigma: Decimal;
  /** D = z·σ·√T, the statistical adverse movement as a fraction. */
  statisticalMove: Decimal;
  /** B = P·exp(∓D). */
  boundary: Decimal;
}

export function calculatePeril(inputs: PerilInputs): Peril {
  const { referencePrice, side, dailySigma, horizonDays, z } = inputs;

  if (!referencePrice.isFinite() || referencePrice.lessThanOrEqualTo(0)) {
    throw new ValidationError('Reference price must be positive', {
      referencePrice: referencePrice.toString(),
    });
  }
  if (!dailySigma.isFinite() || dailySigma.isNegative()) {
    throw new ValidationError('Volatility must be non-negative', {
      dailySigma: dailySigma.toString(),
    });
  }
  if (!horizonDays.isFinite() || horizonDays.lessThanOrEqualTo(0)) {
    throw new ValidationError('Protection horizon must be a positive number of days', {
      horizonDays: horizonDays.toString(),
    });
  }
  if (!z.isFinite() || z.lessThanOrEqualTo(0)) {
    throw new ValidationError('z must be positive', { z: z.toString() });
  }

  const horizonSigma = dailySigma.times(horizonDays.sqrt());
  const statisticalMove = z.times(horizonSigma);
  const signed = side === 'LONG' ? statisticalMove.negated() : statisticalMove;

  return {
    referencePrice,
    side,
    dailySigma,
    horizonDays,
    z,
    zConvention: Z_CONVENTION,
    horizonSigma,
    statisticalMove,
    boundary: referencePrice.times(signed.exp()),
  };
}

/**
 * Whether a protection boundary is reachable before the venue liquidates.
 *
 * The spec omits this and the engine would be decorative without it. A boundary
 * that sits at or beyond the venue's liquidation price is never reached: the
 * venue closes the position first, and the protection would have been sold
 * against an event that cannot occur.
 *
 * `null` liquidation means the venue has not reported one — for a position that
 * does not exist yet, say. Then the relationship is genuinely unknown and is
 * reported as such rather than assumed sound.
 */
export type BoundaryStanding = 'ahead-of-liquidation' | 'beyond-liquidation' | 'unknown';

export function boundaryStanding(
  peril: Peril,
  liquidationPrice: Decimal | null,
): BoundaryStanding {
  if (!liquidationPrice || !liquidationPrice.isFinite() || liquidationPrice.lessThanOrEqualTo(0)) {
    return 'unknown';
  }
  // A long liquidates below; the boundary is useful only if it is hit first,
  // i.e. sits above the liquidation price. Mirrored for a short.
  const ahead =
    peril.side === 'LONG'
      ? peril.boundary.greaterThan(liquidationPrice)
      : peril.boundary.lessThan(liquidationPrice);
  return ahead ? 'ahead-of-liquidation' : 'beyond-liquidation';
}

/**
 * Adverse excursion from the reference, as a non-negative fraction (§4).
 *
 * Zero when the position is in profit — favourable movement is not an
 * excursion, and clipping here keeps every downstream utilization in [0, 1]
 * without each caller having to remember to.
 */
export function adverseExcursion(
  referencePrice: Decimal,
  currentPrice: Decimal,
  side: PerpSide,
): Decimal {
  if (referencePrice.lessThanOrEqualTo(0)) {
    throw new ValidationError('Reference price must be positive', {
      referencePrice: referencePrice.toString(),
    });
  }
  const move =
    side === 'LONG'
      ? referencePrice.minus(currentPrice)
      : currentPrice.minus(referencePrice);
  const fraction = move.dividedBy(referencePrice);
  return fraction.isNegative() ? new Decimal(0) : fraction;
}

/**
 * Protection utilization (§4): where the position sits between the point
 * progressive protection begins and the point it is fully consumed.
 *
 *     U = clip((x − D_start) / (D_liq − D_start), 0, 1)
 *
 * Monotonic non-decreasing in x by construction, which §18 requires: worsening
 * excursion can never reduce utilization. U = 0 means no intervention, U = 1
 * means the protection is exhausted and the position is at its liquidation
 * boundary.
 */
export function protectionUtilization(
  excursion: Decimal,
  startAt: Decimal,
  liquidationAt: Decimal,
): Decimal {
  if (liquidationAt.lessThanOrEqualTo(startAt)) {
    throw new ValidationError(
      'Progressive protection must begin strictly before the liquidation boundary',
      { startAt: startAt.toString(), liquidationAt: liquidationAt.toString() },
    );
  }
  const raw = excursion.minus(startAt).dividedBy(liquidationAt.minus(startAt));
  if (raw.isNegative()) return new Decimal(0);
  return raw.greaterThan(1) ? new Decimal(1) : raw;
}
