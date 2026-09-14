import { env } from '@flt/config';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SubscriptionTier, prisma } from '@flt/db';
import { SectionHeader } from '@flt/ui';
import { listPlans, currentSubscription } from '@flt/core/services/subscriptions';
import { resolveEvcSettings } from '@flt/core/services/platform-settings';
import { currentUser } from '@/server/session';
import { PlanPicker } from '@/components/plan-picker';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titlePlans') };
}
export const dynamic = 'force-dynamic';

/**
 * Pricing.
 *
 * The plans come from the database, not from this file. An operator reprices
 * in the admin panel and the page follows — a hardcoded ladder here would be
 * wrong the first time anybody changed a number, and it is exactly the kind of
 * wrong nobody notices until a customer points at it.
 *
 * ## Public
 *
 * Someone deciding whether to open an account should be able to see what a
 * plan actually costs before they do — a comparison table is a poor thing to
 * hide behind a login form. A signed-out visitor sees the same table with no
 * current plan and every "Choose" button asking them to sign in first.
 */
export default async function PlansPage() {
  const user = await currentUser();
  const t = await getTranslations('plans');

  const [plans, current, feeRule, evc] = await Promise.all([
    listPlans(),
    user
      ? currentSubscription(user.id)
      : Promise.resolve({ tier: SubscriptionTier.FREE, expiresAt: null, subscription: null }),
    // The headline fee, so the discount can be shown as money rather than as a
    // percentage of something the reader has to go and look up.
    prisma.feeConfig.findFirst({
      where: { isEnabled: true, feeType: 'PERCENTAGE' },
      orderBy: { priority: 'desc' },
    }),
    resolveEvcSettings(),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />

      <PlanPicker
        plans={plans.map((plan) => ({
          tier: plan.tier,
          name: plan.name,
          tagline: plan.tagline,
          priceUsd: plan.priceUsd,
          isFeatured: plan.isFeatured,
          feeDiscountBps: plan.feeDiscountBps,
          maxLeverage: Math.min(plan.maxLeverage, env().PERP_MAX_LEVERAGE),
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
        guest={!user}
        /* Only offered to somebody with an account: the claim is recorded
           against a user, so there is nothing to record for a visitor. */
        evcAvailable={evc.enabled && !!user}
      />
    </div>
  );
}
