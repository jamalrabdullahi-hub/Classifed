import { z } from 'zod';
import { handler } from '@/server/api';
import { prisma } from '@/server/db';
import { createOrder, executeOrder, fundPendingOrder } from '@/services/order';
import { RateLimits } from '@/services/ratelimit';
import { serializeOrder } from '@/services/serialize';

const schema = z.object({
  // The ONLY thing the client gets to choose. Every amount comes from the quote.
  quoteId: z.string().uuid(),
});

export const GET = handler({}, async ({ userId }) => {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { asset: true, trades: true },
  });
  return orders.map(serializeOrder);
});

export const POST = handler(
  {
    schema,
    idempotency: 'POST /api/orders',
    rateLimit: { rule: RateLimits.ORDER, scope: 'order' },
  },
  async ({ body, userId, context }) => {
    let order = await createOrder(
      { userId, quoteId: body.quoteId, idempotencyKey: `order:${body.quoteId}` },
      context,
    );

    // A funded account executes immediately; an unfunded one waits for a deposit.
    if (order.status === 'PENDING_PAYMENT') {
      order = await fundPendingOrder(order.id, context);
    }
    if (order.status === 'PAID') {
      order = await executeOrder(order.id, context);
    }

    const full = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { asset: true, trades: true },
    });
    return serializeOrder(full);
  },
);
