import { env } from '@flt/config';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@flt/db';
import { SectionHeader } from '@flt/ui';
import { listPlans, currentSubscription } from '@flt/core/services/subscriptions';
import { entitlementsFor } from '@flt/core/services/entitlements';
import { requireUserPage } from '@/server/session';
import { UpgradePitch } from '@/components/upgrade-pitch';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleUpgrade') };
}
export const dynamic = 'force-dynamic';

/**
 * The upgrade pitch.
 *
 * Separate from `/plans`, which is a comparison table for somebody who has
 * already decided to look. This answers the earlier question — "why would I pay
 * for this?" — as arithmetic rather than as a feature list.
 *
 * ## Why the volume is typed rather than measured
 *
 * Trade amounts are stored in each token's base units, and the USD price at the
 * moment of the fill is not kept. A dollar volume therefore cannot be recovered
 * from history without repricing every trade at today's prices and presenting
 * the result as what somebody traded — a fabricated number in exactly the place
 * the reader is being asked to trust one.
 *
 * So the trade count is real and comes from confirmed transactions, and the
 * volume is theirs to state. The arithmetic on top of it is then honest.
 */
export default async function UpgradePage() {
  const user = await requireUserPage();
  const t = await getTranslations('pages.upgrade');

  const since = new Date(Date.now() - 90 * 86_400_000);

  const [plans, current, entitlements, tradeCount, feeRule] = await Promise.all([
    listPlans(),
    currentSubscription(user.id),
    entitlementsFor(user.id),
    prisma.transaction.count({
      where: { userId: user.id, status: 'CONFIRMED', submittedAt: { gte: since } },
    }),
    prisma.feeConfig.findFirst({
      where: { isEnabled: true, feeType: 'PERCENTAGE' },
      orderBy: { priority: 'desc' },
    }),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />

      <UpgradePitch
        plans={plans.map((plan) => ({
          tier: plan.tier,
          name: plan.name,
          tagline: plan.tagline,
          priceUsd: plan.priceUsd,
          isFeatured: plan.isFeatured,
          feeDiscountBps: plan.feeDiscountBps,
          maxLeverage: Math.min(plan.maxLeverage, env().PERP_MAX_LEVERAGE),
          apiAccess: plan.apiAccess,
          advancedRiskAnalytics: plan.advancedRiskAnalytics,
        }))}
        currentTier={current.tier}
        currentMaxLeverage={entitlements.maxLeverage}
        tradeCount={tradeCount}
        baseFeeBps={feeRule?.bps && feeRule.bps > 0 ? feeRule.bps : 25}
      />

      <p className="text-[11px] text-[var(--text-subtle)]">
        {t('preferFullComparison')}{' '}
        <Link href="/qorshayaal" className="underline">
          {t('seeSideBySide')}
        </Link>
        .
      </p>
    </div>
  );
}
