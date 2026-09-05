import { env } from '@flt/config';
import { ProviderError } from '@flt/core/domain';
import { z } from 'zod';
import type { MarketDataProvider, MarketDataRequest, TokenMarketData } from './types.js';

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

    const params = new URLSearchParams({
      contract_addresses: request.tokenAddresses.join(','),
      vs_currencies: 'usd',
      include_24hr_change: 'true',
      include_24hr_vol: 'true',
      include_market_cap: 'true',
    });

    const payload = await this.call(
      `/simple/token_price/${platform}?${params.toString()}`,
      responseSchema,
    );
    const fetchedAt = new Date();

    // Keyed by lowercased address in the response; tokens CoinGecko does not
    // know are simply absent, and the caller renders them as unpriced.
    return request.tokenAddresses.flatMap((address) => {
      const entry = payload[address.toLowerCase()];
      if (!entry) return [];

      return [
        {
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
        },
      ];
    });
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

function numberToString(value: number | null | undefined, decimals = 8): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(decimals);
}
