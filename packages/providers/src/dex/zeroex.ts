import { env } from '@flt/config';
import { ProviderError, ProviderNotConfiguredError } from '@flt/core/domain';
import { z } from 'zod';
import type {
  DEXRouter,
  FirmQuote,
  IndicativePrice,
  PriceRequest,
  ProviderMeta,
  QuoteRequest,
  RouteSummary,
  TokenTax,
} from './types';

/**
 * 0x Swap API v2 adapter.
 *
 * Endpoint:  GET {base}/swap/allowance-holder/{price,quote}
 * Headers:   0x-api-key, 0x-version: v2
 *
 * Two decisions worth recording:
 *
 * **AllowanceHolder rather than Permit2.** Permit2 saves the user an approval
 * transaction by having them sign an off-chain permit instead. That is a better
 * user experience and a worse first experience: the signature request is opaque,
 * and teaching users to sign unfamiliar typed data is exactly the habit that
 * gets them drained. AllowanceHolder uses a plain ERC-20 `approve`, which every
 * wallet renders clearly and every user has seen before. Revisit once the
 * interface can explain a permit properly.
 *
 * **Responses are schema-validated.** An aggregator changing a field name
 * should fail loudly here rather than silently produce a quote with an
 * undefined `minBuyAmount` — which would mean submitting a swap with no floor.
 */

const ZEROEX_SLUG = 'zeroex';

/** 0x caps affiliate fees at 1000 bps. Reject above it rather than be rejected. */
const MAX_FEE_BPS = 1_000;

const taxSchema = z
  .object({
    buyTaxBps: z.coerce.number().default(0),
    sellTaxBps: z.coerce.number().default(0),
  })
  .partial()
  .passthrough();

const routeSchema = z
  .object({
    fills: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          source: z.string(),
          proportionBps: z.coerce.number(),
        }),
      )
      .default([]),
    tokens: z
      .array(z.object({ address: z.string(), symbol: z.string().optional() }))
      .default([]),
  })
  .passthrough();

const feesSchema = z
  .object({
    integratorFee: z
      .object({ amount: z.string(), token: z.string(), type: z.string().optional() })
      .nullish(),
    zeroExFee: z.object({ amount: z.string(), token: z.string() }).nullish(),
    gasFee: z.object({ amount: z.string(), token: z.string() }).nullish(),
  })
  .passthrough();

const issuesSchema = z
  .object({
    allowance: z.object({ actual: z.string(), spender: z.string() }).nullish(),
    balance: z.object({ token: z.string(), actual: z.string(), expected: z.string() }).nullish(),
    simulationIncomplete: z.boolean().nullish(),
    invalidSourcesPassed: z.array(z.string()).nullish(),
  })
  .passthrough();

const tokenMetadataSchema = z
  .object({ buyToken: taxSchema.nullish(), sellToken: taxSchema.nullish() })
  .passthrough();

const priceResponseSchema = z
  .object({
    liquidityAvailable: z.boolean(),
    zid: z.string().optional(),
    buyAmount: z.string().optional(),
    sellAmount: z.string().optional(),
    minBuyAmount: z.string().optional(),
    totalNetworkFee: z.string().nullish(),
    route: routeSchema.nullish(),
    fees: feesSchema.nullish(),
    issues: issuesSchema.nullish(),
    tokenMetadata: tokenMetadataSchema.nullish(),
  })
  .passthrough();

const quoteResponseSchema = priceResponseSchema.extend({
  allowanceTarget: z.string().nullish(),
  transaction: z
    .object({
      to: z.string(),
      data: z.string(),
      value: z.string().nullish(),
      gas: z.string().nullish(),
      gasPrice: z.string().nullish(),
    })
    .nullish(),
});

export class ZeroExRouter implements DEXRouter {
  readonly meta: ProviderMeta = {
    slug: ZEROEX_SLUG,
    name: '0x Swap API',
    isMock: false,
  };

  private readonly supported = [8453] as const;

  supportedChainIds(): readonly number[] {
    return this.supported;
  }

  async getIndicativePrice(request: PriceRequest): Promise<IndicativePrice> {
    const payload = await this.call('price', request, priceResponseSchema);

    if (!payload.liquidityAvailable) {
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
      sellAmount: payload.sellAmount ?? request.sellAmount,
      buyAmount: required(payload.buyAmount, 'buyAmount'),
      minBuyAmount: required(payload.minBuyAmount, 'minBuyAmount'),
      estimatedNetworkFee: payload.totalNetworkFee ?? null,
      route: mapRoute(payload.route),
      feeAmount: payload.fees?.integratorFee?.amount ?? null,
      tokenTax: mapTax(payload.tokenMetadata),
    };
  }

