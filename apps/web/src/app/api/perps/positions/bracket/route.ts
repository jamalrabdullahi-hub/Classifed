import { z } from 'zod';
import { PerpOrderKind, PerpOrderStatus, prisma } from '@flt/db';
import { NotFoundError, ValidationError } from '@flt/core/domain';
import { assertBracketPrices, assertPerpsEnabled } from '@flt/core/services/perps';
import { attachCustodyPerpBracket, perpVenue } from '@flt/providers';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Attach a take-profit and/or stop-loss to a position that is already open.
 *
 * The ticket can send a bracket with an entry, which is the better moment —
 * the position is never unprotected. This is for the position somebody already
 * holds and has since decided where to leave.
 *
 * Both legs are reduce-only and sized to the participant's own attributed size,
 * so one person's stop can never flatten the pooled position.
 */
const price = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Enter a price like 77000 or 77000.50')
  .optional()
  .nullable();

const schema = z.object({
  symbol: z.string().trim().min(1).max(24),
  takeProfitPrice: price,
  stopLossPrice: price,
  slippageBps: z.coerce.number().int().min(0).max(1_000).default(100),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'perp-bracket' } },
  async ({ body, user }) => {
    assertPerpsEnabled();

    const market = await prisma.perpMarket.findFirst({
      where: { symbol: body.symbol.toUpperCase() },
      orderBy: { symbol: 'asc' },
    });
    if (!market) throw new NotFoundError('Market');

    // The same rule the close path uses: the live position is the latest order.
    const order = await prisma.perpOrder.findFirst({
      where: { userId: user.id, marketId: market.id },
      orderBy: { id: 'desc' },
    });
    if (!order || order.kind !== PerpOrderKind.OPEN) {
      throw new ValidationError('You have no open position on this market');
    }
    if (order.status === PerpOrderStatus.REJECTED || order.status === PerpOrderStatus.ABANDONED) {
      throw new ValidationError('Your last order on this market did not fill');
    }

    const takeProfit = body.takeProfitPrice?.trim() || null;
    const stopLoss = body.stopLossPrice?.trim() || null;
    if (!takeProfit && !stopLoss) {
      throw new ValidationError('Give a take-profit price, a stop-loss price, or both');
    }

    /**
     * The legs have to sit on the correct side of the mark, and must not cross.
     *
     * A "stop" above the mark on a long is an instant market exit wearing a
     * stop's name: the venue accepts it and it fills at once, so the
     * participant bought protection and got a close. This is the last place
     * that reading is available.
     *
     * The mark comes from the venue rather than the row, because the row's
     * reference price is where the position *opened* — validating against it
     * would accept a stop that is already through the market.
     */
    const markets = await perpVenue().listMarkets();
    const mark = markets.find((entry) => entry.symbol === market.symbol)?.markPrice ?? null;

    assertBracketPrices({
      side: order.side,
      markPrice: mark,
      takeProfitPrice: takeProfit,
      stopLossPrice: stopLoss,
    });

    const result = await attachCustodyPerpBracket({
      userId: user.id,
      orderId: order.id,
      symbol: market.symbol,
      side: order.side as 'LONG' | 'SHORT',
      size: order.size,
      takeProfitPrice: takeProfit,
      stopLossPrice: stopLoss,
      slippageBps: body.slippageBps ?? 100,
    });

    return {
      takeProfitPrice: takeProfit,
      stopLossPrice: stopLoss,
      ...result,
    };
  },
);
