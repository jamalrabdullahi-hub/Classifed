import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BASE_CHAIN_ID } from '@flt/core/chains';
import { custodyPortfolio } from '@flt/core/services/portfolio-usd';
import { listWithdrawalsForUser } from '@flt/core/services/withdrawals';
import { SectionHeader } from '@flt/ui';
import { requireUserPage } from '@/server/session';
import { WithdrawClient } from './withdraw-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('withdrawPage'))('title') };
}
export const dynamic = 'force-dynamic';

/**
 * Taking money out of custody.
 *
 * The account's spendable holdings come from the custody ledger, not the chain.
 * A request reserves the amount and the worker sends it from the omnibus — the
 * balance moves when the transfer is confirmed, not when it is asked for.
 */
export default async function WithdrawPage() {
  const user = await requireUserPage();
  const t = await getTranslations('withdrawPage');

  const [portfolio, withdrawals] = await Promise.all([
    custodyPortfolio(user.id),
    listWithdrawalsForUser(user.id),
  ]);

  return (
    <div className="space-y-5">
      <SectionHeader title={t('title')} description={t('description')} />

      <WithdrawClient
        chainId={BASE_CHAIN_ID}
        assets={portfolio.holdings.map((holding) => ({
          asset: holding.asset,
          available: holding.available,
        }))}
        history={withdrawals.map((withdrawal) => ({
          id: withdrawal.id,
          asset: withdrawal.asset,
          amount: withdrawal.amount,
          destinationAddress: withdrawal.destinationAddress,
          txHash: withdrawal.txHash,
          status: withdrawal.status,
          failureReason: withdrawal.failureReason,
          createdAt: withdrawal.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
