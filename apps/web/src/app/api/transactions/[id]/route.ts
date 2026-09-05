import { prisma } from '@flt/db';
import { getTransaction } from '@flt/core/services/trades';
import { routeHandler } from '@/server/api';

/**
 * One transaction with its full event timeline.
 *
 * Polled by the trade screen while a transaction is in flight, which is why the
 * events come back with it rather than needing a second request.
 */
export const GET = routeHandler<unknown, { id: string }, unknown>(
  {},
  async ({ params, user }) => {
    const transaction = await getTransaction(prisma, user.id, params.id);

    return {
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      txHash: transaction.txHash,
      chainId: transaction.chainId,
      blockNumber: transaction.blockNumber?.toString() ?? null,
      amountInActual: transaction.amountInActual,
      amountOutActual: transaction.amountOutActual,
      networkFeePaid: transaction.networkFeePaid,
      failureReason: transaction.failureReason,
      tamperDetected: transaction.tamperDetected,
      submittedAt: transaction.submittedAt.toISOString(),
      confirmedAt: transaction.confirmedAt?.toISOString() ?? null,
      events: transaction.events.map((event) => ({
        status: event.status,
        detail: event.detail,
        occurredAt: event.occurredAt.toISOString(),
      })),
      quote: transaction.quote
        ? {
            sellAmount: transaction.quote.sellAmount,
            buyAmount: transaction.quote.buyAmount,
            minBuyAmount: transaction.quote.minBuyAmount,
            sellTokenAddress: transaction.quote.sellTokenAddress,
            buyTokenAddress: transaction.quote.buyTokenAddress,
          }
        : null,
    };
  },
);
