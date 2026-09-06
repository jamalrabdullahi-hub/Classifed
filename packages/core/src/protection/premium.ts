import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import type { PerpSide } from '../domain/perps';
import type { Contribution } from './contribution';

/**
 * What protection costs to buy, and where the money goes.
 *
 * ## Two amounts, never one
 *
 * §12 and §19 both insist on this and it is the single most important rule in
 * the file: the participant's contribution and the operator's fee are separate
 * amounts with separate destinations, and they are never summed into an opaque
 * "premium" that hides which is which.
 *
 *   contribution  K         — the risk capital. Belongs to the protection pool.
 *   operator fee  K × rate  — FLT's revenue for running the system.
 *   total charged K + fee   — what leaves the participant's wallet.
 *
 * The fee is charged **on top of** the contribution rather than deducted from
 * it. Deducting would leave the pool holding less than the mathematics says it
 * needs, which is how a protection fund becomes insolvent while every
 * individual policy looks correctly priced.
 *
 * ## This is a quote, not a receipt
 *
 * Nothing here moves money. It computes what a purchase would cost; the
 * transfer is a transaction the participant signs from their own wallet, and
 * FLT never holds their keys.
 */

/** FLT's cut, in basis points of the contribution. 1000 = 10%. */
export const DEFAULT_OPERATOR_FEE_BPS = 1_000;

export interface Premium {
  /** K — risk capital, destined for the protection pool. */
  contribution: Decimal;
  /** The operator's rate, in basis points of the contribution. */
  operatorFeeBps: number;
  /** K × rate — FLT's revenue. Never part of the pool. */
  operatorFee: Decimal;
  /** contribution + operatorFee. What the participant actually pays. */
  totalPremium: Decimal;
  /** The total as a fraction of protected notional, for comparison across sizes. */
  rateOnNotional: Decimal;
}

export function calculatePremium(
  contribution: Contribution,
  operatorFeeBps: number = DEFAULT_OPERATOR_FEE_BPS,
): Premium {
  if (!Number.isInteger(operatorFeeBps) || operatorFeeBps < 0 || operatorFeeBps > 5_000) {
    throw new ValidationError(
      'Operator fee must be a whole number of basis points between 0 and 5000',
      { operatorFeeBps },
    );
  }

  const k = contribution.requiredContribution;
  const operatorFee = k.times(operatorFeeBps).dividedBy(10_000);

  return {
    contribution: k,
    operatorFeeBps,
    operatorFee,
    totalPremium: k.plus(operatorFee),
    rateOnNotional: contribution.notional.isZero()
      ? new Decimal(0)
      : k.plus(operatorFee).dividedBy(contribution.notional),
  };
}

// ── The waterfall ───────────────────────────────────────────────────────────

/**
 * Insurance before margin.
 *
 * The product's promise is that protection resolves the position *before* the
 * venue liquidates it. That is not a matter of policy wording — it is an
 * inequality, and it either holds or the promise is empty:
 *
 *     long :  B > liquidation      (both below entry; the boundary is hit first)
 *     short:  B < liquidation      (both above entry)
 *
 * Substituting B = P·exp(∓D) and the venue's liquidation formula and solving
 * for leverage gives a closed form for the highest leverage at which the
 * waterfall still holds:
 *
 *     long :  L < 1 / (1 − exp(−D)·(1 − mmf))
 *     short:  L < 1 / (exp(D)·(1 + mmf) − 1)
 *
 * Above that leverage the venue closes the position first and the protection
 * would be sold against an event that cannot occur. Measured against live
 * Hyperliquid, that bound bites well inside the range people actually trade —
 * which is why this is enforced rather than warned about.
 *
 * Note what the bound depends on: D, and therefore volatility. The same
 * leverage is safe on a quiet day and unsound on a violent one, so this is
 * recomputed from live σ every time rather than fixed as a constant.
 */
export interface WaterfallBound {
  /** Highest leverage at which insurance still fires before liquidation. */
  maxLeverage: Decimal;
  /** The same, floored to a whole number a venue will accept. */
  maxWholeLeverage: number;
  /** Maintenance margin fraction used, so the bound can be rechecked. */
  maintenanceFraction: Decimal;
  /** D at the horizon the bound was computed for. */
  statisticalMove: Decimal;
}

