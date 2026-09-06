import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { env } from '@flt/config';
import { ArrowLeft } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, SectionHeader, Stat } from '@flt/ui';
import { Decimal, annualisedFundingRate, formatUsd } from '@flt/core/domain';
import { getOfferedMarket } from '@flt/core/services/perps';
import { perpVenue } from '@flt/providers';
import { requireUserPage } from '@/server/session';
import { PerpOrderForm } from '@/components/perp-order-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  return { title: `${symbol.toUpperCase()} perpetual` };
}

/**
 * One perpetual market.
 *
 * The order form is the point of the page, but it is framed the same way the
 * spot review screen is: the numbers that decide whether this is a good idea —
 * margin, liquidation price, funding cost — sit next to the control that places
 * the order, not behind it.
 */
export default async function PerpMarketPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  await requireUserPage();
  if (!env().PERPS_ENABLED) notFound();

  const { symbol } = await params;
  const venue = perpVenue();
  const offered = await getOfferedMarket(venue, symbol);

  if (!offered) notFound();
  const { market, maxLeverage } = offered;

  const annual = market.fundingRate
    ? annualisedFundingRate(market.fundingRate, market.fundingIntervalHours)
    : null;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/perps">
          <ArrowLeft className="size-3.5" />
          Back to perpetuals
        </Link>
      </Button>

      <SectionHeader
        title={`${market.symbol} perpetual`}
        description={`${market.name} · settled on ${venue.meta.name} · up to ${maxLeverage}x`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Mark price" value={formatUsd(market.markPrice)} />
        <Stat label="Index price" value={formatUsd(market.indexPrice)} />
        <Stat
          label={`Funding / ${market.fundingIntervalHours}h`}
          value={
            market.fundingRate
              ? `${new Decimal(market.fundingRate).times(100).toFixed(4)}%`
              : '—'
          }
        />
        <Stat
          label="Funding / year"
          value={annual ? `${new Decimal(annual).times(100).toFixed(2)}%` : '—'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle>How this position ends</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px] leading-relaxed text-[var(--text-muted)]">
            <p>
              A perpetual has no expiry. It stays open until you close it or until the market moves
              far enough against you that {venue.meta.name} closes it for you. There is no margin
              call: the position is closed at the liquidation price and the margin backing it is
              gone.
            </p>
            <p>
              Funding is exchanged every {market.fundingIntervalHours} hour
              {market.fundingIntervalHours === 1 ? '' : 's'} between longs and shorts. At the
              current rate that is{' '}
              <span className="num text-[var(--text)]">
                {annual ? `${new Decimal(annual).times(100).toFixed(2)}%` : 'an unknown amount'}
              </span>{' '}
              a year, paid by one side to the other, and it is charged separately from trading fees.
            </p>
            <p>
              Your margin is held by {venue.meta.name}, not by FLT and not in your linked wallet.
              FLT prepares the order; your own key signs it. Neither FLT nor the venue can reverse a
              trade once it has settled.
            </p>
          </CardContent>
        </Card>

        <PerpOrderForm
          symbol={market.symbol}
          markPrice={market.markPrice}
          minSize={market.minSize}
          maxLeverage={maxLeverage}
          venueMaxLeverage={market.maxLeverage}
          venueName={venue.meta.name}
        />
      </div>
    </div>
  );
}