  async getQuote(request: QuoteRequest): Promise<FirmQuote> {
    const payload = await this.call('quote', request, quoteResponseSchema);

    if (!payload.liquidityAvailable) {
      return {
        liquidityAvailable: false,
        providerRef: payload.zid ?? null,
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

    // A firm quote without calldata is not a firm quote. Fail rather than
    // return something the interface would present as signable.
    if (!payload.transaction) {
      throw new ProviderError(ZEROEX_SLUG, 'Quote returned no transaction to sign', {
        retryable: true,
      });
    }

    const minBuyAmount = required(payload.minBuyAmount, 'minBuyAmount');
    const allowance = payload.issues?.allowance ?? null;

    return {
      liquidityAvailable: true,
      providerRef: payload.zid ?? null,
      sellTokenAddress: request.sellTokenAddress,
      buyTokenAddress: request.buyTokenAddress,
      sellAmount: payload.sellAmount ?? request.sellAmount,
      buyAmount: required(payload.buyAmount, 'buyAmount'),
      minBuyAmount,

      // v2 does not report price impact. The quote service estimates it against
      // a reference quote; the adapter does not invent a number.
      priceImpactBps: null,

      estimatedNetworkFee: payload.totalNetworkFee ?? null,
      route: mapRoute(payload.route),
      feeAmount: payload.fees?.integratorFee?.amount ?? null,
      feeTokenAddress: payload.fees?.integratorFee?.token ?? request.fee?.tokenAddress ?? null,

      transaction: {
        to: payload.transaction.to,
        data: payload.transaction.data,
        value: payload.transaction.value ?? '0',
        gas: payload.transaction.gas ?? null,
      },

      // 0x tells us the spender to approve. It must be AllowanceHolder; we pass
      // through exactly what the API returned rather than deriving it, and
      // never substitute the Settler contract.
      allowanceTarget: allowance?.spender ?? payload.allowanceTarget ?? null,
      allowanceNeeded: allowance ? request.sellAmount : null,

      simulationIncomplete: payload.issues?.simulationIncomplete ?? false,
      tokenTax: mapTax(payload.tokenMetadata),
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await this.fetchWithTimeout(
        `${env().ZEROEX_API_BASE_URL}/swap/chains`,
        5_000,
      );
      return response.ok
        ? { ok: true }
        : { ok: false, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async call<T extends z.ZodTypeAny>(
    endpoint: 'price' | 'quote',
    request: PriceRequest,
    schema: T,
  ): Promise<z.infer<T>> {
    const config = env();
    if (!config.ZEROEX_API_KEY) {
      throw new ProviderNotConfiguredError(ZEROEX_SLUG, 'ZEROEX_API_KEY is not set');
    }

    const params = new URLSearchParams({
      chainId: String(request.chainId),
      sellToken: request.sellTokenAddress,
      buyToken: request.buyTokenAddress,
      sellAmount: request.sellAmount,
      slippageBps: String(request.slippageBps),
    });

    if (request.takerAddress) params.set('taker', request.takerAddress);

    if (request.fee && request.fee.bps > 0) {
      if (request.fee.bps > MAX_FEE_BPS) {
        throw new ProviderError(
          ZEROEX_SLUG,
          `Integrator fee of ${request.fee.bps} bps exceeds the ${MAX_FEE_BPS} bps maximum`,
        );
      }
      params.set('swapFeeBps', String(request.fee.bps));
      params.set('swapFeeRecipient', request.fee.recipientAddress);
      params.set('swapFeeToken', request.fee.tokenAddress);
    }

    const url = `${config.ZEROEX_API_BASE_URL}/swap/allowance-holder/${endpoint}?${params.toString()}`;

    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, 12_000);
    } catch (error) {
      throw new ProviderError(ZEROEX_SLUG, 'The routing provider did not respond in time', {
        retryable: true,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(ZEROEX_SLUG, describeHttpFailure(response.status), {
        // 5xx and 429 are worth retrying; a 400 means our request was wrong.
        retryable: response.status >= 500 || response.status === 429,
        details: { status: response.status, body: body.slice(0, 500) },
      });
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = schema.safeParse(json);

    if (!parsed.success) {
      // The contract changed. Surfacing this as a provider error rather than
      // coercing the response keeps a malformed quote from reaching a wallet.
      throw new ProviderError(ZEROEX_SLUG, 'The routing provider returned an unexpected response', {
        retryable: false,
        details: { issues: parsed.error.issues.slice(0, 5) },
      });
    }

    return parsed.data;
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: {
          '0x-api-key': env().ZEROEX_API_KEY ?? '',
          '0x-version': 'v2',
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return 'The routing provider rejected our credentials';
  if (status === 429) return 'The routing provider is rate limiting us';
  if (status >= 500) return 'The routing provider is unavailable';
  return 'The routing provider rejected the quote request';
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value === '') {
    throw new ProviderError(ZEROEX_SLUG, `Quote response is missing ${field}`, {
      retryable: true,
    });
  }
  return value;
}

function mapRoute(route: z.infer<typeof routeSchema> | null | undefined): RouteSummary | null {
  if (!route) return null;
  return {
    fills: route.fills.map((fill) => ({
      source: fill.source,
      from: fill.from,
      to: fill.to,
      proportionBps: fill.proportionBps,
    })),
    tokens: route.tokens.map((token) => token.address),
  };
}

function mapTax(
  metadata: z.infer<typeof tokenMetadataSchema> | null | undefined,
): { buy: TokenTax; sell: TokenTax } | null {
  if (!metadata) return null;
  return {
    buy: {
      buyTaxBps: metadata.buyToken?.buyTaxBps ?? 0,
      sellTaxBps: metadata.buyToken?.sellTaxBps ?? 0,
    },
    sell: {
      buyTaxBps: metadata.sellToken?.buyTaxBps ?? 0,
      sellTaxBps: metadata.sellToken?.sellTaxBps ?? 0,
    },
  };
}
