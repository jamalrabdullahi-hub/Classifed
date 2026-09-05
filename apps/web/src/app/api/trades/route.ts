import { z } from 'zod';
import { submitTrade } from '@flt/core/services/trades';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler, txHashSchema } from '@/server/api';

/**
 * Records a signed trade.
 *
 * By the time this runs the transaction is already in the mempool — the user's
 * wallet broadcast it. This endpoint consumes the quote and starts monitoring;
 * it cannot cancel or replace anything.
 *
 * Idempotent, because a user whose connection drops after signing must be able
 * to retry without a second record being created against the same quote.
 */
const schema = z.object({
  quoteId: z.string().uuid(),
  txHash: txHashSchema,
});

export const POST = handler(
  {
    schema,
    rateLimit: { rule: RateLimits.TRADE_SUBMIT, scope: 'trade-submit' },
    idempotency: 'trades.submit',
  },
  async ({ body, user, context }) => {
    const transaction = await submitTrade({
      user,
      quoteId: body.quoteId,
      txHash: body.txHash,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      id: transaction.id,
      txHash: transaction.txHash,
      status: transaction.status,
      chainId: transaction.chainId,
      submittedAt: transaction.submittedAt.toISOString(),
    };
  },
);
