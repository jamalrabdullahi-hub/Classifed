import { Decimal } from '../../domain/money';
import { ProviderError } from '../../domain/errors';
import type { ProviderMeta, ProviderResult } from '../common';
import {
  MOCK_REFERENCE_PRICES,
  MockStore,
  mockExternalId,
  mockPrice,
  mockScenarios,
} from '../mock-support';
import type {
  GetQuoteInput,
  LiquidityProvider,
  PlaceOrderInput,
  VenueBalance,
  VenueOrder,
  VenueQuote,
} from './types';

const PROVIDER = 'mock';

/**
 * In-memory liquidity venue.
 *
 * It fills at a deterministic price derived from the seed and the clock, charges
 * a flat commission, and honours idempotency keys — so a retried placeOrder
 * returns the original order rather than buying twice. Scenarios force partial
 * fills, rejections and timeouts.
 */
export class MockLiquidityProvider implements LiquidityProvider {
  readonly meta: ProviderMeta = { name: PROVIDER, kind: 'LIQUIDITY', isSandbox: true };

  /** Venue commission, in basis points, charged on the fiat value of a fill. */
  private readonly commissionBps = 10;
  private readonly orders = new MockStore<VenueOrder>();

  constructor(private readonly seed: string) {}

  reset(): void {
    this.orders.clear();
  }

  private price(symbol: string): Decimal {
    return mockPrice(symbol, this.seed);
  }

  async getQuote(input: GetQuoteInput): Promise<ProviderResult<VenueQuote>> {
    if (mockScenarios.has(PROVIDER, 'OTC_UNAVAILABLE')) {
      throw new ProviderError(PROVIDER, 'Counterparty will not quote this jurisdiction');
    }
    this.assertSupported(input.symbol, input.quoteCurrency);
    const rate = this.price(input.symbol);

    let fiatAmount: Decimal;
    let cryptoAmount: Decimal;

    if (input.fiatAmount !== undefined) {
      fiatAmount = new Decimal(input.fiatAmount);
      cryptoAmount = fiatAmount.dividedBy(rate);
    } else if (input.cryptoAmount !== undefined) {
      cryptoAmount = new Decimal(input.cryptoAmount);
      fiatAmount = cryptoAmount.times(rate);
    } else {
      throw new ProviderError(PROVIDER, 'getQuote requires fiatAmount or cryptoAmount');
    }

    const fee = fiatAmount.times(this.commissionBps).dividedBy(10_000);

    return {
      data: {
        symbol: input.symbol,
        quoteCurrency: input.quoteCurrency,
        side: input.side,
        rate: rate.toFixed(),
        fiatAmount: fiatAmount.toDecimalPlaces(18).toFixed(),
        cryptoAmount: cryptoAmount.toDecimalPlaces(18).toFixed(),
        fee: fee.toDecimalPlaces(18).toFixed(),
        feeCurrency: input.quoteCurrency,
        quoteRef: mockExternalId('vq', `${input.symbol}:${rate.toFixed()}:${fiatAmount.toFixed()}`),
        expiresAt: new Date(Date.now() + 30_000),
      },
      raw: { note: 'mock venue quote' },
    };
  }

  async placeOrder(input: PlaceOrderInput): Promise<ProviderResult<VenueOrder>> {
    this.assertSupported(input.symbol, input.quoteCurrency);

    // Idempotency: a retry after a timeout must not place a second order.
    const existing = this.orders.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { data: existing, externalId: existing.externalOrderId, raw: { replayed: true } };
    }

    const scenario = mockScenarios.get(PROVIDER);
    if (mockScenarios.has(PROVIDER, 'PROVIDER_TIMEOUT')) {
      throw new ProviderError(PROVIDER, 'Venue timed out', { retryable: true });
    }
    if (mockScenarios.has(PROVIDER, 'OTC_UNAVAILABLE')) {
      throw new ProviderError(PROVIDER, 'Counterparty will not trade this jurisdiction');
    }

    const externalOrderId = mockExternalId('vo', input.idempotencyKey);
    const rate = this.price(input.symbol);

    if (mockScenarios.has(PROVIDER, 'ORDER_REJECTED')) {
      const rejected: VenueOrder = {
        externalOrderId,
        status: 'REJECTED',
        symbol: input.symbol,
        side: input.side,
        requestedFiatAmount: input.fiatAmount,
        requestedCryptoAmount: input.cryptoAmount,
        filledCryptoAmount: '0',
        filledFiatAmount: '0',
        fee: '0',
        feeCurrency: input.quoteCurrency,
        fills: [],
        rejectReason: 'Insufficient venue liquidity',
      };
      this.orders.put(externalOrderId, rejected, input.idempotencyKey);
      return { data: rejected, externalId: externalOrderId };
    }

