import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { Badge, Notice, SectionHeader } from '@flt/ui';
import { HistoricalStdDev, toDailySigma } from '@flt/core/protection/volatility';
import { marketMakerStatus } from '@flt/core/services/market-maker-settings';
import { perpVenue } from '@flt/providers';
import { MarketMakerModel } from '@/components/market-maker-model';
import { requireAdminPage } from '@/server/session';
import { MarketMakerControls } from './market-maker-controls';

export const metadata: Metadata = { title: 'Market making' };
export const dynamic = 'force-dynamic';

/**
 * Market making, run and controlled.
 *
 * The book itself is the worker's `mm` loop (docs/adr/0007); this page is the
 * operator's view of it — whether it is on, what it is allowed to do, and what
 * it has done today — plus the kill switch. The quoting engine behind it is
 * real and now has an executor; the model below still shows what a book costs
 * to run against the revenue user flow already earns at no capital.
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

  const status = await marketMakerStatus();
  const cfg = status.config;

  const feeRule = await prisma.feeConfig.findFirst({
    where: { isEnabled: true, feeType: 'PERCENTAGE' },
    orderBy: { priority: 'desc' },
  });

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
        description="FLT's automated book — off unless enabled, and haltable without a deploy."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone={config.MM_ENABLED ? 'positive' : 'neutral'}>
          {config.MM_ENABLED ? 'MM_ENABLED set' : 'MM_ENABLED unset'}
        </Badge>
        <Badge tone={cfg?.isEnabled ? 'positive' : 'neutral'}>
          {cfg?.isEnabled ? 'Book on' : 'Book off'}
        </Badge>
        <Badge tone={cfg?.halted ? 'warning' : 'neutral'}>
          {cfg?.halted ? 'HALTED' : 'Not halted'}
        </Badge>
        <Badge tone={live ? 'positive' : 'warning'}>
          {live ? 'Live BTC price and volatility' : 'Venue unreachable — using fallbacks'}
        </Badge>
        <Badge tone="neutral">Symbol {config.MM_SYMBOL}</Badge>
      </div>

      {!config.MM_ENABLED ? (
        <Notice tone="warning" title="The book is switched off at the deployment">
          It needs MM_ENABLED, a named MM_VENUE_ACCOUNT and an authorised maker agent key before it
          will trade. Nothing below places an order until then.
        </Notice>
      ) : null}

      {cfg?.halted ? (
        <Notice tone="warning" title="The book is halted">
          {cfg.haltedReason ?? 'Halted.'} The next pass cancels every resting quote and places none
          until it is resumed.
        </Notice>
      ) : null}

      <MarketMakerControls
        hasConfig={cfg !== null}
        isEnabled={cfg?.isEnabled ?? false}
        halted={cfg?.halted ?? false}
        halfSpreadBps={cfg?.halfSpreadBps ?? 5}
        levels={cfg?.levels ?? 3}
        levelSize={cfg?.levelSize ?? '0.01'}
        levelStepBps={cfg?.levelStepBps ?? 2}
        maxInventory={cfg?.maxInventory ?? '0.5'}
        maxDailyLossUsd={cfg?.maxDailyLossUsd ?? '100'}
        requoteMs={cfg?.requoteMs ?? 5000}
      />

      <SectionHeader title="Today" description="Realized result, net of venue fees." />
      <div className="flex flex-wrap gap-2">
        <Badge tone={Number(status.realizedTodayUsd) >= 0 ? 'positive' : 'warning'}>
          Realized today {status.realizedTodayUsd} USD
        </Badge>
        <Badge tone="neutral">
          {status.recentFills.length} fill{status.recentFills.length === 1 ? '' : 's'} today
        </Badge>
      </div>

      {status.recentFills.length > 0 ? (
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Side</th>
                <th className="px-3 py-2">Price</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Fee</th>
                <th className="px-3 py-2">Realized</th>
              </tr>
            </thead>
            <tbody>
              {status.recentFills.slice(0, 20).map((fill) => (
                <tr key={fill.id} className="border-t border-neutral-800 text-neutral-200">
                  <td className="px-3 py-2">{fill.filledAt.toISOString().slice(11, 19)}</td>
                  <td className="px-3 py-2">{fill.isBuy ? 'Buy' : 'Sell'}</td>
                  <td className="px-3 py-2">{fill.price}</td>
                  <td className="px-3 py-2">{fill.size}</td>
                  <td className="px-3 py-2">{fill.feeUsd}</td>
                  <td className="px-3 py-2">{fill.closedPnlUsd}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <SectionHeader
        title="The model"
        description="What a book would cost to run, against the revenue user flow already earns."
      />

      {usingDefaults ? (
        <Notice tone="warning" title="Modelled on published rates, not configured ones">
          This deployment has no fee rate configured, so the comparison uses the published 10 bps
          perp builder fee and 25 bps spot fee. Set them under Fees for this to reflect what you
          actually charge.
        </Notice>
      ) : null}

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