export function waterfallLeverageBound(
  statisticalMove: Decimal,
  maintenanceFraction: Decimal,
  side: PerpSide,
): WaterfallBound {
  if (!statisticalMove.isFinite() || statisticalMove.isNegative()) {
    throw new ValidationError('Statistical move must be non-negative', {
      statisticalMove: statisticalMove.toString(),
    });
  }
  if (maintenanceFraction.isNegative() || maintenanceFraction.greaterThanOrEqualTo(1)) {
    throw new ValidationError('Maintenance fraction must be in [0, 1)', {
      maintenanceFraction: maintenanceFraction.toString(),
    });
  }

  const one = new Decimal(1);

  const denominator =
    side === 'LONG'
      ? one.minus(statisticalMove.negated().exp().times(one.minus(maintenanceFraction)))
      : statisticalMove.exp().times(one.plus(maintenanceFraction)).minus(one);

  // Non-positive means no leverage can breach the waterfall — the boundary is
  // always hit first. Reported as 1x rather than infinity so no caller has to
  // handle an unbounded value it cannot render.
  if (denominator.lessThanOrEqualTo(0)) {
    return {
      maxLeverage: new Decimal(Number.MAX_SAFE_INTEGER),
      maxWholeLeverage: Number.MAX_SAFE_INTEGER,
      maintenanceFraction,
      statisticalMove,
    };
  }

  const bound = one.dividedBy(denominator);

  return {
    maxLeverage: bound,
    // Floored, not rounded: rounding up would permit exactly the leverage the
    // inequality forbids, on the grounds that it was close.
    maxWholeLeverage: Math.max(1, Math.floor(bound.toNumber())),
    maintenanceFraction,
    statisticalMove,
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export type IneligibleReason =
  | 'ALREADY_PAST_BOUNDARY'
  | 'INSIDE_MARGIN_ZONE'
  | 'NO_LIQUIDATION_REFERENCE';

export interface Eligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
  /** How far the position has travelled from entry toward liquidation, in [0, 1]. */
  proximity: Decimal;
  message: string | null;
}

/**
 * Whether protection may still be bought on a position that already exists.
 *
 * §3: a participant must not be able to wait until a position is failing and
 * then insure it. Two deterministic refusals, neither of which needs a
 * parameter the specification has not defined:
 *
 * **Already past the boundary.** If the price has moved further against the
 * position than the boundary this policy would set, the covered event has
 * already happened. Selling cover for it is selling a claim, not a risk.
 *
 * **Inside the margin zone.** If the position has travelled at least
 * `marginZoneEntry` of the distance from entry to the venue's liquidation
 * price, the margin engine is already the operative mechanism. The
 * specification's example puts this near the point where roughly a 5% adverse
 * move exhausts margin on a 10x position — i.e. at the liquidation boundary
 * itself — so the default here is 1.0, meaning refuse only once liquidation is
 * reached, and any stricter value is an explicit operator choice.
 *
 * Note this is proximity, not a fixed percentage: the same rule applies at
 * every leverage, because the distance to liquidation is what changes.
 */
export function protectionEligibility(params: {
  side: PerpSide;
  entryPrice: Decimal;
  currentPrice: Decimal;
  liquidationPrice: Decimal | null;
  /** The boundary the prospective policy would set. */
  boundary: Decimal;
  /** Fraction of the distance to liquidation at which cover is refused. */
  marginZoneEntry?: Decimal;
}): Eligibility {
  const { side, entryPrice, currentPrice, liquidationPrice, boundary } = params;
  const zoneEntry = params.marginZoneEntry ?? new Decimal(1);

  const pastBoundary =
    side === 'LONG' ? currentPrice.lessThanOrEqualTo(boundary) : currentPrice.greaterThanOrEqualTo(boundary);

  const proximity = liquidationPrice
    ? liquidationProximityFraction(side, entryPrice, currentPrice, liquidationPrice)
    : new Decimal(0);

  if (pastBoundary) {
    return {
      eligible: false,
      reason: 'ALREADY_PAST_BOUNDARY',
      proximity,
      message:
        'This position has already moved past the boundary the policy would set, so the ' +
        'covered event has already happened. Protection cannot be bought against a loss ' +
        'that has already occurred.',
    };
  }

  if (liquidationPrice && proximity.greaterThanOrEqualTo(zoneEntry)) {
    return {
      eligible: false,
      reason: 'INSIDE_MARGIN_ZONE',
      proximity,
      message:
        'This position is already inside the margin zone, where the venue\'s liquidation ' +
        'engine is the operative mechanism. Protection has to be in place before a position ' +
        'reaches that point.',
    };
  }

  return { eligible: true, reason: null, proximity, message: null };
}

/**
 * Distance travelled from entry toward liquidation, clipped to [0, 1].
 *
 * Zero while the position is in profit — a winning position has not travelled
 * toward liquidation at all, and a negative proximity would compare wrongly
 * against any threshold.
 */
function liquidationProximityFraction(
  side: PerpSide,
  entryPrice: Decimal,
  currentPrice: Decimal,
  liquidationPrice: Decimal,
): Decimal {
  const span = side === 'LONG' ? entryPrice.minus(liquidationPrice) : liquidationPrice.minus(entryPrice);
  if (span.lessThanOrEqualTo(0)) return new Decimal(0);

  const travelled = side === 'LONG' ? entryPrice.minus(currentPrice) : currentPrice.minus(entryPrice);
  const fraction = travelled.dividedBy(span);

  if (fraction.isNegative()) return new Decimal(0);
  return fraction.greaterThan(1) ? new Decimal(1) : fraction;
}

/**
 * Converts a USD position size into contracts.
 *
 * Traders hold USDC and USDT, and think in dollars. Asking for "0.0125 BTC"
 * makes them do the conversion in their head at a price that is moving, which
 * is exactly the arithmetic a fat-finger check is supposed to catch. So the
 * ticket takes dollars and this does the conversion once, at a stated price.
 *
 * Rounded **down** to the market's size precision: rounding up would build a
 * position marginally larger than the dollars the participant approved.
 */
export function contractsForUsd(
  usdNotional: Decimal,
  price: Decimal,
  sizeDecimals: number,
): Decimal {
  if (!usdNotional.isFinite() || usdNotional.isNegative()) {
    throw new ValidationError('Position size in USD must be non-negative', {
      usdNotional: usdNotional.toString(),
    });
  }
  if (!price.isFinite() || price.lessThanOrEqualTo(0)) {
    throw new ValidationError('Price must be positive to size a position', {
      price: price.toString(),
    });
  }
  return usdNotional.dividedBy(price).toDecimalPlaces(sizeDecimals, Decimal.ROUND_DOWN);
}
