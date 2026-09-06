import type { Metadata } from 'next';
import Link from 'next/link';
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

export const metadata: Metadata = { title: 'Markets' };
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
export default async function MarketsPage() {
  await requireUserPage();

  const tokens = await prisma.token.findMany({
    where: { chainId: BASE_CHAIN_ID },
    include: { marketData: true },
    orderBy: [{ isEnabled: 'desc' }, { verificationTier: 'asc' }, { symbol: 'asc' }],
  });

  const unverified = tokens.filter((token) => token.verificationTier === 'UNVERIFIED').length;
  const lastFetched = tokens
    .map((token) => token.marketData?.fetchedAt)
    .filter((value): value is Date => Boolean(value))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Markets"
        description="Tokens FLT has reviewed and enabled for trading on Base. Contract addresses are always shown — check them before you trade."
      />

      {unverified > 0 ? (
        <Notice tone="warning" icon={<ShieldAlert className="size-4" />}>
          {unverified} token{unverified === 1 ? ' has' : 's have'} not been reviewed by FLT. A token
          appearing here is not an endorsement.
        </Notice>
      ) : null}

      <Card>
        {tokens.length === 0 ? (
          <EmptyState
            title="No tokens available"
            description="An administrator has not enabled any tokens for trading yet."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Token</TH>
                <TH>Contract</TH>
                <TH numeric>Price</TH>
                <TH numeric>24h</TH>
                <TH numeric>24h volume</TH>
                <TH numeric>Liquidity</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {tokens.map((token) => (
                <TR key={token.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/markets/${token.address}`}
                        className="font-medium text-[var(--text)] hover:text-[var(--accent)] hover:underline"
                      >
                        {token.symbol}
                      </Link>
                      <TierBadge tier={token.verificationTier} />
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
                        href={`/trade?sell=${token.address}`}
                        className="text-[13px] text-[var(--accent)] hover:underline"
                      >
                        Trade
                      </Link>
                    ) : (
                      <Badge tone="neutral">Disabled</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
        Prices, volume and liquidity are estimates supplied by a third-party market data provider,
        not by FLT, and are not the price your trade will execute at. Execution pricing comes from
        on-chain liquidity at the moment you request a quote.
        {lastFetched ? ` Last updated ${lastFetched.toLocaleTimeString()}.` : ''}
      </p>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  if (tier === 'VERIFIED') return <Badge tone="positive">Verified</Badge>;
  if (tier === 'RECOGNIZED') return <Badge tone="neutral">Recognized</Badge>;
  return <Badge tone="warning">Unverified</Badge>;
}
