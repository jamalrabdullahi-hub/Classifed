import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import { prisma } from '@flt/db';
import { ShieldAlert } from 'lucide-react';
import {
  AddressChip,
  Badge,
  Card,
  EmptyState,
  Notice,
  SectionHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  ValueDelta,
} from '@flt/ui';
import { BASE_CHAIN_ID, explorerTokenUrl } from '@flt/core/chains';
import { formatUsd } from '@flt/core/domain';
import { requireUserPage } from '@/server/session';
import { InstrumentSearch } from '@/components/instrument-search';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleScanner') };
}

/** How many rows to render without a query. */
const DEFAULT_ROWS = 100;
export const dynamic = 'force-dynamic';

/**
 * Markets.
 *
 * A controlled registry, not a list of everything on-chain. Every row shows its
 * contract address and its verification tier, because a token existing is not
 * evidence that it is safe, and the brief is explicit that arbitrary tokens
 * must not be presented as trusted.
 *
 * Prices, volume and liquidity come from a third party and are labelled as
 * estimates. A field the provider did not give us renders as "—" rather than
 * as zero.
 */
export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireUserPage();
  const t = await getTranslations('pages.scanner');
  const tierT = await getTranslations('marketDetail');
  const locale = await getLocale();

  const { q } = await searchParams;
  const query = (q ?? '').trim();

  /**
   * Bounded by default.
   *
   * The registry went from seven hand-picked tokens to 2,675 imported ones, and
   * rendering all of them server-side produces a page nobody scrolls and a
   * response nobody waits for. Reviewed tokens first, then the rest
   * alphabetically, capped — and the search box above is how you reach the
   * long tail.
   */
  const tokens = await prisma.token.findMany({
    where: {
      chainId: BASE_CHAIN_ID,
      ...(query
        ? {
            OR: [
              { symbol: { contains: query, mode: 'insensitive' as const } },
              { name: { contains: query, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    include: { marketData: true },
    orderBy: [{ isEnabled: 'desc' }, { verificationTier: 'asc' }, { symbol: 'asc' }],
    take: DEFAULT_ROWS,
  });

  const total = await prisma.token.count({
    where: { chainId: BASE_CHAIN_ID, isEnabled: true },
  });

  const unverified = tokens.filter((token) => token.verificationTier === 'UNVERIFIED').length;
  const lastFetched = tokens
    .map((token) => token.marketData?.fetchedAt)
    .filter((value): value is Date => Boolean(value))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('title')}
        description={t('description', { count: total.toLocaleString() })}
      />

      <InstrumentSearch className="max-w-md" placeholder={t('searchPlaceholder')} />

      {query ? (
        <p className="text-[12px] text-[var(--text-subtle)]">
          {t(tokens.length === 1 ? 'showingMatchesOne' : 'showingMatchesMany', {
            count: tokens.length,
            query,
          })}{' '}
          <Link href="/suuqyada" className="underline">
            {t('clear')}
          </Link>
        </p>
      ) : (
        <p className="text-[12px] text-[var(--text-subtle)]">
          {t('showingFirst', { shown: tokens.length, total: total.toLocaleString() })}
        </p>
      )}

      {unverified > 0 ? (
        <Notice tone="warning" icon={<ShieldAlert className="size-4" />}>
          {t(unverified === 1 ? 'unreviewedOne' : 'unreviewedMany', { count: unverified })}
        </Notice>
      ) : null}

      <Card>
        {tokens.length === 0 ? (
          <EmptyState title={t('noTokensTitle')} description={t('noTokensBody')} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t('colToken')}</TH>
                <TH>{t('colContract')}</TH>
                <TH numeric>{t('colPrice')}</TH>
                <TH numeric>{t('col24h')}</TH>
                <TH numeric>{t('col24hVolume')}</TH>
                <TH numeric>{t('colLiquidity')}</TH>
                <TH>{t('colStatus')}</TH>
              </TR>
            </THead>
            <TBody>
              {tokens.map((token) => (
                <TR key={token.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/suuqyada/${token.address}`}
                        className="link font-medium"
                      >
                        {token.symbol}
                      </Link>
                      <TierBadge tier={token.verificationTier} t={tierT} />
                    </div>
                    <span className="text-[11px] text-[var(--text-subtle)]">{token.name}</span>
                  </TD>
                  <TD>
                    <AddressChip
                      address={token.address}
                      explorerUrl={explorerTokenUrl(token.chainId, token.address)}
                    />
                  </TD>
                  <TD numeric>{formatUsd(token.marketData?.priceUsd?.toString() ?? null)}</TD>
                  <TD numeric>
                    <ValueDelta value={token.marketData?.change24hPct?.toString() ?? null} />
                  </TD>
                  <TD numeric>{formatUsd(token.marketData?.volume24hUsd?.toString() ?? null)}</TD>
                  <TD numeric>{formatUsd(token.marketData?.liquidityUsd?.toString() ?? null)}</TD>
                  <TD>
                    {token.isEnabled ? (
                      <Link
                        href={`/iibso?sell=${token.address}`}
                        className="text-[13px] link"
                      >
                        {t('trade')}
                      </Link>
                    ) : (
                      <Badge tone="neutral">{t('disabled')}</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
        {t('footerNote')}
        {lastFetched ? t('lastUpdated', { when: lastFetched.toLocaleTimeString(locale) }) : ''}
      </p>
    </div>
  );
}

/**
 * Verification tier.
 *
 * Only the unreviewed case carries colour. Verified is the expected state, and
 * tinting the normal case spends the signal that should be reserved for the one
 * row a user needs to look at twice — in a column of seven tokens, six green
 * badges say nothing and the amber one stops being visible.
 */
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
