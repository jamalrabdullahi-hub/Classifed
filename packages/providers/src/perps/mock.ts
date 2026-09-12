import { createHash } from 'node:crypto';
import {
  Decimal,
  estimateLiquidationPrice,
  initialMargin,
  notional,
  unrealizedPnl,
} from '@flt/core/domain';
import { ValidationError } from '@flt/core/domain';
import type {
  Candle,
  OrderBook,
  OrderPreview,
  PerpCandleInterval,
  PerpTrade,
  PerpAccountRef,
  PerpAccountSummary,
  PerpMarket,
  PerpPosition,
  MarketMakingVenue,
  MakerAction,
  MakerCancel,
  MakerCancelRequest,
  MakerQuoteRequest,
  OpenOrder,
  VenueFill,
  PrepareCloseRequest,
  PrepareLeverageRequest,
  PrepareOrderRequest,
  PreparedAction,
  ProviderMeta,
  VenueAuthorization,
} from './types';

/**
 * Deterministic perpetual venue. No network, no bridged collateral, no risk.
 *
 * Like the mock DEX router, this is a simulator rather than a stub. Leverage
 * makes that distinction matter more, not less: the screens being built against
 * it are the ones that tell a user how far the market can move before their
 * position is closed for them, and they cannot be trusted if they were only
 * ever exercised against a flat, always-profitable fixture.
 *
 * So it reproduces the dynamics that the interface has to survive:
 *
 *   - **Positions carry real PnL**, seeded per account and market, in both
 *     directions. Some are near liquidation, because the escalation states in
 *     the position panel are the ones most likely to be wrong.
 *   - **Funding is signed and varies by market**, so the funding display is
 *     exercised paying and receiving rather than only paying.
 *   - **A market order is bounded by slippage**, matching the real adapters,
 *     so a market order is never submitted as an unbounded one anywhere.
 *   - **Authorisation starts ungranted**, so the agent-approval flow is on the
 *     default path in development instead of being reachable only in
 *     production.
 *
 * Everything is seeded from its inputs, so the same account always sees the
 * same book and tests do not flake.
 */

const MOCK_SLUG = 'mock';

/** Recognisably fake — nobody should mistake this for a venue that holds money. */
const MOCK_ENDPOINT = 'https://mock.invalid/exchange';

const MOCK_INTERVAL_MINUTES: Record<PerpCandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

/** Prices are carried as numbers only inside the candle generator. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface MockMarketSpec {
  symbol: string;
  name: string;
  price: string;
  maxLeverage: number;
  sizeDecimals: number;
  minSize: string;
  /** Per-hour funding as a decimal fraction. Negative means shorts pay. */
  fundingRate: string;
}

const MARKETS: MockMarketSpec[] = [
  { symbol: 'BTC', name: 'Bitcoin', price: '64250.5', maxLeverage: 40, sizeDecimals: 5, minSize: '0.0001', fundingRate: '0.0000125' },
  { symbol: 'ETH', name: 'Ethereum', price: '3187.42', maxLeverage: 25, sizeDecimals: 4, minSize: '0.001', fundingRate: '0.0000094' },
  { symbol: 'SOL', name: 'Solana', price: '148.73', maxLeverage: 20, sizeDecimals: 2, minSize: '0.01', fundingRate: '-0.0000210' },
  { symbol: 'ARB', name: 'Arbitrum', price: '0.8642', maxLeverage: 10, sizeDecimals: 1, minSize: '1', fundingRate: '0.0000318' },
  { symbol: 'DOGE', name: 'Dogecoin', price: '0.14238', maxLeverage: 10, sizeDecimals: 0, minSize: '10', fundingRate: '-0.0000087' },
];

export class MockPerpVenue implements MarketMakingVenue {
  readonly meta: ProviderMeta = {
    slug: MOCK_SLUG,
    name: 'Simulated perpetuals (development)',
    isMock: true,
  };

  readonly supportsMarketMaking = true as const;

  readonly settlementChainId = 8453;
  readonly requiresBridgedCollateral = false;

  constructor(private readonly seed: string = 'flt-dev') {}

  async listMarkets(): Promise<PerpMarket[]> {
    return MARKETS.map((spec) => this.toMarket(spec));
  }

  async getMarket(symbol: string): Promise<PerpMarket | null> {
    const spec = MARKETS.find((m) => m.symbol === symbol.toUpperCase());
    return spec ? this.toMarket(spec) : null;
  }

