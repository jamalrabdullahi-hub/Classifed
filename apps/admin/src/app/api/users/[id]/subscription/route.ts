import { z } from 'zod';
import { SubscriptionTier } from '@flt/db';
import { PERMISSIONS } from '@flt/core/services/admin';
import { grantSubscription } from '@flt/core/services/subscriptions';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Grants a subscription period to an account without a payment.
 *
 * The service function re-checks MANAGE_SUBSCRIPTIONS itself (same pattern
 * as `setAccountType` re-checking MANAGE_FEES) — the permission named here
 * is what actually gates the route, and it happens to be the same one.
 */
const schema = z.object({
  tier: z.nativeEnum(SubscriptionTier),
  days: z.coerce.number().int().min(1).max(3650),
  reason: reasonSchema,
});

export const POST = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { permission: PERMISSIONS.MANAGE_SUBSCRIPTIONS, schema },
  async ({ body, params, admin, context }) => {
    const subscription = await grantSubscription(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      { targetUserId: params.id, tier: body.tier, days: body.days, reason: body.reason },
    );
    return { tier: subscription.tier, endsAt: subscription.endsAt };
  },
);
