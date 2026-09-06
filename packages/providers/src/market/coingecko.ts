import { env } from '@flt/config';
import { ProviderError, isNativeToken } from '@flt/core/domain';
import { z } from 'zod';
import type { MarketDataProvider, MarketDataRequest, TokenMarketData } from './types';

/**
 * CoinGecko adapter, using the contract-address endpoint so tokens are keyed by
 * what they actually are on-chain rather than by a symbol that several tokens
 * can share.
 *
 * The free tier is rate-limited to a handful of calls a minute, which is why
 * results are cached in `market_data_cache` by the caller rather than fetched
 * per page render. This adapter does the fetching and nothing else.
 */

const PLATFORM_BY_CHAIN: Record<number, string> = {
  8453: 'base',
};

const NATIVE_COIN_BY_CHAIN: Record<number, string> = {
  8453: 'ethereum',
};

const entrySchema = z.object({
  usd: z.number().nullish(),
  usd_24h_change: z.number().nullish(),
  usd_24h_vol: z.number().nullish(),
  usd_market_cap: z.number().nullish(),
});

const responseSchema = z.record(z.string(), entrySchema);

export class CoinGeckoMarketDataProvider implements MarketDataProvider {
  readonly name = 'coingecko';

  async getTokenData(request: MarketDataRequest): Promise<TokenMarketData[]> {
    const platform = PLATFORM_BY_CHAIN[request.chainId];
    if (!platform || request.tokenAddresses.length === 0) return [];

    /*
     * The native asset is carried through the system as a sentinel address,
     * which is not a real contract. Sending it to the contract-price endpoint
     * makes CoinGecko reject the ENTIRE batch, so one pseudo-address would cost
     * every other token its price rather than just its own. It is split out and
     * priced through the coin endpoint instead.
     */
    const contracts = request.tokenAddresses.filter((address) => !isNativeToken(address));
    const natives = request.tokenAddresses.filter((address) => isNativeToken(address));

    const fetchedAt = new Date();
    const results: TokenMarketData[] = [];

    /*
     * Requests are chunked because the keyless tier rejects more than one
     * contract address per call outright (error 10012) — and it rejects the
     * whole request, so an unchunked batch returns nothing at all rather than
     * a truncated list. Verified against the live API: two addresses already
     * fail. Keyed tiers lift the limit, so a key buys back the batching.
     */
    const chunkSize = env().COINGECKO_API_KEY ? 50 : 1;
    const chunks: string[][] = [];
    for (let index = 0; index < contracts.length; index += chunkSize) {
      chunks.push(contracts.slice(index, index + chunkSize));
    }

    let failures = 0;

    for (const [index, chunk] of chunks.entries()) {
      // Space the calls out on the keyless tier, whose per-minute allowance is
      // small enough that a tight loop over a token list trips it.
      if (index > 0 && !env().COINGECKO_API_KEY) await sleep(1_500);

      const params = new URLSearchParams({
        contract_addresses: chunk.join(','),
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_24hr_vol: 'true',
        include_market_cap: 'true',
      });

      let payload: z.infer<typeof responseSchema>;
      try {
        payload = await this.call(
          `/simple/token_price/${platform}?${params.toString()}`,
          responseSchema,
        );
      } catch (error) {
        /*
         * One chunk failing must not cost the others their prices. The
         * interface promises a partial result, and a rate limit part-way
         * through a token list is the normal case on a free tier, not an
         * exceptional one.
         */
        failures += 1;
        console.warn('[coingecko] chunk failed', {
          tokens: chunk.length,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Keyed by lowercased address in the response; tokens CoinGecko does not
      // know are simply absent, and the caller renders them as unpriced.
      for (const address of chunk) {
        const entry = payload[address.toLowerCase()];
        if (!entry) continue;

        results.push({
          chainId: request.chainId,
          tokenAddress: address,
          priceUsd: numberToString(entry.usd),
          change24hPct: numberToString(entry.usd_24h_change, 4),
          volume24hUsd: numberToString(entry.usd_24h_vol, 2),
          // CoinGecko does not report pool liquidity on this endpoint. Null is
          // the honest answer rather than substituting volume for it.
          liquidityUsd: null,
          marketCapUsd: numberToString(entry.usd_market_cap, 2),
          source: this.name,
          fetchedAt,
        });
      }
    }

    // Every chunk failing is an outage, not a partial result, and the caller
    // should hear about it rather than silently cache an empty refresh.
    if (chunks.length > 0 && failures === chunks.length) {
      throw new ProviderError(this.name, 'Market data provider is unavailable', {
        retryable: true,
      });
    }

    for (const address of natives) {
      const coin = NATIVE_COIN_BY_CHAIN[request.chainId];
      if (!coin) continue;

      const params = new URLSearchParams({
        ids: coin,
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_24hr_vol: 'true',
        include_market_cap: 'true',
      });

      // Guarded like the chunks above: the native asset failing must not cost
      // every ERC-20 in the same refresh its price.
      try {
        const payload = await this.call(`/simple/price?${params.toString()}`, responseSchema);
        const entry = payload[coin];
        if (!entry) continue;

        results.push({
          chainId: request.chainId,
          tokenAddress: address,
          priceUsd: numberToString(entry.usd),
          change24hPct: numberToString(entry.usd_24h_change, 4),
          volume24hUsd: numberToString(entry.usd_24h_vol, 2),
          liquidityUsd: null,
          marketCapUsd: numberToString(entry.usd_market_cap, 2),
          source: this.name,
          fetchedAt,
        });
      } catch (error) {
        console.warn('[coingecko] native asset price failed', {
          chainId: request.chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  async getNativeAssetPrice(chainId: number): Promise<string | null> {
    const coin = NATIVE_COIN_BY_CHAIN[chainId];
    if (!coin) return null;

    const payload = await this.call(
      `/simple/price?ids=${coin}&vs_currencies=usd`,
      responseSchema,
    );
    return numberToString(payload[coin]?.usd);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetch(`${this.baseUrl()}/ping`, {
        headers: this.headers(),
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
      response = await fetch(`${this.baseUrl()}${path}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ProviderError(this.name, 'Market data provider did not respond', {
        retryable: true,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    if (!response.ok) {
      throw new ProviderError(
        this.name,
        response.status === 429
          ? 'Market data provider is rate limiting us'
          : 'Market data provider is unavailable',
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ProviderError(this.name, 'Market data provider returned an unexpected response', {
        retryable: false,
      });
    }
    return parsed.data;
  }

  private baseUrl(): string {
    // The keyed tier lives on a different host from the free one.
    return env().COINGECKO_API_KEY
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
  }

  private headers(): Record<string, string> {
    const key = env().COINGECKO_API_KEY;
    return key ? { 'x-cg-pro-api-key': key, accept: 'application/json' } : { accept: 'application/json' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberToString(value: number | null | undefined, decimals = 8): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(decimals);
}
