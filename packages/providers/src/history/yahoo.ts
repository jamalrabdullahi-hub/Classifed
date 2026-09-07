import { z } from 'zod';
import { ProviderError } from '@flt/core/domain';
import type { Candle, PerpCandleInterval } from '@flt/core/ports';

/**
 * Price history for real-world assets.
 *
 * ## Why this exists
 *
 * Ostium publishes no candles: it fills against an oracle price with a spread
 * rather than a resting book, so there is no trade history on the venue to
 * draw. But its underlyings are ordinary listed assets — NVDA is NVDA, gold is
 * gold — and their history exists, just not at the venue.
 *
 * That makes this a different situation from the spot path, where drawing a
 * centralised exchange's chart beside a DEX quote would show two prices for the
 * same token with no way to tell which one a trade would get. Here the venue's
 * oracle tracks the same underlying this feed reports, so the two agree by
 * construction rather than by luck — and every mapping was checked against the
 * venue's own mid before it shipped.
 *
 * ## What is deliberately not mapped
 *
 * A symbol with no trustworthy source has no chart. Ostium's USD/KRW quotes
 * around 1443 while this feed says 1345, and rather than guess which is right
 * the pair is left unmapped. An absent chart is a small gap; a wrong one is a
 * false statement about the market a user is about to take leverage on.
 *
 * ## A caveat worth stating
 *
 * This is an undocumented public endpoint, not a contracted feed. It is free
 * and keyless, which is why a fresh checkout can draw charts, and it can change
 * or rate-limit without notice. A production deployment that depends on these
 * charts should move to a paid market-data provider behind this same interface.
 */

const responseSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ regularMarketPrice: z.number().nullable().optional() }).optional(),
          timestamp: z.array(z.number()).nullable().optional(),
          indicators: z.object({
            quote: z.array(
              z.object({
                open: z.array(z.number().nullable()).nullable().optional(),
                high: z.array(z.number().nullable()).nullable().optional(),
                low: z.array(z.number().nullable()).nullable().optional(),
                close: z.array(z.number().nullable()).nullable().optional(),
                volume: z.array(z.number().nullable()).nullable().optional(),
              }),
            ),
          }),
        }),
      )
      .nullable()
      .optional(),
    error: z.unknown().nullable().optional(),
  }),
});

/**
 * The interval and lookback to request.
 *
 * The endpoint rejects a range longer than it will serve at a given interval —
 * a minute bar is only kept for a week — so each interval carries the largest
 * range it actually supports rather than one range used everywhere.
 */
const INTERVALS: Record<PerpCandleInterval, { interval: string; range: string }> = {
  '1m': { interval: '1m', range: '7d' },
  '5m': { interval: '5m', range: '60d' },
  '15m': { interval: '15m', range: '60d' },
  '1h': { interval: '1h', range: '730d' },
  // No native four-hour bar, so hourly bars are aggregated below. Requesting
  // a coarser interval instead would silently draw a different chart from the
  // one the user selected.
  '4h': { interval: '1h', range: '730d' },
  '1d': { interval: '1d', range: '10y' },
};

export class YahooPriceHistory {
  readonly name = 'yahoo';

  private cache = new Map<string, { at: number; candles: Candle[] }>();

  /**
   * @param symbol the source's own ticker, not ours — mapping is the caller's job.
   */
  async getCandles(
    symbol: string,
    interval: PerpCandleInterval,
    limit = 300,
  ): Promise<Candle[]> {
    const cacheKey = `${symbol}:${interval}`;
    const cached = this.cache.get(cacheKey);
    // Intraday bars are worth refetching often; a daily bar is not.
    const ttl = interval === '1d' ? 300_000 : 30_000;

    if (cached && Date.now() - cached.at < ttl) {
      return cached.candles.slice(-limit);
    }

    const spec = INTERVALS[interval];
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=${spec.interval}&range=${spec.range}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; FLT-Exchange)' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ProviderError(this.name, 'Price history is unreachable', {
        retryable: true,
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }

    if (response.status === 429) {
      throw new ProviderError(this.name, 'Price history is rate limiting us', { retryable: true });
    }
    if (!response.ok) {
      throw new ProviderError(this.name, `Price history returned ${response.status}`, {
        retryable: response.status >= 500,
      });
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ProviderError(this.name, 'Price history returned an unexpected shape', {
        retryable: false,
      });
    }

    const result = parsed.data.chart.result?.[0];
    const stamps = result?.timestamp ?? [];
    const quote = result?.indicators.quote[0];

    if (!result || stamps.length === 0 || !quote) return [];

    const raw: Candle[] = [];
    for (let i = 0; i < stamps.length; i += 1) {
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const close = quote.close?.[i];

      // A null bar is a gap the source itself could not fill — a market
      // holiday, a halt. Dropped rather than carried forward, because a flat
      // synthetic bar across a halt reads as a quiet market.
      if (
        open === null ||
        open === undefined ||
        high === null ||
        high === undefined ||
        low === null ||
        low === undefined ||
        close === null ||
        close === undefined
      ) {
        continue;
      }

      raw.push({
        time: stamps[i]!,
        open,
        high,
        low,
        close,
        volume: quote.volume?.[i] ?? 0,
      });
    }

    const candles = interval === '4h' ? aggregate(raw, 4 * 3_600) : raw;
    this.cache.set(cacheKey, { at: Date.now(), candles });

    return candles.slice(-limit);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const candles = await this.getCandles('^GSPC', '1d', 5);
      return { ok: candles.length > 0, detail: `${candles.length} reference bars` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}

/**
 * Rolls finer bars into coarser ones.
 *
 * Buckets are aligned to the epoch rather than to the first bar in the series,
 * so the same candle always covers the same wall-clock window no matter how
 * much history was fetched. Aligning to the first bar would shift every
 * boundary whenever the range changed.
 */
function aggregate(candles: Candle[], seconds: number): Candle[] {
  const buckets = new Map<number, Candle>();

  for (const candle of candles) {
    const start = Math.floor(candle.time / seconds) * seconds;
    const existing = buckets.get(start);

    if (!existing) {
      buckets.set(start, { ...candle, time: start });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    // Open belongs to the first bar in the bucket and is left alone; close
    // follows the last one seen, which is why the input must be in order.
    existing.close = candle.close;
    existing.volume += candle.volume;
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}
