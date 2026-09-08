import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@flt/db';
import { ArrowLeft, ArrowUpRight, ShieldAlert } from 'lucide-react';
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
  Stat,
  ValueDelta,
} from '@flt/ui';
import { BASE_CHAIN_ID, explorerTokenUrl } from '@flt/core/chains';
import { formatUsd } from '@flt/core/domain';
import { requireUserPage } from '@/server/session';
import { MarketChart } from '@/components/market-chart';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  const token = await prisma.token.findFirst({
    where: { chainId: BASE_CHAIN_ID, address },
    select: { symbol: true },
  });
  const t = await getTranslations('meta');
  return { title: token ? t('titleMarketSymbol', { symbol: token.symbol }) : t('titleMarkets') };
}

/**
 * One market.
 *
 * The chart is the reason this page exists, but it is framed rather than left
 * to speak for itself: the contract address, the verification tier and the
 * provenance of the price all sit on the same screen. A chart on its own
 * invites the reader to treat the line as the truth about a token, and for an
 * arbitrary on-chain asset that is exactly the wrong inference.
 */
export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  await requireUserPage();
  const t = await getTranslations('marketDetail');
  const { address } = await params;

  const token = await prisma.token.findFirst({
    where: { chainId: BASE_CHAIN_ID, address },
    include: { marketData: true },
  });

  if (!token) notFound();

  const market = token.marketData;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/suuqyada">
          <ArrowLeft className="size-3.5" />
          {t('backToMarkets')}
        </Link>
      </Button>

      <SectionHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {token.symbol}
            <TierBadge tier={token.verificationTier} t={t} />
            {!token.isEnabled ? <Badge tone="neutral">{t('disabled')}</Badge> : null}
          </span>
        }
        description={token.name}
        action={
          token.isEnabled ? (
            <Button asChild size="sm">
              <Link href={`/iibso?buy=${token.address}`}>
                {t('trade', { symbol: token.symbol })}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          ) : null
        }
      />

      {token.verificationTier === 'UNVERIFIED' ? (
        <Notice tone="warning" icon={<ShieldAlert className="size-4" />} title={t('unreviewedTitle')}>
          {t('unreviewedBody')}
        </Notice>
      ) : null}

      {!token.isEnabled ? (
        <Notice tone="warning" title={t('disabledTitle')}>
          {token.disabledReason ?? t('disabledFallback')}
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('price')} value={formatUsd(market?.priceUsd?.toString() ?? null)} />
        <Stat
          label={t('change24h')}
          value={<ValueDelta value={market?.change24hPct?.toString() ?? null} />}
        />
        <Stat label={t('volume24h')} value={formatUsd(market?.volume24hUsd?.toString() ?? null)} />
        <Stat label={t('liquidity')} value={formatUsd(market?.liquidityUsd?.toString() ?? null)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('priceHistory')}</CardTitle>
        </CardHeader>
        <CardContent>
          <MarketChart address={token.address} symbol={token.symbol} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('contract')}</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-[var(--border)]">
          <DetailRow
            label={t('address')}
            value={
              <AddressChip
                address={token.address}
                explorerUrl={explorerTokenUrl(token.chainId, token.address)}
              />
            }
            hint={t('addressHint')}
          />
          <DetailRow label={t('chain')} value="Base" />
          <DetailRow label={t('decimals')} value={String(token.decimals)} />
          <DetailRow
            label={t('verification')}
            value={<TierBadge tier={token.verificationTier} t={t} />}
            hint={
              token.verificationTier === 'VERIFIED'
                ? t('verifiedHint')
                : token.verificationTier === 'RECOGNIZED'
                  ? t('recognizedHint')
                  : t('unverifiedHint')
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

/** Only the unreviewed case carries colour. See the note in the markets list. */
function TierBadge({
  tier,
  t,
}: {
  tier: string;
  t: Awaited<ReturnType<typeof getTranslations<'marketDetail'>>>;
}) {
  if (tier === 'VERIFIED') return <Badge tone="neutral">{t('verified')}</Badge>;
  if (tier === 'RECOGNIZED') return <Badge tone="neutral">{t('recognized')}</Badge>;
  return <Badge tone="warning">{t('unverified')}</Badge>;
}
