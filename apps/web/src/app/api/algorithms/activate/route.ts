import { z } from 'zod';
import { AlgorithmStrategy } from '@flt/db';
import { activateAlgorithm } from '@flt/core/services/algorithms';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Activate an offering.
 *
 * Frictionless — no entry cost — so this is not an idempotency-critical money
 * move; the fee accrues over time and is charged on exit. The service enforces
 * the Pro gate for the AI offering and requires a prompt for it.
 */
const schema = z.object({
  slug: z.string().trim().min(1).max(64),
  capitalBase: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal'),
  strategy: z.nativeEnum(AlgorithmStrategy).optional(),
  strategyParams: z.record(z.unknown()).optional(),
  prompt: z.string().trim().max(1_000).optional(),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'algorithm-activate' } },
  async ({ body, user, context }) => {
    const { subscription, algorithm } = await activateAlgorithm(user, body, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      id: subscription.id,
      slug: algorithm.slug,
      kind: algorithm.kind,
      status: subscription.status,
      capitalBase: subscription.capitalBase,
      managementFeeBps: algorithm.managementFeeBps,
    };
  },
);
