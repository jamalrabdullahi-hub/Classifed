import { createHash } from 'node:crypto';
import type { MarketDataProvider, MarketDataRequest, TokenMarketData } from './types';

/**
 * Deterministic market data for development.
 *
 * Prices are seeded from the token address, so a given token always shows the
 * same price and the interface does not flicker between renders. Stablecoins
 * are pinned near $1 so the portfolio reads plausibly.
 *
 * One token in seven deliberately returns null liquidity and volume, so the
 * "we were not given this number" rendering path is exercised rather than
 * discovered in production.
 */
export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = 'mock';

  constructor(private readonly seed: string = 'flt-dev') {}

  async getTokenData(request: MarketDataRequest): Promise<TokenMarketData[]> {
    return request.tokenAddresses.map((address) => {
      const digest = this.hash(address);
      const sparse = BigInt(`0x${digest.slice(0, 2)}`) % 7n === 0n;

      return {
        chainId: request.chainId,
        tokenAddress: address,
        priceUsd: this.price(address, digest),
        change24hPct: this.change(digest),
        volume24hUsd: sparse ? null : this.magnitude(digest.slice(8, 16), 100_000, 40_000_000),
        liquidityUsd: sparse ? null : this.magnitude(digest.slice(16, 24), 250_000, 90_000_000),
        marketCapUsd: sparse ? null : this.magnitude(digest.slice(24, 32), 1_000_000, 900_000_000),
        source: 'mock',
        fetchedAt: new Date(),
      };
    });
  }

  async getNativeAssetPrice(): Promise<string> {
    return '3150.00';
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'simulated' };
  }

  private price(address: string, digest: string): string {
    if (STABLE_ADDRESSES.has(address.toLowerCase())) {
      // Stables drift by a fraction of a cent, as they do in reality.
      const drift = Number(BigInt(`0x${digest.slice(0, 4)}`) % 60n) - 30;
      return (1 + drift / 100_000).toFixed(6);
    }

    const magnitude = Number(BigInt(`0x${digest.slice(4, 8)}`) % 5n);
    const base = Number(BigInt(`0x${digest.slice(0, 6)}`) % 100_000n) / 100;
    return (base * 10 ** (magnitude - 2)).toFixed(8);
  }

  private change(digest: string): string {
    // Roughly -12% to +12%.
    const raw = Number(BigInt(`0x${digest.slice(32, 38)}`) % 2_400n) - 1_200;
    return (raw / 100).toFixed(2);
  }

  private magnitude(slice: string, min: number, max: number): string {
    const span = BigInt(max - min);
    return (min + Number(BigInt(`0x${slice}`) % span)).toFixed(2);
  }

  private hash(value: string): string {
    return createHash('sha256').update(this.seed).update(value.toLowerCase()).digest('hex');
  }
}

/** Base stablecoins, so the mock portfolio does not price USDC at $47. */
const STABLE_ADDRESSES = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
]);
