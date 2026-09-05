import type { ProviderMeta, ProviderResult } from '../common';

/**
 * On-chain execution.
 *
 * This is a *sourcing* venue, not a customer-facing one. The customer never
 * chooses a pool, a route, or a protocol — they buy $100 of SOL and the router
 * decides how to obtain it.
 *
 * The interface is deliberately shaped around the four things that actually go
 * wrong on-chain:
 *
 *   1. **Price impact.** `getRoutes` returns impact per route so the router can
 *      refuse a trade that would move the market against us.
 *   2. **Slippage between quote and fill.** Every submission carries a
 *      `minAmountOut` that the router computes and the on-chain call enforces.
 *      There is no code path that submits without one.
 *   3. **Reverts.** `simulate` runs before `submit`, always. A swap that fails
 *      simulation is never broadcast, so we do not pay gas to learn it fails.
 *   4. **MEV.** `submit` takes a `private` flag; the adapter routes through
 *      protected infrastructure where the chain offers it. Public submission is
 *      a recorded decision, not a default nobody noticed.
 */

export interface RouteHop {
  protocolSlug: string;
  poolAddress?: string;
  fromSymbol: string;
  toSymbol: string;
  /** Share of the order sent through this hop, in basis points of 10000. */
  portionBps?: number;
}

export interface DexRoute {
  /** Opaque handle the adapter uses to reconstruct this exact route on submit. */
  routeId: string;
  protocolSlug: string;
  chain: string;

  fromSymbol: string;
  toSymbol: string;
  amountIn: string;
  /** Expected output before slippage, at current pool state. */
  expectedOut: string;

  /** How far this trade moves the price against us. The key risk number. */
  priceImpactBps: number;
  /** Protocol/LP fee, denominated in the output asset unless stated otherwise. */
  protocolFee: string;
  /** Estimated gas, in the chain's native asset. */
  estimatedGasNative: string;
  /** Same gas, valued in USD, so routes on different chains are comparable. */
  estimatedGasUsd: string;

  hops: RouteHop[];
  /** Longer routes are more fragile and cost more gas. */
  hopCount: number;

  /** Total liquidity backing this route, when the venue reports it. */
  liquidityUsd?: string;

  raw?: unknown;
}

export interface GetRoutesInput {
  chain: string;
  fromSymbol: string;
  toSymbol: string;
  amountIn: string;
  /** Restrict to these protocol slugs. The router passes the approved whitelist. */
  allowedProtocols: string[];
  /** Routes worse than this are not worth returning. */
  maxPriceImpactBps?: number;
}

export type SimulationOutcome = 'WOULD_SUCCEED' | 'WOULD_REVERT' | 'INDETERMINATE';

export interface SwapSimulation {
  outcome: SimulationOutcome;
  /** Output the simulation actually produced at current state. */
  simulatedOut: string;
  gasEstimateNative: string;
  revertReason?: string;
  /** Block the simulation ran against, so a stale simulation is detectable. */
  blockNumber?: number;
  raw?: unknown;
}

export interface SubmitSwapInput {
  idempotencyKey: string;
  routeId: string;
  chain: string;
  fromSymbol: string;
  toSymbol: string;
  amountIn: string;
  /**
   * The floor, enforced by the on-chain call. Not advisory: if the pool cannot
   * deliver this, the transaction reverts and we keep our input.
   */
  minAmountOut: string;
  /** Wallet the funds leave from. Always a hot wallet, never cold. */
  fromAddress: string;
  /** Transaction expiry. A swap that sits in the mempool must not fill later. */
  deadline: Date;
  /** Route through protected infrastructure rather than the public mempool. */
  private: boolean;
}

export type OnChainStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'REVERTED'
  | 'DROPPED'
  | 'FAILED';

export interface SwapReceipt {
  externalId: string;
  status: OnChainStatus;
  txHash?: string;
  amountIn: string;
  /** Actual output. Undefined until confirmed. */
  amountOut?: string;
  gasFeeNative?: string;
  blockNumber?: number;
  /** True when the adapter used protected submission for this transaction. */
  privateSubmission: boolean;
  failureReason?: string;
  raw?: unknown;
}

export interface DexProvider {
  readonly meta: ProviderMeta;

  /** Protocols this adapter can actually route through, by slug. */
  supportedProtocols(chain: string): string[];

  /** Search routes across pools. Returns best-first by net output. */
  getRoutes(input: GetRoutesInput): Promise<ProviderResult<DexRoute[]>>;

  /** Dry-run against current chain state. Mandatory before submit. */
  simulate(routeId: string, minAmountOut: string): Promise<ProviderResult<SwapSimulation>>;

  submit(input: SubmitSwapInput): Promise<ProviderResult<SwapReceipt>>;

  getSwapStatus(externalIdOrHash: string): Promise<ProviderResult<SwapReceipt>>;

  /** Native-asset price in USD, for valuing gas. */
  nativeAssetUsdPrice(chain: string): Promise<ProviderResult<string>>;
}
