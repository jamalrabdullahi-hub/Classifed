import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@flt/db';
import { Button, Notice, SectionHeader } from '@flt/ui';
import { BASE_CHAIN_ID, explorerAddressUrl } from '@flt/core/chains';
import { resolveEvcSettings, resolveFiatDepositSettings } from '@flt/core/services/platform-settings';
import { listFiatDepositsForUser } from '@flt/core/services/fiat-deposits';
import { requireUserPage } from '@/server/session';
import { DepositClient } from './deposit-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('deposit'))('title') };
}
export const dynamic = 'force-dynamic';

/**
 * Putting money in.
 *
 * The screen refuses before it collects, in two places. Without an FLT wallet
 * there is nowhere for the crypto to land, and taking a wire first would leave
 * an operator holding cash with no destination. Without instructions written by
 * whoever runs the bank account, there is nothing true to tell somebody about
 * where to send it.
 *
 * Both are checked here rather than at submission, because the failure a
 * participant should never have is discovering after transferring money that
 * FLT could not accept it.
 */
export default async function DepositPage() {
  const user = await requireUserPage();
  const t = await getTranslations('deposit');

  const [settings, evc, wallet, deposits] = await Promise.all([
    resolveFiatDepositSettings(),
    resolveEvcSettings(),
    prisma.wallet.findFirst({
      where: { userId: user.id, connector: 'privy-embedded' },
      select: { address: true },
    }),
    listFiatDepositsForUser(user.id),
  ]);

  if (!wallet) {
    return (
      <div className="space-y-5">
        <SectionHeader title={t('title')} description={t('description')} />
        <Notice tone="info" title={t('needsWalletTitle')}>
          {t('needsWalletBody')}
          <div className="mt-3">
            <Button asChild variant="primary" size="sm">
              <Link href="/boorso">{t('goToWallet')}</Link>
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

      <DepositClient
        available={settings.enabled}
        minUsd={settings.minUsd}
        feeBps={settings.feeBps}
        explorerUrl={explorerAddressUrl(BASE_CHAIN_ID, wallet.address)}
        evcMerchantNumber={evc.merchantNumber}
        walletAddress={wallet.address}
        history={deposits.map((deposit) => ({
          id: deposit.id,
          reference: deposit.reference,
          method: deposit.method,
          currency: deposit.currency,
          amountFiat: deposit.amountFiat.toString(),
          netUsd: deposit.netUsd?.toString() ?? null,
          status: deposit.status,
          note: deposit.note,
          createdAt: deposit.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
