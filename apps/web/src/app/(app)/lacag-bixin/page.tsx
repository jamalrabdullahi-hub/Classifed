import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SubscriptionTier, prisma } from '@flt/db';
import { Button, Notice, SectionHeader } from '@flt/ui';
import { resolveEvcSettings } from '@flt/core/services/platform-settings';
import { listEvcPaymentsForUser } from '@flt/core/services/evc';
import { requireUserPage } from '@/server/session';
import { EvcCheckout } from './evc-checkout';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('checkout'))('title') };
}
export const dynamic = 'force-dynamic';

/**
 * Checkout for anything FLT sells that is not a trade.
 *
 * Trading is settled from the participant's own wallet and never comes through
 * here. This page is for the things FLT actually charges for — today that is a
 * subscription — paid over EVC Plus, which is how most people in the market
 * this serves actually move money.
 *
 * The tier arrives as `?tier=`. An absent or unknown one sends the reader back
 * to the pricing table rather than guessing which plan they meant.
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string }>;
}) {
  const user = await requireUserPage();
  const t = await getTranslations('checkout');
  const params = await searchParams;

  const requested = String(params.tier ?? '').toUpperCase();
  const tier = (Object.values(SubscriptionTier) as string[]).includes(requested)
    ? (requested as SubscriptionTier)
    : null;

  const [settings, plan, kyc, payments] = await Promise.all([
    resolveEvcSettings(),
    tier && tier !== SubscriptionTier.FREE
      ? prisma.subscriptionPlan.findUnique({ where: { tier } })
      : Promise.resolve(null),
    prisma.kycProfile.findUnique({
      where: { userId: user.id },
      select: { legalFirstName: true, legalLastName: true },
    }),
    listEvcPaymentsForUser(user.id),
  ]);

  if (!plan || !plan.isAvailable) {
    return (
      <div className="space-y-5">
        <SectionHeader title={t('title')} description={t('description')} />
        <Notice tone="info" title={t('noPlanTitle')}>
          {t('noPlanBody')}
          <div className="mt-3">
            <Button asChild variant="primary" size="sm">
              <Link href="/qorshayaal">{t('seePlans')}</Link>
            </Button>
          </div>
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHeader title={t('title')} description={t('description')} />

      {!settings.enabled ? (
        <Notice tone="warning" title={t('unavailableTitle')}>
          {t('unavailableBody')}
        </Notice>
      ) : null}

      <EvcCheckout
        tier={plan.tier}
        planName={plan.name}
        priceUsd={plan.priceUsd}
        merchantNumber={settings.merchantNumber}
        available={settings.enabled}
        defaultName={[kyc?.legalFirstName, kyc?.legalLastName].filter(Boolean).join(' ')}
        email={user.email}
        history={payments.map((payment) => ({
          id: payment.id,
          tier: payment.tier,
          amountUsd: payment.amountUsd,
          status: payment.status,
          reviewNote: payment.reviewNote,
          createdAt: payment.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
