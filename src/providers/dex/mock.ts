import { Decimal } from '../../domain/money';
import { ProviderError } from '../../domain/errors';
import type { ProviderMeta, ProviderResult } from '../common';
import { MOCK_REFERENCE_PRICES, MockStore, mockExternalId, mockPrice, mockScenarios } from '../mock-support';
import type {
  DexProvider,
  DexRoute,
  GetRoutesInput,
  OnChainStatus,
  SubmitSwapInput,
  SwapReceipt,
  SwapSimulation,
} from './types';

const PROVIDER = 'mock';

/**
 * Simulated pool depth per asset, in USD. Price impact is derived from the trade
 * size relative to this, using a constant-product approximation:
 *
 *   impact ≈ amountIn / (poolDepth + amountIn)
 *
 * These depths are fabricated. They exist so the routing engine's impact caps,
 * tier rules and fallback logic can be exercised realistically — a $50k SOL
 * order really does get rejected here, which is the behaviour we want to test.
 */
const MOCK_POOL_DEPTH_USD: Record<string, string> = {
  BTC: '40000000',
  ETH: '25000000',
  SOL: '8000000',
  USDT: '60000000',
  USDC: '60000000',
  // A deliberately thin long-tail asset, for testing tier and impact rejection.
  THIN: '17000',
};

const NATIVE_BY_CHAIN: Record<string, string> = {
  ethereum: 'ETH',
  solana: 'SOL',
  base: 'ETH',
  tron: 'TRX',
};

/** Fabricated gas costs, in USD, per chain. */
const MOCK_GAS_USD: Record<string, string> = {
  ethereum: '4.50',
  base: '0.03',
  solana: '0.002',
  tron: '1.20',
};

const MOCK_PROTOCOLS: Record<string, string[]> = {
  ethereum: ['mock-agg-eth', 'mock-amm-eth'],
  base: ['mock-agg-base'],
  solana: ['mock-agg-sol', 'mock-amm-sol'],
};

interface MockSwap extends SwapReceipt {
  chain: string;
  minAmountOut: string;
  polls: number;
}

/**
 * In-memory DEX aggregator.
 *
 * It models the parts of on-chain execution the router must handle: multiple
 * routes with different impact and gas, size-dependent price impact, simulation
 * that can predict a revert, private vs public submission, and a fill that can
 * land worse than quoted (but never worse than minAmountOut, because the
 * on-chain call enforces that floor by reverting).
 *
 * It does NOT imitate any real aggregator's API. See ./README.md.
 */
export class MockDexProvider implements DexProvider {
  readonly meta: ProviderMeta = { name: PROVIDER, kind: 'DEX', isSandbox: true };

  private readonly swaps = new MockStore<MockSwap>();
  private readonly routes = new Map<string, DexRoute>();

  constructor(private readonly seed: string) {}

  reset(): void {
    this.swaps.clear();
    this.routes.clear();
  }

  supportedProtocols(chain: string): string[] {
    return MOCK_PROTOCOLS[chain] ?? [];
  }

  /** USD price of one unit, used to convert between the two sides of a swap. */
  private usdPrice(symbol: string): Decimal {
    if (symbol === 'USD') return new Decimal(1);
    return mockPrice(symbol, this.seed);
  }

  private poolDepthUsd(symbol: string): Decimal {
    return new Decimal(MOCK_POOL_DEPTH_USD[symbol] ?? '25000');
  }

  /**
   * Constant-product price impact. Deliberately superlinear: doubling the order
   * more than doubles the impact, which is what makes size caps necessary.
   */
  private priceImpactBps(symbol: string, amountUsd: Decimal): number {
    const depth = this.poolDepthUsd(symbol);
    const impact = amountUsd.dividedBy(depth.plus(amountUsd));
    return Number(impact.times(10_000).toDecimalPlaces(0, Decimal.ROUND_UP).toFixed());
  }

