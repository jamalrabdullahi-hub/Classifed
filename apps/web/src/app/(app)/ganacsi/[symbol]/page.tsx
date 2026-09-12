import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { SubscriptionTier } from '@flt/db';
import { env } from '@flt/config';
import { annualisedFundingRate } from '@flt/core/domain';
import { listAllOfferedMarkets, resolveOfferedMarket } from '@flt/core/services/perps';
import { perpVenues } from '@flt/providers';
import { entitlementsFor, fromPlan } from '@flt/core/services/entitlements';
import { REFERRAL_SHARE_BPS } from '@flt/core/services/referrals';
import { currentUser } from '@/server/session';
import { PerpTerminal } from '@/components/terminal/perp-terminal';
import { RememberMarket } from '@/components/terminal/remember-market';
import { TradePromos } from '@/components/trade-promos';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  const t = await getTranslations('meta');
  return { title: t('titleInstrumentSymbol', { symbol: symbol.toUpperCase() }) };
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
  const user = await currentUser();
  const t = await getTranslations('perpMarketPage');
  if (!env().PERPS_ENABLED) notFound();

  /**
   * Perpetuals are a paid destination, but looking is free — and a visitor
   * with no account at all gets the same courtesy. The terminal renders in
   * full — prices, book, chart, the ticket — and the order controls are
   * inert with a banner saying why. Redirecting somebody away from the thing
   * they came to evaluate is a poor way to sell it to them: they cannot want
   * what they have not seen.
   *
   * A guest is priced as FREE without a database round trip — `fromPlan`
   * with no row *is* the free-tier fallback — since there is no account to
   * look a subscription up against.
   */
  const entitlements = user
    ? await entitlementsFor(user.id)
    : fromPlan(SubscriptionTier.FREE, null, null);
  const canTrade = Boolean(user) && entitlements.perpsAccess;
  // Level 2 (the live order book) is a paid tool: BASIC and above get it; FREE
  // and guests get a blurred teaser instead.
  const level2Locked =
    entitlements.tier !== SubscriptionTier.BASIC &&
    entitlements.tier !== SubscriptionTier.PRO &&
    entitlements.tier !== SubscriptionTier.ELITE;

  const { symbol } = await params;
  const venues = perpVenues();

  const [offered, all] = await Promise.all([
    resolveOfferedMarket(venues, symbol),
    listAllOfferedMarkets(venues),
  ]);

  if (!offered) notFound();
  const { market, maxLeverage, venue } = offered;

  return (
    <div className="space-y-4">
      {/* Records the market so a bare /ganacsi comes back here. */}
      <RememberMarket symbol={market.symbol} />

      <TradePromos
        tier={entitlements.tier}
        maxLeverage={entitlements.maxLeverage}
        signedIn={Boolean(user)}
        shareBps={REFERRAL_SHARE_BPS}
      />

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
          assetClass: market.assetClass,
          isMarketOpen: market.isMarketOpen,
          secondsToSessionChange: market.secondsToSessionChange,
        }}
        markets={all.map((entry) => ({ symbol: entry.symbol, name: entry.name }))}
        venueName={venue.meta.name}
        venueIsMock={venue.meta.isMock}
        canTrade={canTrade}
        guest={!user}
        requiresBridgedCollateral={venue.requiresBridgedCollateral}
        level2Locked={level2Locked}
        tier={entitlements.tier}
      />

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
        {t('footerNote', { venue: venue.meta.name, maxLeverage: env().PERP_MAX_LEVERAGE })}
      </p>
    </div>
  );
}
