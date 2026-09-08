import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { env } from '@flt/config';
import { SectionHeader } from '@flt/ui';
import { referralSummary } from '@flt/core/services/referrals';
import { requireUserPage } from '@/server/session';
import { ReferralPanel } from '@/components/referral-panel';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleReferrals') };
}
export const dynamic = 'force-dynamic';

/**
 * Referrals.
 *
 * One level: you earn from the people you bring and from nobody they bring.
 * That is stated on the page rather than left to be inferred, because the
 * shape somebody assumes when they hear "referral programme" is usually the
 * other one, and being clear costs nothing.
 */
export default async function ReferralsPage() {
  const user = await requireUserPage();
  const summary = await referralSummary(user.id);
  const t = await getTranslations('pages.referrals');

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('title')}
        description={t('description', { pct: summary.shareBps / 100 })}
      />

      <ReferralPanel
        initialCode={summary.code?.code ?? null}
        referredCount={summary.referredCount}
        accrued={summary.accrued}
        paid={summary.paid}
        referredBy={
          summary.referredBy
            ? {
                code: summary.referredBy.code,
                redeemedAt: summary.referredBy.redeemedAt.toISOString(),
              }
            : null
        }
        shareBps={summary.shareBps}
        grantDays={summary.grantDays}
        grantTier={summary.grantTier}
        appUrl={env().WEB_APP_URL}
      />
    </div>
  );
}
