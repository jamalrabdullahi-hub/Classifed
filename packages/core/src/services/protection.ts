import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import type { PerpSide } from '../domain/perps';
import type { PerpCandleInterval, PerpVenue } from '../ports/perps';
import {
  HistoricalStdDev,
  INTERVAL_DAYS,
  toDailySigma,
  type VolatilityEstimate,
  type VolatilityModel,
} from '../protection/volatility';
import {
  assessBaseDay,
  assessBaseSmooth,
  assessOmni,
  type PolicyAssessment,
  type ProtectedPosition,
  type ProtectionPolicyKind,
} from '../protection/policies';
import type { ContributionModifiers } from '../protection/contribution';

/**
 * The calculation surface (§15).
 *
 * Everything here is read-only and holds nothing. It answers one question —
 * "what would protecting this position cost, and where would the boundary
 * sit" — and answers it with enough of its own working shown that the caller
 * can recompute the result by hand. That is §14's reproducibility requirement
 * and the reason the response carries the inputs, not only the outputs.
 *
 * Nothing here decides anything. No policy is sold, no contribution is
 * collected, and no position is touched.
 */

export interface ProtectionRequest {
  symbol: string;
  side: PerpSide;
  entryPrice: Decimal;
  notional: Decimal;
  /** The venue's own liquidation price, when there is a live position. */
  liquidationPrice: Decimal | null;

  percentile: number;
  /** Omni's rebasing interval, in days. Base Day is always 1. */
  horizonDays: Decimal;
  /** Where Base Smooth's progressive protection begins, as a fraction. */
  smoothStartAt: Decimal;

  /** Candle interval σ is estimated from. */
  interval: PerpCandleInterval;
  /** How many candles to use. */
  window: number;

  /** Omni's previous requirement, when one is known. */
  previousContribution?: Decimal;
  modifiers?: Partial<ContributionModifiers>;
}

export const PROTECTION_DEFAULTS = {
  percentile: 0.9973,
  horizonDays: 10,
  smoothStartAt: '0.02',
  interval: '1h' as PerpCandleInterval,
  window: 168,
} as const;

export interface ProtectionCalculation {
  symbol: string;
  /** The live mark, which is Omni's reference and the price everything is read at. */
  currentPrice: Decimal;
  position: ProtectedPosition;
  volatility: VolatilityEstimate;
  /** σ rescaled to per-day, which is what the peril formula consumes. */
  dailySigma: Decimal;
  interval: PerpCandleInterval;
  window: number;
  policies: Record<ProtectionPolicyKind, PolicyAssessment>;
}

/**
 * Runs all three policies over one position.
 *
 * All three rather than the one asked for, because the interesting fact about
 * this design is how they differ — a panel that shows only Omni cannot show
 * that Omni's boundary has moved to $120 while Base Day's is still anchored at
 * $100. Computing all three costs one extra pass over arithmetic that is
 * already done.
 */
export async function calculateProtection(
  venue: PerpVenue,
  request: ProtectionRequest,
  model: VolatilityModel = new HistoricalStdDev(),
): Promise<ProtectionCalculation> {
  const market = await venue.getMarket(request.symbol);
  if (!market) {
    throw new ValidationError('Unknown market', { symbol: request.symbol });
  }

  if (!market.markPrice) {
    throw new ValidationError('The venue reported no mark price for this market', {
      symbol: request.symbol,
    });
  }

  const currentPrice = new Decimal(market.markPrice);
  if (!currentPrice.isFinite() || currentPrice.lessThanOrEqualTo(0)) {
    throw new ValidationError('The venue reported no usable mark price', {
      symbol: request.symbol,
    });
  }

  const periodDays = INTERVAL_DAYS[request.interval];
  if (!periodDays) {
    throw new ValidationError('Unsupported candle interval for volatility', {
      interval: request.interval,
    });
  }

  // One extra candle: N returns need N+1 closes, and asking for exactly the
  // window would quietly produce an estimate one observation short.
  const candles = await venue.getCandles(market.symbol, request.interval, request.window + 1);
  const volatility = model.calculate(candles, request.window + 1, periodDays);
  const dailySigma = toDailySigma(volatility);

  const position: ProtectedPosition = {
    side: request.side,
    entryPrice: request.entryPrice,
    currentPrice,
    notional: request.notional,
    liquidationPrice: request.liquidationPrice,
  };

  const shared = {
    percentile: request.percentile,
    dailySigma,
    modifiers: request.modifiers,
  };

  return {
    symbol: market.symbol,
    currentPrice,
    position,
    volatility,
    dailySigma,
    interval: request.interval,
    window: request.window,
    policies: {
      BASE_DAY: assessBaseDay(position, shared),
      BASE_SMOOTH: assessBaseSmooth(position, {
        ...shared,
        horizonDays: new Decimal(1),
        startAt: request.smoothStartAt,
        initialNotional: request.notional,
      }),
      OMNI: assessOmni(position, {
        ...shared,
        horizonDays: request.horizonDays,
        previousContribution: request.previousContribution,
      }),
    },
  };
}

