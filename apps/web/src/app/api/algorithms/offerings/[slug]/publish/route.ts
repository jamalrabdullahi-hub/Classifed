import { z } from 'zod';
import { setAlgorithmPublished } from '@flt/core/services/algorithms';
import { RateLimits } from '@flt/core/services/ratelimit';
import { routeHandler } from '@/server/api';

/**
 * Publish or unpublish a creator's offering.
 *
 * Publishing sets it to PENDING_REVIEW with a 50% creator share; an operator
 * approves it to PUBLIC. Unpublishing returns it to PRIVATE. Ownership is
 * enforced in the service (`creatorId` must match), so a stranger's slug yields
 * NOT_FOUND.
 */
const schema = z.object({ publish: z.coerce.boolean() });

export const POST = routeHandler<z.infer<typeof schema>, { slug: string }, unknown>(
  { schema, rateLimit: { rule: RateLimits.API_GENERAL, scope: 'algorithm-publish' } },
  async ({ body, params, user, context }) => {
    const row = await setAlgorithmPublished(user, params.slug, body.publish, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
    return { slug: row.slug, visibility: row.visibility, revenueShareBps: row.revenueShareBps };
  },
);
