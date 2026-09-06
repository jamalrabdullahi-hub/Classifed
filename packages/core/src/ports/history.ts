/**
 * Price history.
 *
 * Kept apart from `MarketDataProvider` because it answers a different question.
 * Market data is "what is this token worth right now", used for valuation.
 * History is "what has this pool done over time", used for a chart. They have
 * different sources, different cache lifetimes and different failure modes, so
 * a provider that can do one is not obliged to do the other.
 *
 * The distinction that matters for FLT: these candles come from the DEX pools we
 * actually route through, not from a centralised exchange's order book. A chart
 * drawn from CEX prices sitting next to a quote drawn from on-chain liquidity
 * would show two different numbers for the same token and offer the user no way
 * to tell which one their trade will get.
 */

export type CandleInterval = '5m' | '1h' | '4h' | '1d';

export const CANDLE_INTERVALS: readonly CandleInterval[] = ['5m', '1h', '4h', '1d'] as const;

export function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value);
}

export interface Candle {
  /** Unix seconds, at the open of the period. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** The pool a token's chart is drawn from, surfaced so the UI can attribute it. */
export interface PoolReference {
  address: string;
  /** The venue, e.g. "aerodrome-base". Shown to the user. */
  dex: string;
  baseSymbol: string;
  quoteSymbol: string;
  /** Pool reserves in USD, when the provider reports them. */
  reserveUsd: string | null;
}

export interface PriceHistoryRequest {
  chainId: number;
  poolAddress: string;
  interval: CandleInterval;
  /** Maximum candles to return. Providers may return fewer. */
  limit?: number;
}

export interface PriceHistoryProvider {
  readonly name: string;

  /**
   * Finds the pool a token's price should be read from.
   *
   * Returns null when the token has no pool the provider knows about, which is
   * normal for a token that is in our registry but thinly traded. The caller
   * renders "no chart available" rather than an empty chart, because an empty
   * chart reads as "the price is zero".
   */
  findPrimaryPool(chainId: number, tokenAddress: string): Promise<PoolReference | null>;

  /** Candles in ascending time order, oldest first, with no duplicate stamps. */
  getCandles(request: PriceHistoryRequest): Promise<Candle[]>;

  health(): Promise<{ ok: boolean; detail?: string }>;
}