// ── Serialisation ───────────────────────────────────────────────────────────

/**
 * The §15 response shape.
 *
 * Every number is a string. A `Decimal` that goes out as a JSON float loses the
 * exactness the whole engine was built to preserve, and a reader recomputing
 * from the response would find the last digits disagreeing with ours for
 * reasons they could not diagnose.
 *
 * The rule this shape has to satisfy: someone holding only this JSON and the
 * formulas — no access to the code — must be able to recompute `boundary` and
 * `requiredContribution` and get the same digits. So `zScore`, `zConvention`,
 * `horizonDays`, `volatility` and every modifier are all present, and the
 * intermediate `statisticalMove` and `statisticalRisk` are shown rather than
 * folded away.
 */
export function serialiseProtection(calculation: ProtectionCalculation) {
  return {
    symbol: calculation.symbol,
    currentPrice: calculation.currentPrice.toString(),

    position: {
      side: calculation.position.side,
      entryPrice: calculation.position.entryPrice.toString(),
      notional: calculation.position.notional.toString(),
      liquidationPrice: calculation.position.liquidationPrice?.toString() ?? null,
    },

    volatility: {
      model: calculation.volatility.model,
      interval: calculation.interval,
      window: calculation.window,
      observations: calculation.volatility.observations,
      /** σ per candle period, exactly as estimated. */
      sigmaPerPeriod: calculation.volatility.sigma.toString(),
      periodDays: calculation.volatility.periodDays.toString(),
      /** σ rescaled by √t, which is the figure the formulas use. */
      dailySigma: calculation.dailySigma.toString(),
      meanLogReturn: calculation.volatility.meanLogReturn.toString(),
    },

    policies: Object.fromEntries(
      Object.entries(calculation.policies).map(([kind, assessment]) => [
        kind,
        serialisePolicy(assessment),
      ]),
    ),

    /**
     * The engine holds no participant funds and cannot act on a position.
     * Carried in the response rather than only in the interface, so an
     * integrator reading the JSON cannot mistake this for cover.
     */
    disclosure: {
      contributionHeld: false,
      canActOnPosition: false,
      note:
        'This is a calculation, not cover. No contribution is collected or held, no claim can ' +
        'be paid, and FLT cannot open, close or reduce a position — only the key in your ' +
        'browser can. Reductions shown are recommendations for you to act on.',
    },
  };
}

function serialisePolicy(assessment: PolicyAssessment) {
  const { peril, contribution } = assessment;

  return {
    policy: assessment.policy,
    referencePrice: assessment.referencePrice.toString(),
    percentile: assessment.percentile.toString(),
    zScore: assessment.z.toString(),
    zConvention: assessment.zConvention,
    horizonDays: peril.horizonDays.toString(),
    dailySigma: peril.dailySigma.toString(),
    /** σ·√T. */
    horizonSigma: peril.horizonSigma.toString(),
    /** D = z·σ·√T. */
    statisticalMove: peril.statisticalMove.toString(),
    /** B = P·exp(∓D). */
    protectionBoundary: peril.boundary.toString(),

    notional: contribution.notional.toString(),
    /** R_stat = exp(D) − 1, per §6. */
    statisticalRisk: contribution.statisticalRisk.toString(),
    /** K_stat = N · R_stat, before modifiers. */
    baseContribution: contribution.baseContribution.toString(),
    modifiers: {
      iv: contribution.modifiers.iv.toString(),
      liquidity: contribution.modifiers.liquidity.toString(),
      gap: contribution.modifiers.gap.toString(),
      tail: contribution.modifiers.tail.toString(),
      combined: contribution.combinedModifier.toString(),
    },
    requiredContribution: contribution.requiredContribution.toString(),

    standing: assessment.standing,
    warnings: assessment.warnings,

    smooth: assessment.smooth
      ? {
          excursion: assessment.smooth.excursion.toString(),
          startAt: assessment.smooth.startAt.toString(),
          liquidationAt: assessment.smooth.liquidationAt.toString(),
          utilization: assessment.smooth.utilization.toString(),
          targetNotional: assessment.smooth.targetNotional.toString(),
          recommendedReduction: assessment.smooth.recommendedReduction.toString(),
        }
      : null,

    settlement: assessment.settlement
      ? {
          kind: assessment.settlement.kind,
          previousContribution: assessment.settlement.previousContribution.toString(),
          requiredContribution: assessment.settlement.requiredContribution.toString(),
          amount: assessment.settlement.amount.toString(),
        }
      : null,
  };
}
