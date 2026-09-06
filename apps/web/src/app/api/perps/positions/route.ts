import { prisma } from '@flt/db';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { Decimal, liquidationProximity } from '@flt/core/domain';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * Open positions, read live from the venue.
 *
 * Deliberately not served from the snapshot table. The snapshot exists so the
 * worker can watch positions between page loads; a user looking at a leveraged
 * position needs the venue's current answer, because a stale liquidation price
 * is worse than none.
 *
 * `proximity` is how far the position has travelled from entry toward
 * liquidation, on a scale of nought to one, so the interface can escalate a
 * position in danger rather than rendering every row identically.
 */
export const GET = handler({}, async ({ user }) => {
  assertPerpsEnabled();

  const venue = perpVenue();
  const wallet = await resolveTradingWallet(prisma, user.id);

  const [positions, summary, markets] = await Promise.all([
    venue.getPositions({ address: wallet.address }),
    venue.getAccountSummary({ address: wallet.address }),
    venue.listMarkets(),
  ]);

  const markPrices = new Map(markets.map((market) => [market.symbol, market.markPrice]));

  return {
    wallet: { id: wallet.id, address: wallet.address },
    summary,
    requiresBridgedCollateral: venue.requiresBridgedCollateral,
    positions: positions.map((position) => {
      const markPrice = markPrices.get(position.symbol) ?? null;

      return {
        ...position,
        markPrice,
        proximity:
          markPrice && position.liquidationPrice
            ? liquidationProximity(markPrice, position.entryPrice, position.liquidationPrice)
            : null,
        notionalValue: markPrice
          ? new Decimal(position.size).times(markPrice).toFixed()
          : null,
      };
    }),
  };
});
