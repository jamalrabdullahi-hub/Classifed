import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import { prisma } from '@flt/db';
import { ExternalLink, Receipt, ShieldAlert } from 'lucide-react';
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  SectionHeader,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { explorerTxUrl } from '@flt/core/chains';
import { truncateMiddle } from '@flt/ui';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleActivity') };
}
export const dynamic = 'force-dynamic';

/**
 * Activity.
 *
 * A record of what happened on-chain, not a record of what we intended.
 * Approvals appear alongside swaps because a first-time trade needs two wallet
 * prompts, and a user who sees only one of them in their history will wonder
 * what the other transaction was.
 */
export default async function ActivityPage() {
  const user = await requireUserPage();
  const t = await getTranslations('pages.activity');
  const ts = await getTranslations('activityDetail');
  const locale = await getLocale();

  const transactions = await prisma.transaction.findMany({
    where: { userId: user.id },
    orderBy: { submittedAt: 'desc' },
    take: 100,
  });

  const flagged = transactions.filter((transaction) => transaction.tamperDetected);

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />

      {flagged.length > 0 ? (
        <Notice tone="negative" icon={<ShieldAlert className="size-4" />} title={t('flaggedTitle')}>
          {t('flaggedBody', {
            which:
              flagged.length === 1
                ? t('oneTransaction')
                : t('manyTransactions', { count: flagged.length }),
          })}
        </Notice>
      ) : null}

      <Card>
        {transactions.length === 0 ? (
          <EmptyState
            icon={<Receipt className="size-4" />}
            title={t('noActivityTitle')}
            description={t('noActivityBody')}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t('colType')}</TH>
                <TH>{t('colTransaction')}</TH>
                <TH>{t('colStatus')}</TH>
                <TH numeric>{t('colReceived')}</TH>
                <TH numeric>{t('colSubmitted')}</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {transactions.map((transaction) => (
                <TR key={transaction.id}>
                  <TD>
                    <Badge tone={transaction.kind === 'SWAP' ? 'accent' : 'neutral'}>
                      {transaction.kind === 'SWAP' ? t('swap') : t('approval')}
                    </Badge>
                  </TD>
                  <TD>
                    <Link
                      href={`/dhaqdhaqaaq/${transaction.id}`}
                      className="num font-mono text-[12px] link"
                    >
                      {truncateMiddle(transaction.txHash, 10, 8)}
                    </Link>
                  </TD>
                  <TD>
                    <StatusBadge
                      status={transaction.status}
                      tampered={transaction.tamperDetected}
                      t={ts}
                    />
                  </TD>
                  <TD numeric>
                    {transaction.amountOutActual ? (
                      <span className="text-[12px]">{t('onChainLabel')}</span>
                    ) : (
                      <span className="text-[var(--text-subtle)]">—</span>
                    )}
                  </TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {transaction.submittedAt.toLocaleString(locale)}
                    </span>
                  </TD>
                  <TD>
                    <a
                      href={explorerTxUrl(transaction.chainId, transaction.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--text-subtle)] hover:text-[var(--text)]"
                      aria-label={t('viewOnExplorerAria')}
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function StatusBadge({
  status,
  tampered,
  t,
}: {
  status: string;
  tampered: boolean;
  t: Awaited<ReturnType<typeof getTranslations<'activityDetail'>>>;
}) {
  if (tampered) return <StatusPill tone="negative">{t('mismatch')}</StatusPill>;
  if (status === 'CONFIRMED') return <StatusPill tone="positive">{t('confirmed')}</StatusPill>;
  if (status === 'REVERTED') return <StatusPill tone="negative">{t('reverted')}</StatusPill>;
  if (status === 'FAILED') return <StatusPill tone="negative">{t('failed')}</StatusPill>;
  if (status === 'DROPPED') return <StatusPill tone="warning">{t('dropped')}</StatusPill>;
  return (
    <StatusPill tone="info" pulse>
      {t('pending')}
    </StatusPill>
  );
}