    // Determine the full requested size, then how much of it actually fills.
    let requestedCrypto: Decimal;
    let requestedFiat: Decimal;
    if (input.fiatAmount !== undefined) {
      requestedFiat = new Decimal(input.fiatAmount);
      requestedCrypto = requestedFiat.dividedBy(rate);
    } else if (input.cryptoAmount !== undefined) {
      requestedCrypto = new Decimal(input.cryptoAmount);
      requestedFiat = requestedCrypto.times(rate);
    } else {
      throw new ProviderError(PROVIDER, 'placeOrder requires fiatAmount or cryptoAmount');
    }

    // A partial fill delivers 60% of the requested size in two fills.
    const fillRatio = mockScenarios.has(PROVIDER, 'PARTIAL_FILL')
      ? new Decimal('0.6')
      : new Decimal(1);
    const filledCrypto = requestedCrypto.times(fillRatio).toDecimalPlaces(18, Decimal.ROUND_DOWN);
    const filledFiat = filledCrypto.times(rate).toDecimalPlaces(18, Decimal.ROUND_DOWN);
    const fee = filledFiat.times(this.commissionBps).dividedBy(10_000).toDecimalPlaces(18);

    const executedAt = new Date();
    const fills =
      mockScenarios.has(PROVIDER, 'PARTIAL_FILL')
        ? [
            this.buildFill(filledCrypto.dividedBy(2), rate, executedAt, externalOrderId, 1),
            this.buildFill(
              filledCrypto.minus(filledCrypto.dividedBy(2).toDecimalPlaces(18, Decimal.ROUND_DOWN)),
              rate,
              executedAt,
              externalOrderId,
              2,
            ),
          ]
        : [this.buildFill(filledCrypto, rate, executedAt, externalOrderId, 1)];

    const order: VenueOrder = {
      externalOrderId,
      status: fillRatio.eq(1) ? 'FILLED' : 'PARTIALLY_FILLED',
      symbol: input.symbol,
      side: input.side,
      requestedFiatAmount: requestedFiat.toFixed(),
      requestedCryptoAmount: requestedCrypto.toDecimalPlaces(18).toFixed(),
      filledCryptoAmount: filledCrypto.toFixed(),
      filledFiatAmount: filledFiat.toFixed(),
      averagePrice: rate.toFixed(),
      fee: fee.toFixed(),
      feeCurrency: input.quoteCurrency,
      fills,
    };

    this.orders.put(externalOrderId, order, input.idempotencyKey);
    return { data: order, externalId: externalOrderId, raw: { scenario } };
  }

  private buildFill(
    quantity: Decimal,
    rate: Decimal,
    executedAt: Date,
    orderId: string,
    sequence: number,
  ) {
    const qty = quantity.toDecimalPlaces(18, Decimal.ROUND_DOWN);
    const fiatValue = qty.times(rate).toDecimalPlaces(18, Decimal.ROUND_DOWN);
    return {
      quantity: qty.toFixed(),
      price: rate.toFixed(),
      fiatValue: fiatValue.toFixed(),
      fee: fiatValue.times(this.commissionBps).dividedBy(10_000).toDecimalPlaces(18).toFixed(),
      feeCurrency: 'USD',
      tradeId: `${orderId}_f${sequence}`,
      executedAt,
    };
  }

  async getOrderStatus(externalOrderId: string): Promise<ProviderResult<VenueOrder>> {
    const order = this.orders.get(externalOrderId);
    if (!order) {
      throw new ProviderError(PROVIDER, `Unknown venue order ${externalOrderId}`);
    }
    return { data: order, externalId: externalOrderId };
  }

  async getBalances(): Promise<ProviderResult<VenueBalance[]>> {
    // A generously funded house account, so mock execution never fails for
    // reasons the application would not encounter with a real venue.
    const balances: VenueBalance[] = Object.keys(MOCK_REFERENCE_PRICES).map((symbol) => ({
      symbol,
      available: '1000',
      total: '1000',
    }));
    balances.push({ symbol: 'USD', available: '1000000', total: '1000000' });
    return { data: balances };
  }

  async cancelOrder(externalOrderId: string): Promise<ProviderResult<VenueOrder>> {
    const order = this.orders.get(externalOrderId);
    if (!order) {
      throw new ProviderError(PROVIDER, `Unknown venue order ${externalOrderId}`);
    }
    if (order.status === 'FILLED') {
      throw new ProviderError(PROVIDER, 'Cannot cancel a filled order');
    }
    const cancelled: VenueOrder = { ...order, status: 'CANCELLED' };
    this.orders.put(externalOrderId, cancelled);
    return { data: cancelled, externalId: externalOrderId };
  }

  private assertSupported(symbol: string, quoteCurrency: string): void {
    if (!MOCK_REFERENCE_PRICES[symbol]) {
      throw new ProviderError(PROVIDER, `Venue does not support ${symbol}`);
    }
    if (quoteCurrency !== 'USD') {
      throw new ProviderError(PROVIDER, `Venue only quotes in USD, got ${quoteCurrency}`);
    }
  }
}
