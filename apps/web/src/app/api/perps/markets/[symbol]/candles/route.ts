import { DomainError, NotFoundError, ValidationError } from '@flt/core/domain';
import { resolveOfferedMarket } from '@flt/core/services/perps';
import { isPerpCandleInterval } from '@flt/core/ports';
import { perpVenues } from '@flt/providers';
import { routeHandler } from '@/server/api';

/**
 * Candles for the chart.
 *
 * Straight from the venue rather than through the spot candle cache. The spot
 * cache exists because GeckoTerminal's free tier rate-limits hard across the
 * whole deployment; Hyperliquid's read API does not, and a cached candle on a
 * leveraged market is worse than a slow one — the last candle is the price the
 * position is being marked against.
 *
 * The venue call is bounded: a venue that does not answer produces a clear
 * "unavailable" rather than a request that hangs and a chart stuck loading.
 */
const VENUE_TIMEOUT_MS = 10_000;

export const GET = routeHandler<unknown, { symbol: string }, unknown>(
  // Public market data — the chart renders for a signed-out visitor too.
  { auth: false },
  async ({ params, request }) => {
    // Resolved across venues: an equity or FX symbol lives on Ostium and a
    // crypto one on Hyperliquid, and asking the wrong venue returns nothing.
    const offered = await resolveOfferedMarket(perpVenues(), params.symbol);
    if (!offered) throw new NotFoundError('Market');
    const { venue } = offered;

    const url = new URL(request.url);
    const interval = url.searchParams.get('interval') ?? '15m';
    if (!isPerpCandleInterval(interval)) {
      throw new ValidationError('Unsupported interval', { interval });
    }

    const limit = Number(url.searchParams.get('limit') ?? 200);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const candles = await Promise.race([
        venue.getCandles(
          offered.market.symbol,
          interval,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 20), 500) : 200,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DomainError('CHART_UNAVAILABLE', 'Chart data is not available for this market right now.', 503)),
            VENUE_TIMEOUT_MS,
          );
        }),
      ]);
      return { symbol: offered.market.symbol, interval, candles };
    } finally {
      clearTimeout(timer);
    }
  },
);