  async getRoutes(input: GetRoutesInput): Promise<ProviderResult<DexRoute[]>> {
    const available = this.supportedProtocols(input.chain).filter((slug) =>
      input.allowedProtocols.includes(slug),
    );
    if (available.length === 0) {
      // No approved protocol on this chain. The router must handle this, not us.
      return { data: [] };
    }

    if (!MOCK_REFERENCE_PRICES[input.toSymbol] && input.toSymbol !== 'USD') {
      throw new ProviderError(PROVIDER, `No pool for ${input.toSymbol} on ${input.chain}`);
    }

    const amountIn = new Decimal(input.amountIn);
    const inPrice = this.usdPrice(input.fromSymbol);
    const outPrice = this.usdPrice(input.toSymbol);
    const amountUsd = amountIn.times(inPrice);

    const gasUsd = new Decimal(MOCK_GAS_USD[input.chain] ?? '1');
    const nativeSymbol = NATIVE_BY_CHAIN[input.chain] ?? 'ETH';
    const gasNative = gasUsd.dividedBy(this.usdPrice(nativeSymbol)).toDecimalPlaces(18);

    const scenario = mockScenarios.get(PROVIDER);

    const routes: DexRoute[] = available.map((slug, index) => {
      // The aggregator's own route is deeper (splits across pools) than the
      // single-pool AMM route, so it shows less impact for the same size.
      const isAggregator = slug.includes('agg');
      const depthMultiplier = isAggregator ? new Decimal(1) : new Decimal('0.45');
      const effectiveDepth = this.poolDepthUsd(input.toSymbol).times(depthMultiplier);

      const rawImpact = amountUsd.dividedBy(effectiveDepth.plus(amountUsd));
      const impactBps = Number(
        rawImpact.times(10_000).toDecimalPlaces(0, Decimal.ROUND_UP).toFixed(),
      );

      const grossOut = amountUsd.dividedBy(outPrice);
      const protocolFeeRate = new Decimal(isAggregator ? '0.0005' : '0.003');
      const protocolFee = grossOut.times(protocolFeeRate);
      const expectedOut = grossOut
        .times(new Decimal(1).minus(rawImpact))
        .minus(protocolFee)
        .toDecimalPlaces(18, Decimal.ROUND_DOWN);

      const hopCount = isAggregator ? 1 : 2;

      return {
        routeId: mockExternalId('rt', `${slug}:${input.amountIn}:${input.toSymbol}:${index}`),
        protocolSlug: slug,
        chain: input.chain,
        fromSymbol: input.fromSymbol,
        toSymbol: input.toSymbol,
        amountIn: amountIn.toFixed(),
        expectedOut: expectedOut.toFixed(),
        priceImpactBps: impactBps,
        protocolFee: protocolFee.toDecimalPlaces(18).toFixed(),
        estimatedGasNative: gasNative.toFixed(),
        estimatedGasUsd: gasUsd.toFixed(2),
        hops: Array.from({ length: hopCount }, (_, hop) => ({
          protocolSlug: slug,
          fromSymbol: hop === 0 ? input.fromSymbol : 'WETH',
          toSymbol: hop === hopCount - 1 ? input.toSymbol : 'WETH',
          portionBps: 10_000,
        })),
        hopCount,
        liquidityUsd: effectiveDepth.toFixed(2),
        raw: { scenario },
      };
    });

    const filtered =
      input.maxPriceImpactBps === undefined
        ? routes
        : routes.filter((r) => r.priceImpactBps <= input.maxPriceImpactBps!);

    // Best net output first — output minus gas, valued consistently.
    filtered.sort((a, b) => {
      const netA = new Decimal(a.expectedOut).minus(
        new Decimal(a.estimatedGasUsd).dividedBy(outPrice),
      );
      const netB = new Decimal(b.expectedOut).minus(
        new Decimal(b.estimatedGasUsd).dividedBy(outPrice),
      );
      return netB.comparedTo(netA);
    });

    for (const route of filtered) this.routes.set(route.routeId, route);

    return { data: filtered, raw: { considered: routes.length, scenario } };
  }

  async simulate(
    routeId: string,
    minAmountOut: string,
  ): Promise<ProviderResult<SwapSimulation>> {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new ProviderError(PROVIDER, `Unknown route ${routeId}; request routes again`);
    }

    const scenario = mockScenarios.get(PROVIDER);

    if (mockScenarios.has(PROVIDER, 'SWAP_WOULD_REVERT')) {
      return {
        data: {
          outcome: 'WOULD_REVERT',
          simulatedOut: '0',
          gasEstimateNative: route.estimatedGasNative,
          revertReason: 'INSUFFICIENT_OUTPUT_AMOUNT',
          blockNumber: 1_000_000,
        },
      };
    }

    // An adverse move shifts the achievable output below the floor, which is
    // exactly what simulation exists to catch before we spend gas.
    const drift = mockScenarios.has(PROVIDER, 'ADVERSE_PRICE_MOVE')
      ? new Decimal('0.97')
      : new Decimal(1);
    const simulatedOut = new Decimal(route.expectedOut).times(drift).toDecimalPlaces(18);

