import { listAllOfferedMarkets } from '@flt/core/services/perps';
import { annualisedFundingRate } from '@flt/core/domain';
import { perpVenues } from '@flt/providers';
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
  const venues = perpVenues();
  const markets = await listAllOfferedMarkets(venues);
  const primary = venues[0]!;

  return {
    venues: venues.map((venue) => ({
      slug: venue.meta.slug,
      name: venue.meta.name,
      isMock: venue.meta.isMock,
      requiresBridgedCollateral: venue.requiresBridgedCollateral,
      settlementChainId: venue.settlementChainId,
    })),
    // Kept for callers written before there was more than one venue.
    venue: { slug: primary.meta.slug, name: primary.meta.name, isMock: primary.meta.isMock },
    requiresBridgedCollateral: primary.requiresBridgedCollateral,
    markets: markets.map((market) => ({
      symbol: market.symbol,
      name: market.name,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      maxLeverage: market.maxLeverage,
      venueMaxLeverage: market.venueMaxLeverage,
      venueSlug: market.venueSlug,
      assetClass: market.assetClass,
      /**
       * Whether the underlying's session is open.
       *
       * Crypto never closes and this is always true there. It is the single
       * most important field on an equity or FX contract: the market shuts, the
       * position stays open across the gap, and a frozen price reads as a quiet
       * market rather than a shut one unless the interface says otherwise.
       */
      isMarketOpen: market.isMarketOpen,
      secondsToSessionChange: market.secondsToSessionChange,
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
