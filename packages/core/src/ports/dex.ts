/**
 * DEX routing.
 *
 * The interface is shaped by one hard constraint: **FLT never signs.** An
 * adapter's job is to return an unsigned transaction and enough context for a
 * human to decide whether to sign it. There is deliberately no `submit` method
 * anywhere in this interface — broadcasting happens in the user's wallet, and
 * an adapter that could broadcast would be the first step toward custody.
 *
 * Beyond that, the shape is driven by what actually goes wrong on-chain:
 *
 *   1. **Slippage between quote and fill.** Every quote carries a
 *      `minBuyAmount` that the router contract enforces on-chain. There is no
 *      code path that produces a quote without one.
 *   2. **Price impact.** Returned per quote so the trade can be refused before
 *      the user signs something that moves the market against them. Not every
 *      aggregator reports it — see `priceImpactBps` below.
 *   3. **Allowances.** An ERC-20 swap needs an approval first. The quote says
 *      whether one is outstanding and exactly which contract to approve, so the
 *      user is told up front rather than surprised by a second wallet prompt.
 *   4. **Fee-on-transfer tokens.** Reported in `tokenTax`, because a token that
 *      takes a cut on transfer makes the quoted output a lie.
 */

export interface ProviderMeta {
  /** Stable identifier persisted on quotes, e.g. "zeroex", "mock". */
  readonly slug: string;
  readonly name: string;
  /** False when the adapter is quoting real liquidity. */
  readonly isMock: boolean;
}

/** One leg of a route. Aggregators express these differently; this is ours. */
export interface RouteFill {
  /** Liquidity source, e.g. "Uniswap_V3", "Aerodrome". */
  source: string;
  from: string;
  to: string;
  /** Share of the order through this fill, in basis points of 10000. */
  proportionBps: number;
}

export interface RouteSummary {
  fills: RouteFill[];
  /** Distinct token addresses touched along the way. */
  tokens: string[];
}

/** Transfer taxes, for tokens that take a cut. Basis points. */
export interface TokenTax {
  buyTaxBps: number;
  sellTaxBps: number;
}

export interface PriceRequest {
  chainId: number;
  sellTokenAddress: string;
  buyTokenAddress: string;
  /** Base units, as a decimal string. */
  sellAmount: string;
  /** Optional: improves accuracy where the venue simulates against a balance. */
  takerAddress?: string;
  slippageBps: number;
  /** Integrator fee to embed in the route. Omitted means no fee. */
  fee?: IntegratorFee;
}

export interface IntegratorFee {
  /** Basis points. Aggregators generally cap this; adapters must validate. */
  bps: number;
  recipientAddress: string;
  /** Must be the buy or the sell token. */
  tokenAddress: string;
}

/**
 * An indicative price. Not signable, not persisted — this is what the interface
 * shows while the user is still typing an amount.
 */
export interface IndicativePrice {
  liquidityAvailable: boolean;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  /** Native base units. */
  estimatedNetworkFee: string | null;
  route: RouteSummary | null;
  feeAmount: string | null;
  tokenTax: { buy: TokenTax; sell: TokenTax } | null;
}

export interface QuoteRequest extends PriceRequest {
  /** Required for a firm quote: the address that will sign and execute. */
  takerAddress: string;
}

/** The unsigned transaction. Exactly what the wallet is asked to sign. */
export interface UnsignedTransaction {
  to: string;
  data: string;
  /** Native value in base units. "0" for an ERC-20 sell. */
  value: string;
  /** Suggested gas limit, when the venue provides one. */
  gas: string | null;
}

export interface FirmQuote {
  liquidityAvailable: boolean;
  /** The provider's own request id, for support conversations. */
  providerRef: string | null;

  sellTokenAddress: string;
  buyTokenAddress: string;
  sellAmount: string;
  buyAmount: string;
  /** The on-chain floor. Enforced by the router contract, not by us. */
  minBuyAmount: string;

  /**
   * Price impact in basis points, or null when the venue does not report it.
   *
   * Null is a real and common answer: 0x Swap API v2 removed the field that v1
   * exposed. The quote service computes an estimate in that case rather than
   * the adapter inventing one, so the estimate is calculated in exactly one
   * place and can be labelled honestly in the interface.
   */
  priceImpactBps: number | null;

  /** Native base units. */
  estimatedNetworkFee: string | null;
  route: RouteSummary | null;

  /** The integrator fee actually embedded, in base units of its token. */
  feeAmount: string | null;
  feeTokenAddress: string | null;

  transaction: UnsignedTransaction;

  /**
   * The contract to approve, when an allowance is outstanding.
   *
   * Null means no approval is needed. When set, the interface must show the
   * user this exact address — approving the wrong contract is how people lose
   * tokens.
   */
  allowanceTarget: string | null;
  /** Base units still required beyond the current allowance. */
  allowanceNeeded: string | null;

  /** True when the venue could not fully simulate; treat output as less certain. */
  simulationIncomplete: boolean;
  tokenTax: { buy: TokenTax; sell: TokenTax } | null;
}

export interface DEXRouter {
  readonly meta: ProviderMeta;

  /** Chains this adapter can route on. */
  supportedChainIds(): readonly number[];

  /** Indicative pricing. Cheap, non-committal, safe to call as the user types. */
  getIndicativePrice(request: PriceRequest): Promise<IndicativePrice>;

  /**
   * A firm quote with signable calldata.
   *
   * Implementations MUST NOT broadcast, and MUST NOT return calldata they have
   * not been given by the venue.
   */
  getQuote(request: QuoteRequest): Promise<FirmQuote>;

  /** Liveness, for the admin System Health page. */
  health(): Promise<{ ok: boolean; detail?: string }>;
}
