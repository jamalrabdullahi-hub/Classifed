import { listOfferedMarkets } from '@flt/core/services/perps';
import { annualisedFundingRate } from '@flt/core/domain';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * The perpetual markets FLT offers.
 *
 * A subset of what the venue lists, not a mirror of it: only rows an operator
 * has enabled appear, and each carries FLT's own leverage cap rather than the
 * venue's, because that cap is what the interface will actually enforce.
 *
 * Funding is returned both per interval and annualised. The per-interval number
 * is what the venue charges; the annualised one is the only form in which a
 * user can compare the cost of holding a position against anything else.
 */
export const GET = handler({}, async () => {
  const venue = perpVenue();
  const markets = await listOfferedMarkets(venue);

  return {
    venue: { slug: venue.meta.slug, name: venue.meta.name, isMock: venue.meta.isMock },
    requiresBridgedCollateral: venue.requiresBridgedCollateral,
    markets: markets.map((market) => ({
      symbol: market.symbol,
      name: market.name,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      maxLeverage: market.maxLeverage,
      venueMaxLeverage: market.venueMaxLeverage,
      minSize: market.minSize,
      sizeDecimals: market.sizeDecimals,
      fundingRate: market.fundingRate,
      fundingIntervalHours: market.fundingIntervalHours,
      fundingRateAnnualised: market.fundingRate
        ? annualisedFundingRate(market.fundingRate, market.fundingIntervalHours)
        : null,
      openInterest: market.openInterest,
    })),
  };
});
