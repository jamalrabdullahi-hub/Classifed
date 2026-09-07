import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { Badge, Notice, SectionHeader } from '@flt/ui';
import { HistoricalStdDev, toDailySigma } from '@flt/core/protection/volatility';
import { perpVenue } from '@flt/providers';
import { MarketMakerModel } from '@/components/market-maker-model';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Market making' };
export const dynamic = 'force-dynamic';

/**
 * Market making, modelled rather than run.
 *
 * The page exists to answer one question honestly: what would a book cost to
 * run, and how does that compare with the revenue the platform already earns
 * from user flow at no capital. The quoting engine behind it is real; the
 * execution is deliberately absent, and the page says why.
 */
export default async function MarketMakingPage() {
  await requireAdminPage();
  const config = env();

  let price = 80_000;
  let dailyVolatilityPct = 1.9;
  let live = false;

  if (config.PERPS_ENABLED) {
    try {
      const venue = perpVenue();
      const [market, candles] = await Promise.all([
        venue.getMarket('BTC'),
        venue.getCandles('BTC', '1h', 400),
      ]);

      if (market?.markPrice && candles.length > 100) {
        price = Number(market.markPrice);
        const estimate = new HistoricalStdDev().calculate(candles, candles.length, 1 / 24);
        dailyVolatilityPct = toDailySigma(estimate).times(100).toNumber();
        live = true;
      }
    } catch {
      // The venue being unreachable must not take the page down; the model
      // still works on the fallbacks, which are labelled as such.
    }
  }

  const feeRule = await prisma.feeConfig.findFirst({
    where: { isEnabled: true, feeType: 'PERCENTAGE' },
    orderBy: { priority: 'desc' },
  });

  /**
   * The rates the model actually uses.
   *
   * Resolved once here rather than in two places: the badges were reading the
   * raw configuration while the model fell back to the published defaults, so a
   * deployment with an unset builder fee showed "0 bps" beside a calculation
   * that had quietly used 10. A number on screen has to be the number in use.
   */
  const configured = {
    perpBuilderBps: config.PERP_BUILDER_FEE_BPS,
    spotFeeBps: feeRule?.bps ?? 0,
  };
  const effective = {
    perpBuilderBps: configured.perpBuilderBps > 0 ? configured.perpBuilderBps : 10,
    spotFeeBps: configured.spotFeeBps > 0 ? configured.spotFeeBps : 25,
  };
  const usingDefaults =
    configured.perpBuilderBps !== effective.perpBuilderBps ||
    configured.spotFeeBps !== effective.spotFeeBps;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Market making"
        description="What a book would cost to run, against the revenue user flow already earns."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone={live ? 'positive' : 'warning'}>
          {live ? 'Live BTC price and volatility' : 'Venue unreachable — using fallbacks'}
        </Badge>
        <Badge tone={usingDefaults ? 'warning' : 'neutral'}>
          Perp builder {effective.perpBuilderBps} bps
        </Badge>
        <Badge tone={usingDefaults ? 'warning' : 'neutral'}>
          Spot fee {effective.spotFeeBps} bps
        </Badge>
        <Badge tone="neutral">No execution</Badge>
      </div>

      {usingDefaults ? (
        <Notice tone="warning" title="Modelled on published rates, not configured ones">
          This deployment has no fee rate configured, so the comparison uses the published 10 bps
          perp builder fee and 25 bps spot fee. Set them under Fees for this to reflect what you
          actually charge.
        </Notice>
      ) : null}

      <Notice tone="neutral" title="What this is">
        The quoting engine — inventory skew, volatility widening, position limits — is implemented
        and tested in the core package. This page models its economics. It does not place orders,
        and nothing in the platform can.
      </Notice>

      <MarketMakerModel
        price={price}
        dailyVolatilityPct={dailyVolatilityPct}
        makerFeeBps={1.5}
        perpBuilderBps={effective.perpBuilderBps}
        spotFeeBps={effective.spotFeeBps}
      />
    </div>
  );
}
