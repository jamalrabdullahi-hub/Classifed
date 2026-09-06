import { NotFoundError } from '@flt/core/domain';
import { getOfferedMarket } from '@flt/core/services/perps';
import { perpVenue } from '@flt/providers';
import { routeHandler } from '@/server/api';

/**
 * The trade tape.
 *
 * The adapter has already dropped the counterparty addresses the venue attaches
 * to every public trade. Nothing here re-adds them, and nothing downstream can:
 * the port's `PerpTrade` has no field for them.
 */
export const GET = routeHandler<unknown, { symbol: string }, unknown>(
  {},
  async ({ params, request }) => {
    const venue = perpVenue();

    const offered = await getOfferedMarket(venue, params.symbol);
    if (!offered) throw new NotFoundError('Market');

    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 40);
    const trades = await venue.getRecentTrades(
      offered.market.symbol,
      Number.isFinite(limit) ? Math.min(Math.max(limit, 5), 100) : 40,
    );

    return {
      symbol: offered.market.symbol,
      trades: trades.map((trade) => ({
        price: trade.price,
        size: trade.size,
        side: trade.side,
        at: trade.at.toISOString(),
      })),
    };
  },
);