  async getOrderBook(symbol: string, depth = 12): Promise<OrderBook> {
    const market = await this.requireMarket(symbol);
    const mid = new Decimal(market.markPrice as string);
    const tick = mid.dividedBy(20_000).toDecimalPlaces(2, Decimal.ROUND_UP);

    // Sizes decay away from the touch with a deterministic wobble, so the depth
    // bars in the ladder are uneven the way a real book is. A perfectly smooth
    // book would let a rendering bug in the depth overlay pass unnoticed.
    const level = (index: number, direction: 1 | -1) => {
      const price = mid.plus(tick.times(index + 1).times(direction));
      const wobble = (this.roll(`${market.symbol}:${direction}:${index}`) % 70) / 100;
      return {
        price: price.toFixed(2),
        size: new Decimal(1.2).plus(index * 0.28).plus(wobble).toFixed(4),
        orderCount: (this.roll(`n:${market.symbol}:${direction}:${index}`) % 40) + 1,
      };
    };

    return {
      symbol: market.symbol,
      bids: Array.from({ length: depth }, (_, i) => level(i, -1)),
      asks: Array.from({ length: depth }, (_, i) => level(i, 1)),
      capturedAt: new Date(),
    };
  }

  async getCandles(
    symbol: string,
    interval: PerpCandleInterval,
    limit = 200,
  ): Promise<Candle[]> {
    const market = await this.requireMarket(symbol);
    const minutes = MOCK_INTERVAL_MINUTES[interval];
    const step = minutes * 60;
    const now = Math.floor(Date.now() / 1000);
    const start = now - step * limit;

    const candles: Candle[] = [];
    let close = Number(market.markPrice) * 0.94;

    for (let i = 0; i < limit; i += 1) {
      const seed = this.roll(`${market.symbol}:${interval}:${i}`);
      // A bounded random walk with a gentle upward drift, so the chart has a
      // shape rather than being noise around a flat line.
      const drift = 0.0006;
      const move = ((seed % 2000) / 1000 - 1) * 0.008 + drift;
      const open = close;
      close = open * (1 + move);
      const high = Math.max(open, close) * (1 + (seed % 40) / 10_000);
      const low = Math.min(open, close) * (1 - (seed % 37) / 10_000);

      candles.push({
        time: start + i * step,
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: Math.round(40 + (seed % 260)),
      });
    }

    return candles;
  }

  async getRecentTrades(symbol: string, limit = 40): Promise<PerpTrade[]> {
    const market = await this.requireMarket(symbol);
    const mid = new Decimal(market.markPrice as string);
    const now = Date.now();

    return Array.from({ length: limit }, (_, i) => {
      const seed = this.roll(`trade:${market.symbol}:${i}`);
      const buy = seed % 2 === 0;
      const offset = new Decimal((seed % 9) - 4).dividedBy(10);

      return {
        price: mid.plus(offset).toFixed(2),
        size: new Decimal(0.02).plus((seed % 300) / 1000).toFixed(4),
        side: buy ? ('BUY' as const) : ('SELL' as const),
        at: new Date(now - i * 2_400),
      };
    });
  }

  async getPositions(account: PerpAccountRef): Promise<PerpPosition[]> {
    // Two positions, deterministic per account: one comfortable, one close to
    // liquidation, so the interface's worst case is always on screen.
    const specs = ['BTC', 'SOL']
      .map((symbol) => MARKETS.find((m) => m.symbol === symbol))
      .filter((spec): spec is MockMarketSpec => spec !== undefined);

    return specs.map((spec, index) => {
      const roll = this.roll(`${account.address}:${spec.symbol}`);
      const side = roll % 2 === 0 ? 'LONG' : 'SHORT';
      const leverage = index === 0 ? 5 : Math.max(2, spec.maxLeverage - 5);
      const size = new Decimal(spec.minSize).times(index === 0 ? 250 : 40).toFixed();

      // Entry is displaced from mark, adversely for the second position, so it
      // sits near its liquidation price.
      const drift = index === 0 ? 0.03 : 0.9;
      const sign = side === 'LONG' ? 1 : -1;
      const mark = new Decimal(spec.price);
      const liquidationSpan = mark.dividedBy(leverage);
      const entry = mark.plus(liquidationSpan.times(drift).times(sign));

      const margin = initialMargin(size, entry.toFixed(), leverage);
      const pnl = unrealizedPnl(side, size, entry.toFixed(), spec.price);

      return {
        symbol: spec.symbol,
        side,
        size,
        entryPrice: entry.toFixed(spec.sizeDecimals + 2),
        margin,
        marginMode: 'ISOLATED',
        leverage,
        liquidationPrice: estimateLiquidationPrice({
          side,
          entryPrice: entry.toFixed(),
          leverage,
          maxLeverage: spec.maxLeverage,
        }),
        unrealizedPnl: pnl,
        fundingPaid: new Decimal(notional(size, spec.price))
          .times(spec.fundingRate)
          .times(18)
          .toFixed(4),
      } satisfies PerpPosition;
    });
  }

