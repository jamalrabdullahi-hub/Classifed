import { createHash } from 'node:crypto';
import type {
  Candle,
  CandleInterval,
  PoolReference,
  PriceHistoryProvider,
  PriceHistoryRequest,
} from './types';

/**
 * Deterministic price history for development.
 *
 * A seeded random walk rather than noise, so the chart looks like a market and
 * the same token always draws the same shape. Without that, every render would
 * redraw a different history and no visual regression would be noticeable.
 *
 * Candle boundaries are snapped to real interval starts so the time axis reads
 * correctly, and the most recent candle is left partially formed, as a live one
 * would be.
 */

const SECONDS: Record<CandleInterval, number> = {
  '5m': 300,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

export class MockPriceHistoryProvider implements PriceHistoryProvider {
  readonly name = 'mock';

  constructor(private readonly seed: string = 'flt-dev') {}

  async findPrimaryPool(_chainId: number, tokenAddress: string): Promise<PoolReference | null> {
    const digest = this.hash(tokenAddress);

    // One token in nine has no pool, so the "no chart available" path is
    // exercised in development rather than discovered in production.
    if (BigInt(`0x${digest.slice(0, 2)}`) % 9n === 0n) return null;

    return {
      address: `0x${digest.slice(0, 40)}`,
      dex: 'aerodrome-base',
      baseSymbol: 'TOKEN',
      quoteSymbol: 'USDC',
      reserveUsd: (250_000 + Number(BigInt(`0x${digest.slice(8, 16)}`) % 40_000_000n)).toFixed(2),
    };
  }

  async getCandles(request: PriceHistoryRequest): Promise<Candle[]> {
    const step = SECONDS[request.interval]!;
    const count = Math.min(request.limit ?? 300, 500);
    const digest = this.hash(`${request.poolAddress}:${request.interval}`);

    // Snap to the interval boundary so candles land on real period starts.
    const latest = Math.floor(Date.now() / 1000 / step) * step;
    const start = latest - step * (count - 1);

    let price = 0.5 + Number(BigInt(`0x${digest.slice(0, 8)}`) % 400_00n) / 100;
    const candles: Candle[] = [];

    for (let index = 0; index < count; index += 1) {
      // Re-hash per step: a deterministic walk that still varies bar to bar.
      const bar = this.hash(`${digest}:${index}`);
      const drift = (Number(BigInt(`0x${bar.slice(0, 6)}`) % 2_000n) - 1_000) / 100_000;

      const open = price;
      const close = Math.max(open * (1 + drift), 0.000001);
      const spread = open * (Number(BigInt(`0x${bar.slice(6, 10)}`) % 400n) / 100_000);
      const high = Math.max(open, close) + spread;
      const low = Math.max(Math.min(open, close) - spread, 0.0000001);

      candles.push({
        time: start + index * step,
        open,
        high,
        low,
        close,
        volume: Number(BigInt(`0x${bar.slice(10, 18)}`) % 2_000_000n),
      });

      price = close;
    }

    return candles;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'simulated' };
  }

  private hash(value: string): string {
    return createHash('sha256').update(this.seed).update(value.toLowerCase()).digest('hex');
  }
}
