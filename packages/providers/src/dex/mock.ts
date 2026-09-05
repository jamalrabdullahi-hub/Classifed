import { createHash } from 'node:crypto';
import { isNativeToken } from '@flt/core/domain';
import type {
  DEXRouter,
  FirmQuote,
  IndicativePrice,
  PriceRequest,
  ProviderMeta,
  QuoteRequest,
  RouteSummary,
} from './types';

/**
 * Deterministic simulator. No network, no API key.
 *
 * This is not a stub that returns fixed numbers. It reproduces the behaviours
 * the trade path has to handle correctly, so the interface, the quote service
 * and the test suite are all exercised against realistic dynamics:
 *
 *   - **Price impact grows superlinearly with size** (constant-product), so a
 *     large order into a shallow pool really does trip the impact ceiling.
 *   - **minBuyAmount is always below buyAmount** by the requested slippage, so
 *     the floor is a real number the review screen can display.
 *   - **ERC-20 sells require an allowance**; native sells do not. The approval
 *     step is therefore exercised in development.
 *   - **Multi-hop routes** appear for pairs with no direct pool, so the route
 *     display is not always a single fill.
 *
 * Everything is seeded from the request, so the same inputs always produce the
 * same quote and tests do not flake.
 */

const MOCK_SLUG = 'mock';

/**
 * A stand-in AllowanceHolder address. Recognisably fake — nobody should mistake
 * this for a contract to approve on a real chain.
 */
const MOCK_ALLOWANCE_TARGET = '0x0000000000000000000000000000000000005A1E';
const MOCK_ROUTER = '0x000000000000000000000000000000000000D3F0';

/** Notional pool depth, in base units of the sell token. Drives impact. */
const POOL_DEPTH = 5_000_000n;

export class MockRouter implements DEXRouter {
  readonly meta: ProviderMeta = {
    slug: MOCK_SLUG,
    name: 'Simulated liquidity (development)',
    isMock: true,
  };

  constructor(private readonly seed: string = 'flt-dev') {}

  supportedChainIds(): readonly number[] {
    return [8453];
  }

  async getIndicativePrice(request: PriceRequest): Promise<IndicativePrice> {
    const result = this.price(request);

    if (!result.liquidityAvailable) {
      return {
        liquidityAvailable: false,
        sellAmount: request.sellAmount,
        buyAmount: '0',
        minBuyAmount: '0',
        estimatedNetworkFee: null,
        route: null,
        feeAmount: null,
        tokenTax: null,
      };
    }

    return {
      liquidityAvailable: true,
      sellAmount: request.sellAmount,
      buyAmount: result.buyAmount.toString(),
      minBuyAmount: result.minBuyAmount.toString(),
      estimatedNetworkFee: result.networkFee.toString(),
      route: result.route,
      feeAmount: result.feeAmount.toString(),
      tokenTax: null,
    };
  }

  async getQuote(request: QuoteRequest): Promise<FirmQuote> {
    const result = this.price(request);

    if (!result.liquidityAvailable) {
      return {
        liquidityAvailable: false,
        providerRef: null,
        sellTokenAddress: request.sellTokenAddress,
        buyTokenAddress: request.buyTokenAddress,
        sellAmount: request.sellAmount,
        buyAmount: '0',
        minBuyAmount: '0',
        priceImpactBps: null,
        estimatedNetworkFee: null,
        route: null,
        feeAmount: null,
        feeTokenAddress: null,
        transaction: { to: '', data: '', value: '0', gas: null },
        allowanceTarget: null,
        allowanceNeeded: null,
        simulationIncomplete: false,
        tokenTax: null,
      };
    }

    const sellsNative = isNativeToken(request.sellTokenAddress);

    return {
      liquidityAvailable: true,
      providerRef: `mock-${this.hash(request).slice(0, 12)}`,
      sellTokenAddress: request.sellTokenAddress,
      buyTokenAddress: request.buyTokenAddress,
      sellAmount: request.sellAmount,
      buyAmount: result.buyAmount.toString(),
      minBuyAmount: result.minBuyAmount.toString(),

      // The mock CAN compute impact exactly, since it owns the curve. It still
      // returns null, to match what a real v2 adapter reports — otherwise the
      // quote service's estimation path would never run in development.
      priceImpactBps: null,

      estimatedNetworkFee: result.networkFee.toString(),
      route: result.route,
      feeAmount: result.feeAmount.toString(),
      feeTokenAddress: request.fee?.tokenAddress ?? null,

      transaction: {
        to: MOCK_ROUTER,
        // Recognisably synthetic calldata. Signing it on a real chain would
        // simply fail, which is the intended safety property.
        data: `0xdeadbeef${this.hash(request)}`,
        value: sellsNative ? request.sellAmount : '0',
        gas: '250000',
      },

      // Native sells need no approval; ERC-20 sells do. Modelled so the
      // approval step is exercised without a real chain.
      allowanceTarget: sellsNative ? null : MOCK_ALLOWANCE_TARGET,
      allowanceNeeded: sellsNative ? null : request.sellAmount,

      simulationIncomplete: false,
      tokenTax: null,
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'simulated' };
  }

