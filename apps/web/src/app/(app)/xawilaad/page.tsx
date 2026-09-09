import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AccountStatus, prisma } from '@flt/db';
import { Button, Notice, SectionHeader } from '@flt/ui';
import { resolveRemittanceSettings } from '@flt/core/services/platform-settings';
import { listRemittancesForUser } from '@flt/core/services/remittance';
import { requireUserPage } from '@/server/session';
import { RemittanceClient } from './remittance-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('remittance'))('title') };
}
export const dynamic = 'force-dynamic';

/**
 * Send money home: stablecoin in, EVC Plus out.
 *
 * The gates are checked here rather than inside the form. Identity
 * verification is not optional on this rail whatever the rest of the platform
 * allows — it is the one place FLT takes custody of somebody's money — and a
 * form that collects a recipient's details before saying so wastes the time of
 * the person least able to spare it.
 */
export default async function RemittancePage() {
  const user = await requireUserPage();
  const t = await getTranslations('remittance');

  const [settings, wallets, orders] = await Promise.all([
    resolveRemittanceSettings(),
    prisma.wallet.findMany({
      where: { userId: user.id, verifiedAt: { not: null } },
      orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
    }),
    listRemittancesForUser(user.id),
  ]);

  const gate = !settings.enabled ? (
    <Notice tone="warning" title={t('closedTitle')}>
      {t('closedBody')}
    </Notice>
  ) : user.accountStatus !== AccountStatus.KYC_APPROVED ? (
    <Notice tone="warning" title={t('verifyTitle')}>
      {t('verifyBody')}
      <div className="mt-3">
        <Button asChild variant="primary" size="sm">
          <Link href="/xaqiijin">{t('verifyCta')}</Link>
        </Button>
      </div>
    </Notice>
  ) : wallets.length === 0 ? (
    <Notice tone="info" title={t('walletTitle')}>
      {t('walletBody')}
      <div className="mt-3">
        <Button asChild variant="primary" size="sm">
          <Link href="/boorso">{t('walletCta')}</Link>
        </Button>
      </div>
    </Notice>
  ) : null;

  return (
    <div className="space-y-5">
      <SectionHeader title={t('title')} description={t('description')} />

      {gate}

      {!gate ? (
        <RemittanceClient
          terms={{
            feeBps: settings.feeBps,
            fxRate: settings.fxRate,
            minUsd: settings.minUsd,
            maxUsd: settings.maxUsd,
            currency: settings.currency,
          }}
          wallets={wallets.map((wallet) => ({
            id: wallet.id,
            address: wallet.address,
            chainId: wallet.chainId,
          }))}
          history={orders.map((order) => ({
            id: order.id,
            status: order.status,
            sendAmountUsd: order.sendAmountUsd,
            payoutAmount: order.payoutAmount,
            payoutCurrency: order.payoutCurrency,
            beneficiaryName: order.beneficiaryName,
            payoutReference: order.payoutReference,
            reviewNote: order.reviewNote,
            createdAt: order.createdAt.toISOString(),
          }))}
        />
      ) : null}
    </div>
  );
}