  async getAccountSummary(account: PerpAccountRef): Promise<PerpAccountSummary> {
    const positions = await this.getPositions(account);

    const marginUsed = positions.reduce(
      (total, position) => total.plus(position.margin),
      new Decimal(0),
    );
    const pnl = positions.reduce(
      (total, position) => total.plus(position.unrealizedPnl ?? '0'),
      new Decimal(0),
    );
    const free = new Decimal(2500);

    return {
      accountValue: marginUsed.plus(pnl).plus(free).toFixed(2),
      withdrawable: free.toFixed(2),
      totalMarginUsed: marginUsed.toFixed(2),
      totalUnrealizedPnl: pnl.toFixed(2),
      hasCollateral: true,
    };
  }

  async authorizationStatus(): Promise<VenueAuthorization> {
    return {
      required: false,
      granted: true,
      description:
        'The simulated venue needs no authorisation. A real venue will ask you to sign one here.',
      expiresAt: null,
    };
  }

  async prepareAuthorization(): Promise<PreparedAction> {
    throw new ValidationError('The simulated venue does not require authorisation');
  }

  async previewOrder(request: PrepareOrderRequest): Promise<OrderPreview> {
    const { intent } = request;
    const market = await this.requireMarket(intent.symbol);
    const price = intent.limitPrice ?? (market.markPrice as string);

    const positions = await this.getPositions(request);
    const existing = positions.find((p) => p.symbol === market.symbol);

    const orderNotional = notional(intent.size, price);
    const fee = new Decimal(orderNotional).times('0.00035');
    const integratorFee = request.fee
      ? new Decimal(orderNotional).times(request.fee.bps).dividedBy(10_000)
      : null;

    return {
      symbol: market.symbol,
      side: intent.side,
      size: intent.size,
      estimatedPrice: price,
      notional: orderNotional,
      marginRequired: initialMargin(intent.size, price, intent.leverage),
      estimatedFee: fee.toFixed(4),
      integratorFee: integratorFee ? integratorFee.toFixed(4) : null,
      liquidationPrice: estimateLiquidationPrice({
        side: intent.side,
        entryPrice: price,
        leverage: intent.leverage,
        maxLeverage: market.maxLeverage,
      }),
      reversesPosition:
        existing !== undefined &&
        existing.side !== intent.side &&
        new Decimal(intent.size).greaterThan(existing.size),
    };
  }

  async prepareOrder(request: PrepareOrderRequest): Promise<PreparedAction> {
    const { intent } = request;
    const market = await this.requireMarket(intent.symbol);
    const reference = intent.limitPrice ?? (market.markPrice as string);

    return {
      kind: 'venue-order',
      endpoint: MOCK_ENDPOINT,
      requiresAgentKey: false,
      order: {
        assetId: market.venueAssetId,
        symbol: market.symbol,
        isBuy: intent.side === 'LONG',
        size: intent.size,
        limitPrice: boundPrice(reference, intent.side === 'LONG', intent.slippageBps),
        timeInForce: intent.limitPrice ? 'GTC' : 'IOC',
        reduceOnly: intent.reduceOnly,
        trigger: null,
        builderFeeTenthsBps: request.fee ? request.fee.bps * 10 : null,
        builderAddress: request.fee?.recipientAddress ?? null,
      },
    };
  }

  async prepareClose(request: PrepareCloseRequest): Promise<PreparedAction> {
    const market = await this.requireMarket(request.symbol);
    const positions = await this.getPositions(request);
    const position = positions.find((p) => p.symbol === market.symbol);

    if (!position) {
      throw new ValidationError('No open position on this market', { symbol: request.symbol });
    }

    const size = request.size ?? position.size;
    if (new Decimal(size).greaterThan(position.size)) {
      throw new ValidationError('Cannot close more than the open size', {
        requested: size,
        open: position.size,
      });
    }

    // Closing a long means selling, so the direction inverts.
    const isBuy = position.side === 'SHORT';

    return {
      kind: 'venue-order',
      endpoint: MOCK_ENDPOINT,
      requiresAgentKey: false,
      order: {
        assetId: market.venueAssetId,
        symbol: market.symbol,
        isBuy,
        size,
        limitPrice: boundPrice(market.markPrice as string, isBuy, request.slippageBps),
        timeInForce: 'IOC',
        reduceOnly: true,
        trigger: null,
        builderFeeTenthsBps: request.fee ? request.fee.bps * 10 : null,
        builderAddress: request.fee?.recipientAddress ?? null,
      },
    };
  }

