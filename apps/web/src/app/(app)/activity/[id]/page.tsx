import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, getLocale } from 'next-intl/server';
import { prisma } from '@flt/db';
import { ArrowLeft, ExternalLink, ShieldAlert } from 'lucide-react';
import {
  AddressChip,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailRow,
  Notice,
  SectionHeader,
  StatusPill,
} from '@flt/ui';
import { explorerAddressUrl, explorerTokenUrl, explorerTxUrl } from '@flt/core/chains';
import { formatTokenAmount } from '@flt/core/domain';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleTransaction') };
}
export const dynamic = 'force-dynamic';

/**
 * One transaction.
 *
 * The settlement record: what was quoted, what the chain actually did, and the
 * timeline of how it got there. The two sets of numbers are shown side by side
 * rather than merged, because the expectation and the outcome are different
 * facts and a user is entitled to compare them.
 */
export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUserPage();
  const t = await getTranslations('activityDetail');
  const locale = await getLocale();
  const { id } = await params;

  // Scoped by user id: a transaction id alone must never be enough to read
  // someone else's settlement record.
  const transaction = await prisma.transaction.findFirst({
    where: { id, userId: user.id },
    include: {
      events: { orderBy: { occurredAt: 'asc' } },
      quote: true,
      wallet: true,
    },
  });

  if (!transaction) notFound();

  const [sellToken, buyToken] = await Promise.all([
    transaction.sellTokenAddress
      ? prisma.token.findFirst({
          where: { chainId: transaction.chainId, address: transaction.sellTokenAddress },
        })
      : null,
    transaction.buyTokenAddress
      ? prisma.token.findFirst({
          where: { chainId: transaction.chainId, address: transaction.buyTokenAddress },
        })
      : null,
  ]);

  const isSwap = transaction.kind === 'SWAP';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/activity">
          <ArrowLeft className="size-3.5" />
          {t('backToActivity')}
        </Link>
      </Button>

      <SectionHeader
        title={isSwap ? t('swap') : t('tokenApproval')}
        description={t('submitted', { when: transaction.submittedAt.toLocaleString(locale) })}
        action={
          <StatusBadge status={transaction.status} tampered={transaction.tamperDetected} t={t} />
        }
      />

      {transaction.tamperDetected ? (
        <Notice tone="negative" icon={<ShieldAlert className="size-4" />} title={t('mismatchTitle')}>
          {t('mismatchBody')}
        </Notice>
      ) : null}

      {transaction.status === 'REVERTED' ? (
        <Notice tone="warning" title={t('revertedTitle')}>
          {t('revertedBody')}
        </Notice>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('onChain')}</CardTitle>
          <a
            href={explorerTxUrl(transaction.chainId, transaction.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[13px] link"
          >
            {t('viewOnExplorer')}
            <ExternalLink className="size-3.5" />
          </a>
        </CardHeader>
        <CardContent className="divide-y divide-[var(--border)]">
          <DetailRow
            label={t('txHash')}
            value={
              <span className="num break-all font-mono text-[11px]">{transaction.txHash}</span>
            }
          />
          <DetailRow label={t('block')} value={transaction.blockNumber?.toString() ?? '—'} />
          <DetailRow
            label={t('networkFeePaid')}
            value={
              transaction.networkFeePaid
                ? `${formatTokenAmount(transaction.networkFeePaid, 18)} ETH`
                : '—'
            }
            hint={t('networkFeeHint')}
          />
          <DetailRow
            label={t('signedBy')}
            value={
              <AddressChip
                address={transaction.wallet.address}
                explorerUrl={explorerAddressUrl(transaction.chainId, transaction.wallet.address)}
              />
            }
          />
        </CardContent>
      </Card>

      {isSwap && transaction.quote ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('quotedAgainstSettled')}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-[var(--border)]">
            <DetailRow
              label={t('sold')}
              value={
                sellToken
                  ? `${formatTokenAmount(transaction.quote.sellAmount, sellToken.decimals)} ${sellToken.symbol}`
                  : transaction.quote.sellAmount
              }
            />
            <DetailRow
              label={t('expectedToReceive')}
              value={
                buyToken
                  ? `${formatTokenAmount(transaction.quote.buyAmount, buyToken.decimals)} ${buyToken.symbol}`
                  : transaction.quote.buyAmount
              }
              hint={t('expectedHint')}
            />
            <DetailRow
              label={t('minimumAccepted')}
              value={
                buyToken
                  ? `${formatTokenAmount(transaction.quote.minBuyAmount, buyToken.decimals)} ${buyToken.symbol}`
                  : transaction.quote.minBuyAmount
              }
              hint={t('minimumHint')}
            />
            <DetailRow
              label={t('actuallyReceived')}
              value={
                transaction.amountOutActual && buyToken ? (
                  `${formatTokenAmount(transaction.amountOutActual, buyToken.decimals)} ${buyToken.symbol}`
                ) : (
                  <span className="text-[var(--text-subtle)]">—</span>
                )
              }
              hint={
                transaction.amountOutActual
                  ? t('readFromLogs')
                  : transaction.status === 'CONFIRMED'
                    ? t('couldNotReadLogs')
                    : t('notSettledYet')
              }
              emphasis
            />
          </CardContent>
        </Card>
      ) : null}

      {sellToken || buyToken ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('tokens')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sellToken ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] text-[var(--text-muted)]">
                  {isSwap ? t('sold') : t('approved')} · {sellToken.symbol}
                </span>
                <AddressChip
                  address={sellToken.address}
                  explorerUrl={explorerTokenUrl(sellToken.chainId, sellToken.address)}
                />
              </div>
            ) : null}
            {buyToken ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] text-[var(--text-muted)]">
                  {t('bought')} · {buyToken.symbol}
                </span>
                <AddressChip
                  address={buyToken.address}
                  explorerUrl={explorerTokenUrl(buyToken.chainId, buyToken.address)}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('timeline')}</CardTitle>
          <Badge tone="neutral">{t('eventsCount', { count: transaction.events.length })}</Badge>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4">
            {transaction.events.map((event, index) => (
              <li key={event.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className="mt-1 size-2 shrink-0 rounded-full bg-[var(--accent)]"
                    aria-hidden="true"
                  />
                  {index < transaction.events.length - 1 ? (
                    <span className="mt-1 w-px flex-1 bg-[var(--border)]" aria-hidden="true" />
                  ) : null}
                </div>
                <div className="min-w-0 pb-1">
                  <p className="text-[13px] font-medium text-[var(--text)]">
                    {event.status.charAt(0) + event.status.slice(1).toLowerCase()}
                  </p>
                  {event.detail ? (
                    <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                      {event.detail}
                    </p>
                  ) : null}
                  <p className="num mt-0.5 text-[11px] text-[var(--text-subtle)]">
                    {event.occurredAt.toLocaleString(locale)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
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
