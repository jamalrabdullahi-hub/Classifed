import { z } from 'zod';
import { SubscriptionTier } from '@flt/db';
import {
  cancelSubscription,
  confirmSubscription,
  currentSubscription,
  listPlans,
  prepareSubscription,
} from '@flt/core/services/subscriptions';
import { entitlementsFor } from '@flt/core/services/entitlements';
import { handler } from '@/server/api';

/**
 * Plans, and the participant's own subscription.
 *
 * GET  the ladder plus what this account currently has.
 * POST choose a plan; returns the transfer that activates it.
 * PUT  confirm payment, verified against the receipt on-chain.
 * DELETE cancel. The period is not refunded, because no balance is held.
 */
export const GET = handler({}, async ({ user }) => {
  const [plans, current, entitlements] = await Promise.all([
    listPlans(),
    currentSubscription(user.id),
    entitlementsFor(user.id),
  ]);

  return {
    plans: plans.map((plan) => ({
      tier: plan.tier,
      name: plan.name,
      tagline: plan.tagline,
      priceUsd: plan.priceUsd,
      isFeatured: plan.isFeatured,
      feeDiscountBps: plan.feeDiscountBps,
      maxLeverage: plan.maxLeverage,
      watchlistLimit: plan.watchlistLimit,
      priceAlertLimit: plan.priceAlertLimit,
      historyDays: plan.historyDays,
      advancedOrderTools: plan.advancedOrderTools,
      fullIndicators: plan.fullIndicators,
      advancedRiskAnalytics: plan.advancedRiskAnalytics,
      advancedProtectionAnalytics: plan.advancedProtectionAnalytics,
      fundingAnalytics: plan.fundingAnalytics,
      advancedPnl: plan.advancedPnl,
      fullPnl: plan.fullPnl,
      apiAccess: plan.apiAccess,
      priorityData: plan.priorityData,
      prioritySupport: plan.prioritySupport,
    })),
    current: {
      tier: current.tier,
      expiresAt: current.expiresAt,
      subscriptionId: current.subscription?.id ?? null,
    },
    /** What this account can do right now, so the interface never re-derives it. */
    entitlements: {
      tier: entitlements.tier,
      planName: entitlements.planName,
      feeDiscountBps: entitlements.feeDiscountBps,
      maxLeverage: entitlements.maxLeverage,
    },
  };
});

export const POST = handler(
  { schema: z.object({ tier: z.nativeEnum(SubscriptionTier) }) },
  async ({ user, body }) => {
    const prepared = await prepareSubscription(user, body.tier);

    return {
      subscriptionId: prepared.subscriptionId,
      plan: { tier: prepared.plan.tier, name: prepared.plan.name },
      priceUsd: prepared.priceUsd,
      amountBaseUnits: prepared.amountBaseUnits,
      transfer: prepared.transfer,
      carriedOverDays: prepared.carriedOverDays,
      note: prepared.note,
    };
  },
);

export const PUT = handler(
  {
    schema: z.object({
      subscriptionId: z.string().trim().min(1),
      txHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Not a transaction hash'),
    }),
  },
  async ({ user, body }) => {
    const subscription = await confirmSubscription(body.subscriptionId, user, body.txHash);

    return {
      tier: subscription.tier,
      status: subscription.status,
      endsAt: subscription.endsAt,
      note: 'Payment verified on-chain. Your plan is active.',
    };
  },
);

export const DELETE = handler(
  { schema: z.object({ subscriptionId: z.string().trim().min(1) }) },
  async ({ user, body }) => {
    const subscription = await cancelSubscription(body.subscriptionId, user);

    return {
      status: subscription.status,
      note:
        'Cancelled. The period you paid for is not refunded — FLT holds no balance to refund ' +
        'from — but nothing further will be charged, because nothing ever could be.',
    };
  },
);
