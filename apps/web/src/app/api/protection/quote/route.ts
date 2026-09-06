import { z } from 'zod';
import { Decimal } from '@flt/core/domain';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { quoteProtection, protectionRequired } from '@flt/core/services/protection-quote';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * What protection would cost for a position that does not exist yet.
 *
 * The order ticket calls this as the participant types, because the two
 * numbers it returns both have to be visible *before* the trade is committed:
 * what the cover costs, and the highest leverage at which the cover is
 * meaningful at all.
 *
 * Size is in **dollars**, not contracts. Traders hold USDC and USDT and think
 * in dollars; making them convert to 0.0125 BTC in their head at a price that
 * is moving is precisely the arithmetic a fat-finger guard exists to prevent.
 * The contract count comes back in the response, rounded down, so what they
 * approve is never larger than the dollars they typed.
 */
const schema = z.object({
  symbol: z.string().trim().min(1).max(24),
  side: z.enum(['LONG', 'SHORT']),
  /** Position size in USD. */
  usdNotional: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Must be a positive dollar amount'),
  leverage: z.coerce.number().int().min(1).max(100),
  percentile: z.coerce.number().gt(0.5).lt(1).optional(),
  horizonDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const POST = handler({ schema }, async ({ body }) => {
  assertPerpsEnabled();

  const quote = await quoteProtection(perpVenue(), {
    symbol: body.symbol,
    side: body.side,
    usdNotional: new Decimal(body.usdNotional),
    leverage: body.leverage,
    percentile: body.percentile,
    horizonDays: body.horizonDays,
  });

  return {
    symbol: quote.symbol,
    side: quote.side,
    markPrice: quote.markPrice.toFixed(),

    position: {
      usdNotional: quote.usdNotional.toFixed(),
      /** What the dollars buy, rounded down to the market's precision. */
      contracts: quote.contracts.toFixed(),
      leverage: quote.leverage,
      /** Posted to the venue as collateral. Separate from the premium. */
      marginRequired: quote.marginRequired.toFixed(),
      estimatedLiquidation: quote.estimatedLiquidation?.toFixed() ?? null,
    },

    cover: {
      percentile: String(quote.percentile),
      zScore: quote.z.toFixed(),
      zConvention: 'one-tailed',
      dailySigma: quote.dailySigma.toFixed(),
      horizonDays: quote.horizonDays.toFixed(),
      statisticalMove: quote.statisticalMove.toFixed(),
      boundary: quote.boundary.toFixed(),
    },

    /**
     * The two amounts, never merged. The contribution is risk capital destined
     * for the pool; the fee is FLT's revenue. A caller can always say which is
     * which, which is what §19 requires of every surface that shows a price.
     */
    premium: {
      contribution: quote.premium.contribution.toFixed(),
      operatorFeeBps: quote.premium.operatorFeeBps,
      operatorFee: quote.premium.operatorFee.toFixed(),
      total: quote.premium.totalPremium.toFixed(),
      rateOnNotional: quote.premium.rateOnNotional.toFixed(),
      destinations: quote.destinations,
    },

    /**
     * Insurance first, margin second — as an inequality rather than a promise.
     * `maxLeverage` is recomputed from live volatility, so it moves.
     */
    waterfall: {
      holds: quote.waterfallHolds,
      maxLeverage: quote.waterfall.maxWholeLeverage,
      maintenanceFraction: quote.waterfall.maintenanceFraction.toFixed(),
      refusal: quote.refusal,
    },

    required: protectionRequired(),
    sellable: quote.sellable,
  };
});
