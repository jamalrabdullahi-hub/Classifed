import { env } from '@flt/config';
import { prisma } from '@flt/db';
import { NotFoundError } from '../domain/errors';
import { newId } from '../domain/id';
import type { Candle, CandleInterval, PriceHistoryProvider } from '../ports/history';

/**
 * Price history, cached.
 *
 * The only caller of the price history provider. Everything else asks this
 * module, so the shared upstream rate limit is spent once per token-interval
 * per refresh window rather than once per page view.
 *
 * Stale data is preferred to no data. If the provider fails while we hold
 * expired candles, the expired candles are served with their true age attached
 * and the interface says how old they are. A chart labelled "4 minutes old" is
 * useful; a chart that vanishes when an upstream hiccups is not.
 */

/** How long one candle covers, in seconds. */
const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '5m': 300,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

export interface CandleSeries {
  candles: Candle[];
  interval: CandleInterval;
  /** Where the price came from, so the interface can attribute it. */
  pool: { address: string; dex: string; quoteSymbol: string | null };
  source: string;
  fetchedAt: Date;
  /** True when the provider failed and these are the last candles we held. */
  stale: boolean;
}

/**
 * Cache lifetime for an interval.
 *
 * Proportional to the interval rather than fixed: a daily candle changes
 * meaningfully far more slowly than a five-minute one, and refreshing both
 * every minute would spend the shared budget on data that has not moved.
 */
function cacheTtlMs(interval: CandleInterval): number {
  // The record is exhaustive over CandleInterval, so the lookup cannot miss.
  return INTERVAL_SECONDS[interval]! * env().CANDLE_CACHE_RATIO * 1_000;
}

export async function getCandles(
  provider: PriceHistoryProvider,
  chainId: number,
  tokenAddress: string,
  interval: CandleInterval,
): Promise<CandleSeries | null> {
  const token = await prisma.token.findFirst({ where: { chainId, address: tokenAddress } });
  if (!token) throw new NotFoundError('Token');

  const cached = await prisma.priceCandleCache.findUnique({
    where: { tokenId_interval: { tokenId: token.id, interval } },
  });

  const fresh = cached && Date.now() - cached.fetchedAt.getTime() < cacheTtlMs(interval);
  if (fresh) return toSeries(cached, interval, false);

  try {
    /*
     * Pool resolution is reused from the cache when we have it. Which pool is
     * deepest changes over hours, not seconds, and re-resolving on every
     * refresh would double the request cost of a chart for no benefit.
     */
    const pool = cached
      ? {
          address: cached.poolAddress,
          dex: cached.poolDex,
          quoteSymbol: cached.poolQuoteSymbol,
        }
      : await provider.findPrimaryPool(chainId, tokenAddress);

    // No pool means no chart. That is a real answer, and the caller renders it
    // as such rather than drawing an empty axis that reads as a zero price.
    if (!pool) return null;

    const candles = await provider.getCandles({
      chainId,
      poolAddress: pool.address,
      interval,
      limit: 300,
    });

    if (candles.length === 0) return cached ? toSeries(cached, interval, true) : null;

    const fetchedAt = new Date();
    const record = {
      tokenId: token.id,
      interval,
      poolAddress: pool.address,
      poolDex: pool.dex,
      poolQuoteSymbol: 'quoteSymbol' in pool ? pool.quoteSymbol : null,
      candles: candles as unknown as object,
      source: provider.name,
      fetchedAt,
    };

    await prisma.priceCandleCache.upsert({
      where: { tokenId_interval: { tokenId: token.id, interval } },
      create: { id: newId(), ...record },
      update: record,
    });

    return {
      candles,
      interval,
      pool: {
        address: pool.address,
        dex: pool.dex,
        quoteSymbol: record.poolQuoteSymbol,
      },
      source: provider.name,
      fetchedAt,
      stale: false,
    };
  } catch (error) {
    // Serve what we have rather than nothing, and say that it is old.
    if (cached) {
      console.warn('[candles] provider failed, serving cached candles', {
        token: token.symbol,
        interval,
        error: error instanceof Error ? error.message : String(error),
      });
      return toSeries(cached, interval, true);
    }
    throw error;
  }
}

function toSeries(
  row: {
    candles: unknown;
    poolAddress: string;
    poolDex: string;
    poolQuoteSymbol: string | null;
    source: string;
    fetchedAt: Date;
  },
  interval: CandleInterval,
  stale: boolean,
): CandleSeries {
  return {
    candles: (row.candles as Candle[]) ?? [],
    interval,
    pool: { address: row.poolAddress, dex: row.poolDex, quoteSymbol: row.poolQuoteSymbol },
    source: row.source,
    fetchedAt: row.fetchedAt,
    stale,
  };
}
