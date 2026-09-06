import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { env } from '@flt/config';
import { TriangleAlert } from 'lucide-react';
import {
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
  cn,
} from '@flt/ui';
import { Decimal, annualisedFundingRate, formatUsd } from '@flt/core/domain';
import { listOfferedMarkets } from '@flt/core/services/perps';
import { perpVenue } from '@flt/providers';
import { requireUserPage } from '@/server/session';
import { PerpPositionsPanel } from '@/components/perp-positions';

export const metadata: Metadata = { title: 'Perpetuals' };
export const dynamic = 'force-dynamic';

/**
 * Perpetual markets.
 *
 * Framed differently from the spot markets table on purpose. Spot answers "what
 * is this worth"; this screen has to answer "what does holding this cost me and
 * how does it end", so funding and maximum leverage are columns rather than
 * details, and the risk of the instrument is stated on the page rather than
 * buried in a link.
 */
export default async function PerpsPage() {
  await requireUserPage();
  if (!env().PERPS_ENABLED) notFound();

  const venue = perpVenue();
  const markets = await listOfferedMarkets(venue);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Perpetuals"
        description={`Leveraged perpetual futures, routed to ${venue.meta.name}. Your margin is posted to the venue and your wallet signs every order — FLT never holds it.`}
      />

      <Notice tone="warning" icon={<TriangleAlert className="size-4" />} title="Leveraged trading can close your position automatically">
        A perpetual position is borrowed exposure. If the market moves against you far enough, the
        venue closes it and the margin backing it is gone — there is no margin call and no chance to
        add funds first. At 10x, a move of roughly 10% against you is enough. You can lose the
        entire margin on a position.
      </Notice>

      {venue.requiresBridgedCollateral ? (
        <Notice tone="warning" title="Margin is held on the venue, not in your wallet">
          {venue.meta.name} settles on its own network. Collateral has to be moved there before you
          can trade, and moving it back is a separate withdrawal. This is the one place FLT&apos;s
          usual promise — that your assets never leave your wallet — does not apply.
        </Notice>
      ) : null}

      {venue.meta.isMock ? (
        <Notice tone="warning" title="Simulated venue">
          These prices and positions are generated for development. Nothing here is real.
        </Notice>
      ) : null}

      <PerpPositionsPanel />

      <Card>
        {markets.length === 0 ? (
          <EmptyState
            title="No perpetual markets enabled"
            description="An administrator has not enabled any perpetual markets for trading yet."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Market</TH>
                <TH numeric>Mark</TH>
                <TH numeric>Index</TH>
                <TH numeric>Funding / 1h</TH>
                <TH numeric>Funding / yr</TH>
                <TH numeric>Max leverage</TH>
                <TH>Open interest</TH>
              </TR>
            </THead>
            <TBody>
              {markets.map((market) => {
                const annual = market.fundingRate
                  ? annualisedFundingRate(market.fundingRate, market.fundingIntervalHours)
                  : null;

                return (
                  <TR key={market.symbol}>
                    <TD>
                      <Link href={`/perps/${market.symbol}`} className="link font-medium">
                        {market.symbol}
                      </Link>
                      <span className="ml-2 text-[11px] text-[var(--text-subtle)]">
                        {market.name}
                      </span>
                    </TD>
                    <TD numeric>{formatUsd(market.markPrice)}</TD>
                    <TD numeric>{formatUsd(market.indexPrice)}</TD>
                    <TD numeric>
                      {/* Rendered at four decimal places rather than through
                          the standard delta formatter. An hourly funding rate
                          is around 0.00125%, which rounds to "+0.00%" at the
                          two places every other percentage on the site uses —
                          technically true and completely uninformative. The
                          sign is kept, because who pays whom is the point. */}
                      <span
                        className={cn(
                          'num',
                          market.fundingRate && new Decimal(market.fundingRate).isNegative()
                            ? 'text-[var(--negative)]'
                            : market.fundingRate && !new Decimal(market.fundingRate).isZero()
                              ? 'text-[var(--positive)]'
                              : 'text-[var(--text-muted)]',
                        )}
                      >
                        {market.fundingRate
                          ? `${new Decimal(market.fundingRate).isNegative() ? '' : '+'}${new Decimal(market.fundingRate).times(100).toFixed(4)}%`
                          : '—'}
                      </span>
                    </TD>
                    <TD numeric>
                      <ValueDelta
                        value={annual ? new Decimal(annual).times(100).toFixed(2) : null}
                      />
                    </TD>
                    <TD numeric>
                      <span className="num">{market.maxLeverage}x</span>
                      {market.venueMaxLeverage > market.maxLeverage ? (
                        <span className="ml-1 text-[11px] text-[var(--text-subtle)]">
                          (venue {market.venueMaxLeverage}x)
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <span className="num text-[13px]">
                        {market.openInterest
                          ? new Decimal(market.openInterest).toDecimalPlaces(2).toFixed()
                          : '—'}
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
        Prices, funding and open interest are reported by {venue.meta.name} and are not quotes. FLT
        caps leverage at {env().PERP_MAX_LEVERAGE}x regardless of what the venue permits. Funding is
        charged every hour a position is open and is separate from trading fees. Positions are
        closed by the venue, not by FLT, and neither FLT nor the venue can reverse a settled trade.
      </p>
    </div>
  );
}
