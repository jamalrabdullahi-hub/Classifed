import { ValidationError } from '@flt/core/domain';
import { isCandleInterval } from '@flt/core/ports';
import { getCandles } from '@flt/core/services/candles';
import { RateLimits } from '@flt/core/services/ratelimit';
import { BASE_CHAIN_ID } from '@flt/core/chains';
import { priceHistoryProvider } from '@flt/providers';
import { routeHandler } from '@/server/api';

/**
 * Candles for one token.
 *
 * A GET because it is a plain read of shared, non-personal data, and the client
 * refetches it on an interval. The service behind it caches, so a burst of
 * viewers on the same token costs the upstream provider one request rather than
 * one each.
 */
export const GET = routeHandler<unknown, { address: string }, unknown>(
  { rateLimit: { rule: RateLimits.API_GENERAL, scope: 'candles' } },
  async ({ params, request }) => {
    const interval = new URL(request.url).searchParams.get('interval') ?? '1h';
    if (!isCandleInterval(interval)) {
      throw new ValidationError(`Unsupported interval: ${interval}`);
    }

    const series = await getCandles(
      priceHistoryProvider(),
      BASE_CHAIN_ID,
      params.address,
      interval,
    );

    // A token with no indexed pool is a real answer, not an error: the caller
    // renders "no chart available" rather than an empty axis reading as zero.
    if (!series) return { available: false as const };

    return {
      available: true as const,
      interval: series.interval,
      candles: series.candles,
      pool: series.pool,
      source: series.source,
      fetchedAt: series.fetchedAt.toISOString(),
      stale: series.stale,
    };
  },
);
