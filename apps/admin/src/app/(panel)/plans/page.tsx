import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { Badge, Notice, SectionHeader } from '@flt/ui';
import { planSummary } from '@flt/core/services/subscriptions';
import { PlanEditor } from '@/components/plan-editor';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Plans' };
export const dynamic = 'force-dynamic';

/**
 * Subscription pricing.
 *
 * The leverage warning at the top is the point of this page as much as the
 * editors are: a plan can advertise 50x while PERP_MAX_LEVERAGE holds every
 * account to 10, and that mismatch is invisible everywhere else. An operator
 * setting a number that does nothing should be told so on the screen where they
 * set it.
 */
export default async function PlansPage() {
  const admin = await requireAdminPage();
  const config = env();

  const [plans, feeRule, pendingCount] = await Promise.all([
    planSummary(),
    prisma.feeConfig.findFirst({
      where: { isEnabled: true, feeType: 'PERCENTAGE' },
      orderBy: { priority: 'desc' },
    }),
    prisma.subscription.count({ where: { status: 'PENDING_PAYMENT' } }),
  ]);

  const canEdit = admin.role === 'SUPER_ADMIN';
  const baseFeeBps = feeRule?.bps && feeRule.bps > 0 ? feeRule.bps : 25;

  // Plans whose leverage the platform cap silently overrides.
  const capped = plans.filter((plan) => plan.maxLeverage > config.PERP_MAX_LEVERAGE);
  const distinctEffective = new Set(
    plans.filter((p) => p.tier !== 'FREE').map((p) => Math.min(p.maxLeverage, config.PERP_MAX_LEVERAGE)),
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Plans"
        description="Pricing, limits and capabilities. Changes apply to new purchases only — existing subscribers keep the price they paid."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone="neutral">
          {plans.reduce((sum, plan) => sum + plan.activeCount, 0)} active subscribers
        </Badge>
        <Badge tone="neutral">{pendingCount} awaiting payment</Badge>
        <Badge tone="neutral">Platform cap {config.PERP_MAX_LEVERAGE}x</Badge>
        <Badge tone="neutral">Base fee {baseFeeBps} bps</Badge>
      </div>

      {capped.length > 0 ? (
        <Notice tone="warning" title="Leverage is capped below what these plans advertise">
          PERP_MAX_LEVERAGE is {config.PERP_MAX_LEVERAGE}, so {capped.map((p) => p.name).join(', ')}{' '}
          {capped.length === 1 ? 'effectively allows' : 'effectively allow'}{' '}
          {config.PERP_MAX_LEVERAGE}x rather than the number set here.
          {distinctEffective.size === 1 ? (
            <>
              {' '}
              Every paid tier currently resolves to the same {config.PERP_MAX_LEVERAGE}x, so
              leverage is not differentiating the ladder at all. Raise the environment cap, or lower
              the lower tiers, for the difference to mean anything.
            </>
          ) : null}
        </Notice>
      ) : null}

      {!canEdit ? (
        <Notice tone="warning" title="Read only">
          Only a super admin may change pricing. Plan prices are revenue, and are held to the same
          bar as the fee table rather than to an ordinary operator permission.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
        {plans.map((plan) =>
          canEdit ? (
            <PlanEditor
              key={plan.tier}
              plan={{
                tier: plan.tier,
                name: plan.name,
                tagline: plan.tagline,
                priceUsd: plan.priceUsd,
                isFeatured: plan.isFeatured,
                isAvailable: plan.isAvailable,
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
                activeCount: plan.activeCount,
              }}
              platformMaxLeverage={config.PERP_MAX_LEVERAGE}
              baseFeeBps={baseFeeBps}
            />
          ) : (
            <div
              key={plan.tier}
              className="space-y-1 rounded-[var(--radius-lg)] border border-[var(--border)] p-4 text-[12px]"
            >
              <h3 className="text-[14px] font-semibold text-[var(--text)]">{plan.name}</h3>
              <p className="num text-[var(--text-muted)]">${plan.priceUsd} / 30 days</p>
              <p className="text-[var(--text-subtle)]">
                {plan.feeDiscountBps / 100}% off fees · up to{' '}
                {Math.min(plan.maxLeverage, config.PERP_MAX_LEVERAGE)}x · {plan.activeCount} active
              </p>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
