import { ProviderError } from '@flt/core/domain';
import { z } from 'zod';
import type {
  Candle,
  CandleInterval,
  PoolReference,
  PriceHistoryProvider,
  PriceHistoryRequest,
} from './types';

/**
 * GeckoTerminal adapter.
 *
 * Chosen because it indexes the DEX pools themselves rather than exchange
 * listings, so the candles come from the same liquidity our quotes are routed
 * through. Its public tier needs no key, which keeps charts working in a fresh
 * checkout with no signup.
 *
 * That free tier is rate limited (roughly 30 calls a minute across the whole
 * deployment, not per user), so nothing here may be called straight from a page
 * render. `@flt/core/services/candles` caches on top of this and is the only
 * caller.
 */

const BASE_URL = 'https://api.geckoterminal.com/api/v2';

const NETWORK_BY_CHAIN: Record<number, string> = {
  8453: 'base',
};

/** How GeckoTerminal names each of our intervals: [timeframe, aggregate]. */
const TIMEFRAME: Record<CandleInterval, [string, number]> = {
  '5m': ['minute', 5],
  '1h': ['hour', 1],
  '4h': ['hour', 4],
  '1d': ['day', 1],
};

const poolSchema = z.object({
  id: z.string(),
  attributes: z.object({
    address: z.string(),
    name: z.string().nullish(),
    reserve_in_usd: z.string().nullish(),
  }),
  relationships: z
    .object({
      dex: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
      // Carries the base token's address, which is the only reliable way to
      // tell whether a pool prices the token we asked about or prices
      // something else *in* it. The pool name cannot be trusted for this.
      base_token: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
      quote_token: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
    })
    .nullish(),
});

const poolListSchema = z.object({ data: z.array(poolSchema) });

const ohlcvSchema = z.object({
  data: z.object({
    attributes: z.object({
      /*
       * A tuple rather than a loose array, so the positions are typed exactly
       * and a change in the response shape fails validation here rather than
       * drawing a wrong chart downstream. Prices are nullable because a period
       * in which the pool did not trade reports nulls.
       */
      ohlcv_list: z.array(
        z.tuple([
          z.number(), // timestamp, unix seconds
          z.number().nullable(), // open
          z.number().nullable(), // high
          z.number().nullable(), // low
          z.number().nullable(), // close
          z.number().nullable(), // volume
        ]),
      ),
    }),
  }),
});

export class GeckoTerminalPriceHistoryProvider implements PriceHistoryProvider {
  readonly name = 'geckoterminal';

  async findPrimaryPool(chainId: number, tokenAddress: string): Promise<PoolReference | null> {
    const network = NETWORK_BY_CHAIN[chainId];
    if (!network) return null;

    const payload = await this.call(
      `/networks/${network}/tokens/${tokenAddress.toLowerCase()}/pools?page=1`,
      poolListSchema,
    );

    /*
     * What the token is priced *against* is ranked before how deep the pool is.
     *
     * Depth alone picks the wrong pool surprisingly often, because a candle
     * from a pool is a ratio, not a price: charting a token against an exotic
     * counter-asset plots that asset's volatility rather than the token's
     * value. DAI on Base is the case that exposed it — its deepest pool is
     * DAI/VCNT at roughly $54k, ahead of DAI/USDC at $23k, and the resulting
     * "DAI price" swung between 1.00 and 0.35. For a token whose entire purpose
     * is to sit at a dollar, that chart is not merely noisy, it is wrong.
     *
     * So pools quoted in a dollar stablecoin come first, then the majors, then
     * anything else — and depth only breaks ties within a tier. A shallower
     * pool against USDC tells the truth about a token; a deep one against
     * something nobody prices in does not.
     */
    const ranked = payload.data
      .map((pool) => {
        const [, quoteSymbol] = splitPairName(pool.attributes.name);
        return {
          pool,
          reserve: Number(pool.attributes.reserve_in_usd ?? '0'),
          tier: quoteTier(quoteSymbol),
          isBase: isBaseToken(pool, tokenAddress),
        };
      })
      /*
       * The token must be the pool's base, or the candles are about a
       * different asset entirely.
       *
       * GeckoTerminal returns every pool a token appears in, including ones
       * where it is the quote. DAI on Base is the case that caught this: its
       * deepest listed pool is USDXSMART/DAI at roughly $106k, and charting it
       * plotted USDXSMART's price in DAI — a "DAI price" wandering between 0.36
       * and 0.75. Ranking by quote asset made it worse rather than better,
       * because a DAI quote scores as an ideal stable pairing.
       */
      .filter((entry) => entry.isBase)
      .filter((entry) => Number.isFinite(entry.reserve) && entry.reserve > 0)
      .sort((a, b) => (a.tier === b.tier ? b.reserve - a.reserve : a.tier - b.tier));

    const deepest = ranked[0];

    if (!deepest) return null;

    const [baseSymbol, quoteSymbol] = splitPairName(deepest.pool.attributes.name);

    return {
      address: deepest.pool.attributes.address,
      dex: deepest.pool.relationships?.dex?.data?.id ?? 'unknown',
      baseSymbol,
      quoteSymbol,
      reserveUsd: deepest.pool.attributes.reserve_in_usd ?? null,
    };
  }

