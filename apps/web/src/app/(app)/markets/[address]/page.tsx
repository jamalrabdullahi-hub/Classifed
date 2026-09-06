import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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
  return { title: token ? `${token.symbol} · Markets` : 'Markets' };
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
        <Link href="/markets">
          <ArrowLeft className="size-3.5" />
          Back to markets
        </Link>
      </Button>

      <SectionHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {token.symbol}
            <TierBadge tier={token.verificationTier} />
            {!token.isEnabled ? <Badge tone="neutral">Disabled</Badge> : null}
          </span>
        }
        description={token.name}
        action={
          token.isEnabled ? (
            <Button asChild size="sm">
              <Link href={`/trade?buy=${token.address}`}>
                Trade {token.symbol}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          ) : null
        }
      />

      {token.verificationTier === 'UNVERIFIED' ? (
        <Notice
          tone="warning"
          icon={<ShieldAlert className="size-4" />}
          title="FLT has not reviewed this token"
        >
          Anyone can deploy a token and name it anything. Check the contract address below against a
          source you trust before trading.
        </Notice>
      ) : null}

      {!token.isEnabled ? (
        <Notice tone="warning" title="Trading is disabled for this token">
          {token.disabledReason ?? 'An administrator has disabled it.'}
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Price" value={formatUsd(market?.priceUsd?.toString() ?? null)} />
        <Stat
          label="24h change"
          value={<ValueDelta value={market?.change24hPct?.toString() ?? null} />}
        />
        <Stat label="24h volume" value={formatUsd(market?.volume24hUsd?.toString() ?? null)} />
        <Stat label="Liquidity" value={formatUsd(market?.liquidityUsd?.toString() ?? null)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Price history</CardTitle>
        </CardHeader>
        <CardContent>
          <MarketChart address={token.address} symbol={token.symbol} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contract</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-[var(--border)]">
          <DetailRow
            label="Address"
            value={
              <AddressChip
                address={token.address}
                explorerUrl={explorerTokenUrl(token.chainId, token.address)}
              />
            }
            hint="Always check this before you trade"
          />
          <DetailRow label="Chain" value="Base" />
          <DetailRow label="Decimals" value={String(token.decimals)} />
          <DetailRow
            label="Verification"
            value={<TierBadge tier={token.verificationTier} />}
            hint={
              token.verificationTier === 'VERIFIED'
                ? 'FLT has reviewed this contract'
                : token.verificationTier === 'RECOGNIZED'
                  ? 'Widely used, but not reviewed by FLT'
                  : 'Not reviewed by FLT'
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

/** Only the unreviewed case carries colour. See the note in the markets list. */
function TierBadge({ tier }: { tier: string }) {
  if (tier === 'VERIFIED') return <Badge tone="neutral">Verified</Badge>;
  if (tier === 'RECOGNIZED') return <Badge tone="neutral">Recognized</Badge>;
  return <Badge tone="warning">Unverified</Badge>;
}
