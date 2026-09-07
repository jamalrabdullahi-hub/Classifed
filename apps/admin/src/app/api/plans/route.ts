import { z } from 'zod';
import { SubscriptionTier } from '@flt/db';
import { updatePlan } from '@flt/core/services/subscriptions';
import { PERMISSIONS } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Repricing a plan.
 *
 * Changes the definition only. A running subscription keeps the price it was
 * sold at — `Subscription.pricePaidUsd` records what was actually charged, so a
 * price change can never rewrite somebody's history.
 *
 * Gated on MANAGE_FEES at the route and narrowed to SUPER_ADMIN in the service:
 * pricing is revenue, and it is deliberately held to the same bar as the fee
 * table rather than to an ordinary operator permission.
 */
const nullableInt = z.union([z.coerce.number().int().min(0), z.null()]);

const schema = z.object({
  tier: z.nativeEnum(SubscriptionTier),
  name: z.string().trim().min(1).max(60).optional(),
  tagline: z.string().trim().min(1).max(160).optional(),
  /** Dollars, at most two decimals. */
  priceUsd: z.string().trim().regex(/^\d+(\.\d{1,2})?$/).optional(),
  isFeatured: z.coerce.boolean().optional(),
  isAvailable: z.coerce.boolean().optional(),
  /** Basis points of the fee, not of notional. */
  feeDiscountBps: z.coerce.number().int().min(0).max(10_000).optional(),
  maxLeverage: z.coerce.number().int().min(1).max(100).optional(),
  watchlistLimit: nullableInt.optional(),
  priceAlertLimit: nullableInt.optional(),
  historyDays: nullableInt.optional(),
  advancedOrderTools: z.coerce.boolean().optional(),
  fullIndicators: z.coerce.boolean().optional(),
  advancedRiskAnalytics: z.coerce.boolean().optional(),
  advancedProtectionAnalytics: z.coerce.boolean().optional(),
  fundingAnalytics: z.coerce.boolean().optional(),
  advancedPnl: z.coerce.boolean().optional(),
  fullPnl: z.coerce.boolean().optional(),
  apiAccess: z.coerce.boolean().optional(),
  priorityData: z.coerce.boolean().optional(),
  prioritySupport: z.coerce.boolean().optional(),
  reason: reasonSchema,
});

export const POST = adminHandler(
  { schema, permission: PERMISSIONS.MANAGE_FEES },
  async ({ admin, body }) => {
    const plan = await updatePlan(admin, body);

    return {
      plan: {
        tier: plan.tier,
        name: plan.name,
        priceUsd: plan.priceUsd,
        feeDiscountBps: plan.feeDiscountBps,
        maxLeverage: plan.maxLeverage,
        isFeatured: plan.isFeatured,
        isAvailable: plan.isAvailable,
        updatedAt: plan.updatedAt,
      },
    };
  },
);