  // ── Pricing model ─────────────────────────────────────────────────────────

  private price(request: PriceRequest) {
    const sellAmount = BigInt(request.sellAmount);

    if (sellAmount <= 0n) {
      return { liquidityAvailable: false as const };
    }

    // A pair whose seeded depth is tiny has no route at all, so the
    // "no liquidity" path is reachable in development.
    const depth = this.poolDepth(request);
    if (depth < sellAmount / 100n) {
      return { liquidityAvailable: false as const };
    }

    // Constant product: out = (in * depth) / (depth + in). Impact therefore
    // grows superlinearly with size, exactly as a real AMM does.
    const baseRate = this.rate(request);
    const grossOut = (sellAmount * baseRate * depth) / ((depth + sellAmount) * 10_000n);

    const feeBps = BigInt(request.fee?.bps ?? 0);
    const feeAmount = (grossOut * feeBps) / 10_000n;
    const buyAmount = grossOut - feeAmount;

    const minBuyAmount = (buyAmount * BigInt(10_000 - request.slippageBps)) / 10_000n;

    return {
      liquidityAvailable: true as const,
      buyAmount,
      minBuyAmount,
      feeAmount,
      // Base gas costs on Base are fractions of a cent; this is a plausible
      // constant rather than a model.
      networkFee: 42_000_000_000_000n,
      route: this.route(request),
    };
  }

  /** Seeded exchange rate, in basis points, stable per token pair. */
  private rate(request: PriceRequest): bigint {
    const digest = this.hash({
      a: request.sellTokenAddress.toLowerCase(),
      b: request.buyTokenAddress.toLowerCase(),
    });
    // 0.5x to 2.5x, deterministic per pair.
    return 5_000n + (BigInt(`0x${digest.slice(0, 8)}`) % 20_000n);
  }

  private poolDepth(request: PriceRequest): bigint {
    const digest = this.hash({
      pool: [request.sellTokenAddress, request.buyTokenAddress].sort().join(':').toLowerCase(),
    });
    // Most pairs are deep; roughly one in sixteen is shallow enough to refuse
    // large orders, so the impact ceiling is exercised.
    const multiplier = 1n + (BigInt(`0x${digest.slice(0, 4)}`) % 16n);
    return POOL_DEPTH * multiplier;
  }

  private route(request: PriceRequest): RouteSummary {
    const digest = this.hash({ route: request.sellTokenAddress + request.buyTokenAddress });
    const direct = BigInt(`0x${digest.slice(0, 2)}`) % 3n !== 0n;

    if (direct) {
      return {
        fills: [
          {
            source: 'Aerodrome',
            from: request.sellTokenAddress,
            to: request.buyTokenAddress,
            proportionBps: 10_000,
          },
        ],
        tokens: [request.sellTokenAddress, request.buyTokenAddress],
      };
    }

    // Split across two sources, so the route display handles more than one fill.
    return {
      fills: [
        {
          source: 'Uniswap_V3',
          from: request.sellTokenAddress,
          to: request.buyTokenAddress,
          proportionBps: 6_500,
        },
        {
          source: 'Aerodrome',
          from: request.sellTokenAddress,
          to: request.buyTokenAddress,
          proportionBps: 3_500,
        },
      ],
      tokens: [request.sellTokenAddress, request.buyTokenAddress],
    };
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(this.seed).update(JSON.stringify(value)).digest('hex');
  }
}
