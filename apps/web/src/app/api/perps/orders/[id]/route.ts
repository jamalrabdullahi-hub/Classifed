import { z } from 'zod';
import { recordSubmission } from '@flt/core/services/perps';
import { routeHandler } from '@/server/api';

/**
 * Records that the client submitted a prepared order.
 *
 * This is the client's claim, not FLT's observation. Because FLT never posts to
 * the venue, it cannot witness a submission — the worker reconciles against the
 * venue's own record and is what actually moves an order to filled. Recording
 * the claim still matters: an order prepared and never reported is a real
 * state, and distinguishing it from one that filled is the difference between
 * a user who changed their mind and a submission that silently failed.
 */
const schema = z.object({
  venueOrderId: z.string().trim().max(128).nullish(),
});

export const POST = routeHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { schema },
  async ({ body, params, user, context }) => {
    const order = await recordSubmission({
      orderId: params.id,
      userId: user.id,
      venueOrderId: body.venueOrderId ?? null,
      ip: context.ip,
    });

    return {
      id: order.id,
      status: order.status,
      submittedAt: order.submittedAt?.toISOString() ?? null,
    };
  },
);
