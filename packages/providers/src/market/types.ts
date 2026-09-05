/**
 * Market data.
 *
 * Everything here is an ESTIMATE from a third party, and the interface labels
 * it as such. It is used for valuation and for the Markets table; it is never
 * used to price a trade. Trade pricing comes from the DEX router, which is
 * quoting actual liquidity rather than reporting an index.
 *
 * Every field is nullable because free market-data tiers routinely omit
 * liquidity and volume for smaller tokens. A null renders as "—" rather than as
 * zero: we do not claim a number we were not given.
 */

export interface TokenMarketData {
  chainId: number;
  tokenAddress: string;
  priceUsd: string | null;
  change24hPct: string | null;
  volume24hUsd: string | null;
  liquidityUsd: string | null;
  marketCapUsd: string | null;
  /** Which provider produced this, for the "source" line in the interface. */
  source: string;
  fetchedAt: Date;
}

export interface MarketDataRequest {
  chainId: number;
  /** Contract addresses. Adapters must tolerate tokens they cannot price. */
  tokenAddresses: string[];
}

export interface MarketDataProvider {
  readonly name: string;

  /**
   * Prices as many of the requested tokens as it can.
   *
   * Returns a partial result rather than throwing when some tokens are unknown:
   * one unpriceable token must not blank out the whole portfolio.
   */
  getTokenData(request: MarketDataRequest): Promise<TokenMarketData[]>;

  /** Native asset price, for valuing gas. */
  getNativeAssetPrice(chainId: number): Promise<string | null>;

  health(): Promise<{ ok: boolean; detail?: string }>;
}
