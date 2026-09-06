import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { env } from '@flt/config';
import { annualisedFundingRate } from '@flt/core/domain';
import { getOfferedMarket, listOfferedMarkets } from '@flt/core/services/perps';
import { perpVenue } from '@flt/providers';
import { requireUserPage } from '@/server/session';
import { PerpTerminal } from '@/components/terminal/perp-terminal';

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
 * One perpetual market, as a trading terminal.
 *
 * The server renders only the instrument's static facts and the market list for
 * the switcher. Everything that moves — book, tape, candles, position — is
 * fetched by the panels themselves, because they decay at different rates and a
 * single server render would be stale in the two seconds it takes the book to
 * turn over.
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

  const [offered, all] = await Promise.all([
    getOfferedMarket(venue, symbol),
    listOfferedMarkets(venue),
  ]);

  if (!offered) notFound();
  const { market, maxLeverage } = offered;

  return (
    <div className="space-y-4">
      <PerpTerminal
        market={{
          symbol: market.symbol,
          name: market.name,
          markPrice: market.markPrice,
          indexPrice: market.indexPrice,
          fundingRate: market.fundingRate,
          fundingRateAnnualised: market.fundingRate
            ? annualisedFundingRate(market.fundingRate, market.fundingIntervalHours)
            : null,
          fundingIntervalHours: market.fundingIntervalHours,
          openInterest: market.openInterest,
          maxLeverage,
          venueMaxLeverage: market.maxLeverage,
          minSize: market.minSize,
        }}
        markets={all.map((entry) => ({ symbol: entry.symbol }))}
        venueName={venue.meta.name}
        venueIsMock={venue.meta.isMock}
        requiresBridgedCollateral={venue.requiresBridgedCollateral}
        builderMaxFeeRate={`${env().PERP_BUILDER_FEE_BPS / 100}%`}
      />

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
        Prices, book depth and trades are reported by {venue.meta.name}, not by FLT, and are not
        quotes. A perpetual has no expiry: it stays open until you close it or until the market
        moves far enough against you that the venue closes it and the margin behind it is gone.
        There is no margin call. FLT caps leverage at {env().PERP_MAX_LEVERAGE}× whatever the venue
        permits, prepares orders, and never holds your collateral or signs on your behalf.
      </p>
    </div>
  );
}