  async getCandles(request: PriceHistoryRequest): Promise<Candle[]> {
    const network = NETWORK_BY_CHAIN[request.chainId];
    if (!network) return [];

    const [timeframe, aggregate] = TIMEFRAME[request.interval]!;
    const params = new URLSearchParams({
      aggregate: String(aggregate),
      limit: String(Math.min(request.limit ?? 300, 1000)),
      currency: 'usd',
    });

    const payload = await this.call(
      `/networks/${network}/pools/${request.poolAddress.toLowerCase()}/ohlcv/${timeframe}?${params}`,
      ohlcvSchema,
    );

    const candles = payload.data.attributes.ohlcv_list.flatMap((entry): Candle[] => {
      const [time, open, high, low, close, volume] = entry;
      // A null in any price position means the pool did not trade in that
      // period. Charting a zero there would draw a spike to the axis.
      if (open === null || high === null || low === null || close === null) return [];
      return [{ time, open, high, low, close, volume: volume ?? 0 }];
    });

    /*
     * The API returns newest-first; lightweight-charts requires strictly
     * ascending time and silently misdraws otherwise. Sorting rather than
     * reversing means a change in the API's ordering cannot break the chart.
     */
    candles.sort((a, b) => a.time - b.time);

    return dedupeByTime(candles);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetch(`${BASE_URL}/networks/base`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  private async call<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ProviderError(this.name, 'Price history provider did not respond', {
        retryable: true,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    // A token with no indexed pool 404s. That is an answer, not a failure.
    if (response.status === 404) {
      throw new ProviderError(this.name, 'No price history for that pool', { retryable: false });
    }

    if (!response.ok) {
      throw new ProviderError(
        this.name,
        response.status === 429
          ? 'Price history provider is rate limiting us'
          : 'Price history provider is unavailable',
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ProviderError(this.name, 'Price history provider returned an unexpected response', {
        retryable: false,
      });
    }
    return parsed.data;
  }
}

/**
 * Whether the pool prices this token, rather than pricing something else in it.
 *
 * Compared by address rather than by symbol: symbols are not unique on-chain,
 * and the pool name is a display string that has already proved unreliable.
 */
function isBaseToken(
  pool: { relationships?: { base_token?: { data?: { id: string } | null } | null } | null },
  tokenAddress: string,
): boolean {
  const baseId = pool.relationships?.base_token?.data?.id;
  // No relationship data means we cannot prove it either way. Treated as usable
  // so a response shape change degrades to the old behaviour rather than
  // emptying every chart on the site.
  if (!baseId) return true;
  return baseId.toLowerCase().endsWith(tokenAddress.toLowerCase());
}

/** Dollar stablecoins, which make a pool's ratio read directly as a USD price. */
const STABLE_QUOTES = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'USDC.E', 'PYUSD', 'FRAX', 'LUSD']);

/** Assets liquid enough that a ratio against them still tracks value usefully. */
const MAJOR_QUOTES = new Set(['WETH', 'ETH', 'CBBTC', 'WBTC', 'CBETH', 'WSTETH']);

/**
 * Lower is better. Used to rank pools before depth, so the chart is drawn
 * against something the price actually means anything in.
 */
function quoteTier(quoteSymbol: string): number {
  const symbol = quoteSymbol.trim().toUpperCase();
  if (STABLE_QUOTES.has(symbol)) return 0;
  if (MAJOR_QUOTES.has(symbol)) return 1;
  return 2;
}

/** GeckoTerminal names pools "AERO / USDC" or "AERO / USDC 1%". */
function splitPairName(name: string | null | undefined): [string, string] {
  if (!name) return ['', ''];
  const [base, quote] = name.split('/').map((part) => part.trim());
  return [base ?? '', (quote ?? '').replace(/\s+[\d.]+%$/, '')];
}

function dedupeByTime(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const candle of candles) {
    // Keep the last value seen for a stamp: on a duplicate, the later entry is
    // the more settled one.
    if (out.length > 0 && out[out.length - 1]!.time === candle.time) out[out.length - 1] = candle;
    else out.push(candle);
  }
  return out;
}
