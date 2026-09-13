import { PerpOrderKind, PerpOrderStatus, prisma } from '@flt/db';
import { handler } from '@/server/api';

/**
 * The participant's orders that are waiting, not filled.
 *
 * Two kinds of thing wait on this venue, and a participant thinks of both as
 * "my pending orders":
 *
 *   - **Resting entries** — a limit or trigger order that has been sent but has
 *     not filled. These are PerpOrder rows of kind OPEN, still SUBMITTED, with an
 *     order type other than MARKET (a market order fills or dies at once).
 *   - **Protective legs** — take-profit and stop-loss prices attached to a
 *     position. They are recorded on the entry row rather than as rows of their
 *     own (see `attachCustodyPerpBracket`), so they are read off that row.
 *
 * Read from FLT's own records, not the venue. The omnibus account's open orders
 * are everybody's; only these rows say which of them belong to this participant.
 */
export const GET = handler({}, async ({ user }) => {
  const orders = await prisma.perpOrder.findMany({
    where: {
      userId: user.id,
      kind: PerpOrderKind.OPEN,
      status: { in: [PerpOrderStatus.SUBMITTED, PerpOrderStatus.PARTIALLY_FILLED, PerpOrderStatus.FILLED] },
    },
    include: { market: { select: { symbol: true } } },
    orderBy: { id: 'desc' },
    take: 100,
  });

  const pending: {
    id: string;
    symbol: string;
    kind: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
    side: string;
    orderType: string;
    price: string | null;
    size: string;
    status: string;
    createdAt: string | null;
  }[] = [];

  for (const order of orders) {
    const isResting =
      order.orderType !== 'MARKET' &&
      (order.status === PerpOrderStatus.SUBMITTED ||
        order.status === PerpOrderStatus.PARTIALLY_FILLED);

    if (isResting) {
      pending.push({
        id: order.id,
        symbol: order.market.symbol,
        kind: 'ENTRY',
        side: order.side,
        orderType: order.orderType,
        price: order.triggerPrice ?? order.limitPrice,
        size: order.size,
        status: order.status,
        createdAt: order.submittedAt?.toISOString() ?? null,
      });
    }

    // Protective legs belong to a position that exists, so only on a filled entry.
    if (order.status === PerpOrderStatus.FILLED || order.status === PerpOrderStatus.PARTIALLY_FILLED) {
      const exitSide = order.side === 'LONG' ? 'SHORT' : 'LONG';
      if (order.takeProfitPrice) {
        pending.push({
          id: `${order.id}:tp`,
          symbol: order.market.symbol,
          kind: 'TAKE_PROFIT',
          side: exitSide,
          orderType: 'TAKE_PROFIT_MARKET',
          price: order.takeProfitPrice,
          size: order.size,
          status: 'RESTING',
          createdAt: (order.bracketUpdatedAt ?? order.submittedAt)?.toISOString() ?? null,
        });
      }
      if (order.stopLossPrice) {
        pending.push({
          id: `${order.id}:sl`,
          symbol: order.market.symbol,
          kind: 'STOP_LOSS',
          side: exitSide,
          orderType: 'STOP_MARKET',
          price: order.stopLossPrice,
          size: order.size,
          status: 'RESTING',
          createdAt: (order.bracketUpdatedAt ?? order.submittedAt)?.toISOString() ?? null,
        });
      }
    }
  }

  return { orders: pending };
});
