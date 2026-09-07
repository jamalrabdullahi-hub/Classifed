import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { SectionHeader } from '@flt/ui';
import { listPlans, currentSubscription } from '@flt/core/services/subscriptions';
import { requireUserPage } from '@/server/session';
import { PlanPicker } from '@/components/plan-picker';

export const metadata: Metadata = { title: 'Plans' };
export const dynamic = 'force-dynamic';

/**
 * Pricing.
 *
 * The plans come from the database, not from this file. An operator reprices
 * in the admin panel and the page follows — a hardcoded ladder here would be
 * wrong the first time anybody changed a number, and it is exactly the kind of
 * wrong nobody notices until a customer points at it.
 */
export default async function PlansPage() {
  const user = await requireUserPage();

  const [plans, current, feeRule] = await Promise.all([
    listPlans(),
    currentSubscription(user.id),
    // The headline fee, so the discount can be shown as money rather than as a
    // percentage of something the reader has to go and look up.
    prisma.feeConfig.findFirst({
      where: { isEnabled: true, feeType: 'PERCENTAGE' },
      orderBy: { priority: 'desc' },
    }),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Plans"
        description="Tools, limits and cheaper trading. Protection is never gated — every account sees the calculation."
      />

      <PlanPicker
        plans={plans.map((plan) => ({
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
        }))}
        currentTier={current.tier}
        expiresAt={current.expiresAt?.toISOString() ?? null}
        currentSubscriptionId={current.subscription?.id ?? null}
        /**
         * The headline rate the discount is measured against.
         *
         * `??` alone is wrong here: a rule with a rate of zero is not absent,
         * and `0 ?? 25` is 0 — which collapses the break-even calculation to a
         * dash. A zero or missing rule falls back to the published 25 bps so
         * the page still says something true about what a plan saves.
         */
        baseFeeBps={feeRule?.bps && feeRule.bps > 0 ? feeRule.bps : 25}
      />
    </div>
  );
}