  async prepareLeverageChange(request: PrepareLeverageRequest): Promise<PreparedAction> {
    const market = await this.requireMarket(request.symbol);
    if (request.leverage > market.maxLeverage) {
      throw new ValidationError(`This market allows at most ${market.maxLeverage}x`, {
        requested: request.leverage,
      });
    }

    return {
      kind: 'venue-order',
      endpoint: MOCK_ENDPOINT,
      requiresAgentKey: false,
      order: {
        assetId: market.venueAssetId,
        symbol: market.symbol,
        isBuy: true,
        size: '0',
        limitPrice: market.markPrice as string,
        timeInForce: 'GTC',
        reduceOnly: false,
        trigger: null,
        builderFeeTenthsBps: null,
        builderAddress: null,
      },
    };
  }

  /**
   * The simulator rests no orders.
   *
   * Nothing in it signs or submits, so there is no book to report. A runner test
   * that needs a populated book stubs this; the honest default is empty.
   */
  async getOpenOrders(): Promise<OpenOrder[]> {
    return [];
  }

  async getFills(): Promise<VenueFill[]> {
    return [];
  }

  async prepareMakerQuote(request: MakerQuoteRequest): Promise<MakerAction> {
    const market = await this.requireMarket(request.symbol);
    return {
      kind: 'maker-quotes',
      endpoint: MOCK_ENDPOINT,
      quotes: [
        {
          assetId: market.venueAssetId,
          symbol: market.symbol,
          isBuy: request.isBuy,
          price: request.price,
          size: request.size,
          cloid: request.cloid,
        },
      ],
    };
  }

  async prepareMakerCancel(request: MakerCancelRequest): Promise<MakerAction> {
    const cancels: MakerCancel[] = [];
    for (const cancel of request.cancels) {
      const market = await this.requireMarket(cancel.symbol);
      cancels.push({
        assetId: market.venueAssetId,
        oid: cancel.oid ?? null,
        cloid: cancel.cloid ?? null,
      });
    }
    return { kind: 'maker-cancel', endpoint: MOCK_ENDPOINT, cancels };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'Simulated venue — no real liquidity' };
  }

  private async requireMarket(symbol: string): Promise<PerpMarket> {
    const market = await this.getMarket(symbol);
    if (!market) {
      throw new ValidationError('Unknown market', { symbol });
    }
    return market;
  }

  private toMarket(spec: MockMarketSpec): PerpMarket {
    // A small deterministic spread between oracle and mark, because they are
    // different numbers on a real venue and the interface should not be built
    // assuming they agree.
    const index = new Decimal(spec.price);
    const mark = index.times(new Decimal(1).plus(new Decimal(this.roll(spec.symbol) % 7).dividedBy(100_000)));

    return {
      symbol: spec.symbol,
      name: spec.name,
      venueAssetId: MARKETS.findIndex((entry) => entry.symbol === spec.symbol),
      maxLeverage: spec.maxLeverage,
      sizeDecimals: spec.sizeDecimals,
      minSize: spec.minSize,
      indexPrice: index.toFixed(),
      markPrice: mark.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''),
      fundingRate: spec.fundingRate,
      fundingIntervalHours: 1,
      openInterest: new Decimal(this.roll(`oi:${spec.symbol}`) % 90_000).plus(10_000).toFixed(),
      assetClass: 'CRYPTO',
      isMarketOpen: true,
      secondsToSessionChange: null,
      isDelisted: false,
    };
  }

  private roll(input: string): number {
    const digest = createHash('sha256').update(`${this.seed}:${input}`).digest();
    return digest.readUInt32BE(0);
  }
}

/**
 * The price bound sent with a market order.
 *
 * A buy tolerates paying up, a sell tolerates receiving less. Submitting a
 * market order without this bound is how a thin book fills someone at a price
 * they would never have accepted, so no adapter here is permitted to omit it.
 */
export function boundPrice(reference: string, isBuy: boolean, slippageBps: number): string {
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new ValidationError('Slippage must be a non-negative whole number of basis points', {
      slippageBps,
    });
  }
  const factor = new Decimal(slippageBps).dividedBy(10_000);
  const multiplier = isBuy ? new Decimal(1).plus(factor) : new Decimal(1).minus(factor);
  return new Decimal(reference).times(multiplier).toFixed();
}
