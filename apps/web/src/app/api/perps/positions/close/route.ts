import { z } from 'zod';
import { PerpOrderKind, PerpOrderStatus, prisma } from '@flt/db';
import { Decimal, NotFoundError, ValidationError } from '@flt/core/domain';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { closeCustodyPerpOrder } from '@flt/providers';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Exit a position.
 *
 * This is the **custody** close: it broadcasts a reduce-only market order for
 * the participant's attributed size from the omnibus (signed by FLT's agent
 * key), exactly as the open is placed. The old close button hit the *prepare*
 * path, which — under custody — nothing ever signs, so it did nothing. The
 * reserved margin is released by the worker once the venue reflects the
 * reduction.
 */
const schema = z.object({
  symbol: z.string().trim().min(1).max(24),
  slippageBps: z.coerce.number().int().min(0).max(1_000).default(100),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'perp-close' } },
  async ({ body, user }) => {
    assertPerpsEnabled();

    const market = await prisma.perpMarket.findFirst({
      where: { symbol: body.symbol.toUpperCase() },
      orderBy: { symbol: 'asc' },
    });
    if (!market) throw new NotFoundError('Market');

    // The participant's live position is their latest order on the market.
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

    const result = await closeCustodyPerpOrder({
      userId: user.id,
      walletId: order.walletId,
      marketId: market.id,
      symbol: market.symbol,
      // Reduce-only by the participant's own size, so one exit does not flatten
      // the whole pooled position.
      size: order.size,
      margin: new Decimal(order.marginRequired ?? '0'),
      slippageBps: body.slippageBps ?? 100,
    });

    return { orderId: result.orderId, venueOrderId: result.venueOrderId };
  },
);
