import { z } from 'zod';
import { purchaseAlgorithm } from '@flt/core/services/algorithms';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Buy an algorithm.
 *
 * The debit is on the custody ledger, so this is idempotent on the ledger
 * reference and the route requires an `Idempotency-Key` — a retried purchase
 * after a dropped connection charges once, not twice.
 */
const schema = z.object({
  slug: z.string().trim().min(1).max(64),
});

export const POST = handler(
  {
    schema,
    idempotency: 'algorithms.purchase',
    rateLimit: { rule: RateLimits.QUOTE, scope: 'algorithm-purchase' },
  },
  async ({ body, user, context }) => {
    const { subscription, algorithm } = await purchaseAlgorithm(user, body.slug, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      id: subscription.id,
      slug: algorithm.slug,
      name: algorithm.name,
      status: subscription.status,
      pricePaidUsd: subscription.pricePaidUsd,
      endsAt: subscription.endsAt,
    };
  },
);