    return {
      data: {
        outcome: simulatedOut.gte(new Decimal(minAmountOut)) ? 'WOULD_SUCCEED' : 'WOULD_REVERT',
        simulatedOut: simulatedOut.toFixed(),
        gasEstimateNative: route.estimatedGasNative,
        revertReason: simulatedOut.gte(new Decimal(minAmountOut))
          ? undefined
          : 'INSUFFICIENT_OUTPUT_AMOUNT',
        blockNumber: 1_000_000,
      },
    };
  }

  async submit(input: SubmitSwapInput): Promise<ProviderResult<SwapReceipt>> {
    const replayed = this.swaps.findByIdempotencyKey(input.idempotencyKey);
    if (replayed) {
      return { data: replayed, externalId: replayed.externalId, raw: { replayed: true } };
    }

    const route = this.routes.get(input.routeId);
    if (!route) {
      throw new ProviderError(PROVIDER, `Unknown route ${input.routeId}`);
    }
    if (input.deadline.getTime() <= Date.now()) {
      throw new ProviderError(PROVIDER, 'Swap deadline has already passed');
    }

    const scenario = mockScenarios.get(PROVIDER);
    if (mockScenarios.has(PROVIDER, 'PROVIDER_TIMEOUT')) {
      throw new ProviderError(PROVIDER, 'RPC timed out', { retryable: true });
    }

    const externalId = mockExternalId('swap', input.idempotencyKey);
    const minOut = new Decimal(input.minAmountOut);

    // Model the MEV/adverse-move case. Public submission is sandwiched harder
    // than private submission — which is the whole argument for private routing.
    const slip =
      mockScenarios.has(PROVIDER, 'ADVERSE_PRICE_MOVE')
        ? input.private
          ? new Decimal('0.998')
          : new Decimal('0.96')
        : input.private
          ? new Decimal(1)
          : new Decimal('0.9995');

    const achieved = new Decimal(route.expectedOut).times(slip).toDecimalPlaces(18, Decimal.ROUND_DOWN);

    // The on-chain floor: if the pool cannot deliver minAmountOut the call
    // reverts and we keep our input, losing only gas.
    const reverted = achieved.lt(minOut);

    const receipt: MockSwap = {
      externalId,
      chain: input.chain,
      status: reverted ? 'REVERTED' : 'SUBMITTED',
      txHash: `0x${mockExternalId('tx', input.idempotencyKey).replace('tx_', '')}`,
      amountIn: input.amountIn,
      amountOut: reverted ? undefined : achieved.toFixed(),
      gasFeeNative: route.estimatedGasNative,
      minAmountOut: input.minAmountOut,
      privateSubmission: input.private,
      failureReason: reverted
        ? `Output ${achieved.toFixed()} below the ${minOut.toFixed()} floor; transaction reverted`
        : undefined,
      polls: 0,
    };

    this.swaps.put(externalId, receipt, input.idempotencyKey);
    return { data: receipt, externalId, raw: { scenario, slip: slip.toFixed() } };
  }

  async getSwapStatus(externalIdOrHash: string): Promise<ProviderResult<SwapReceipt>> {
    const swap =
      this.swaps.get(externalIdOrHash) ??
      this.swaps.all().find((s) => s.txHash === externalIdOrHash);
    if (!swap) {
      throw new ProviderError(PROVIDER, `Unknown swap ${externalIdOrHash}`);
    }

    // One poll to move from SUBMITTED to a terminal state, so tests are
    // deterministic rather than clock-dependent.
    if (swap.status === 'SUBMITTED') {
      const next: OnChainStatus = 'CONFIRMED';
      const updated: MockSwap = { ...swap, status: next, blockNumber: 1_000_001, polls: swap.polls + 1 };
      this.swaps.put(swap.externalId, updated);
      return { data: updated, externalId: swap.externalId };
    }

    return { data: swap, externalId: swap.externalId };
  }

  async nativeAssetUsdPrice(chain: string): Promise<ProviderResult<string>> {
    const symbol = NATIVE_BY_CHAIN[chain];
    if (!symbol) throw new ProviderError(PROVIDER, `Unknown chain ${chain}`);
    return { data: this.usdPrice(symbol).toFixed() };
  }
}

export { MOCK_POOL_DEPTH_USD, MOCK_GAS_USD, NATIVE_BY_CHAIN, MOCK_PROTOCOLS };
