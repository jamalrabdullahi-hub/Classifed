import { env } from '@flt/config';
import { ProviderError, ProviderNotConfiguredError, ValidationError } from '@flt/core/domain';
import {
  Decimal,
  initialMargin,
  isTriggerOrder,
  notional,
  triggerRestsAsLimit,
  type PerpOrderIntent,
} from '@flt/core/domain';
import { z } from 'zod';
import { boundPrice } from './mock';
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
  PerpSide,
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
  NormalizedVenueOrder,
  VenueAuthorization,
} from './types';

/**
 * Hyperliquid adapter.
 *
 * Endpoints: POST {base}/info      — reads, unauthenticated
 *            POST {base}/exchange  — writes, every one an EIP-712 signature
 *
 * ## What this adapter does and deliberately does not do
 *
 * It reads. Markets, prices, funding, positions and account margin all come
 * from `/info`, which needs no key and no signature, and every response is
 * schema-validated for the same reason the 0x adapter validates its own: a
 * field quietly changing shape must fail loudly here rather than surface as a
 * position with an undefined liquidation price.
 *
 * It does **not** sign, and it does not post to `/exchange`. Orders are
 * returned as fully-specified `venue-order` actions and submitted by the
 * client. Two reasons, one architectural and one practical:
 *
 *   - Hyperliquid's L1 actions are signed over a msgpack encoding folded into a
 *     "phantom agent" digest. A second implementation of that encoding, living
 *     here, would be a silent-failure machine: a mis-ordered field still yields
 *     a well-formed signature that the venue rejects, or that authorises
 *     something other than what was shown to the user. The venue's own
 *     maintained client does the encoding instead.
 *   - Signing here would require a key here. The agent key is generated in the
 *     user's browser and never transmitted, which is the only reason delegated
 *     order placement is acceptable at all.
 *
 * ## Collateral does not live on Base
 *
 * Hyperliquid settles on its own L1, so margin must be bridged out of the chain
 * the user's wallet is linked on. `requiresBridgedCollateral` is true and the
 * interface is required to say so before a user commits anything.
 *
 * ## Status
 *
 * The read path is exercised against the live API. The write path has not been
 * confirmed against mainnet with real collateral — see deploy/PRODUCTION.md.
 */

const HYPERLIQUID_SLUG = 'hyperliquid';

/** Hyperliquid caps builder fees on perpetuals at 10 bps. Refuse above it rather than be refused. */
const MAX_BUILDER_FEE_BPS = 10;

/** Hyperliquid settles on its own L1. This is its chain id, not Base's. */
const HYPERLIQUID_CHAIN_ID = 1337;

/**
 * The chain id an agent approval is signed against.
 *
 * Deliberately not 1337: wallets refuse to sign for a chain they do not know,
 * which is the whole reason the agent-key indirection exists. User-signed
 * actions use a real chain id (Arbitrum) so the wallet renders them.
 */
const SIGNATURE_CHAIN_ID = 42_161;

/** How far back to reach for a given interval when requesting candles. */
const INTERVAL_MINUTES: Record<PerpCandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

const universeSchema = z.object({
  name: z.string(),
  szDecimals: z.coerce.number(),
  maxLeverage: z.coerce.number(),
  isDelisted: z.boolean().nullish(),
});

const assetContextSchema = z.object({
  markPx: z.string().nullish(),
  oraclePx: z.string().nullish(),
  funding: z.string().nullish(),
  openInterest: z.string().nullish(),
});

const metaAndCtxsSchema = z.tuple([
  z.object({ universe: z.array(universeSchema) }),
  z.array(assetContextSchema),
]);

const positionSchema = z.object({
  position: z.object({
    coin: z.string(),
    szi: z.string(),
    entryPx: z.string().nullish(),
    positionValue: z.string().nullish(),
    unrealizedPnl: z.string().nullish(),
    liquidationPx: z.string().nullish(),
    marginUsed: z.string().nullish(),
    leverage: z.object({
      type: z.string(),
      value: z.coerce.number(),
    }),
    cumFunding: z
      .object({ allTime: z.string().nullish(), sinceOpen: z.string().nullish() })
      .nullish(),
  }),
});

const clearinghouseSchema = z.object({
  assetPositions: z.array(positionSchema).default([]),
  withdrawable: z.string().nullish(),
  marginSummary: z
    .object({
      accountValue: z.string().nullish(),
      totalMarginUsed: z.string().nullish(),
    })
    .nullish(),
});

const bookLevelSchema = z.object({
  px: z.string(),
  sz: z.string(),
  n: z.coerce.number().nullish(),
});

const bookSchema = z.object({
  coin: z.string(),
  levels: z.tuple([z.array(bookLevelSchema), z.array(bookLevelSchema)]),
  time: z.coerce.number().nullish(),
});

const candleSchema = z.object({
  t: z.coerce.number(),
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.string(),
});

const tradeSchema = z.object({
  px: z.string(),
  sz: z.string(),
  // "B" when the aggressor bought. Anything else is treated as a sell rather
  // than trusted blindly, so an unexpected value cannot paint the tape green.
  side: z.string(),
  time: z.coerce.number(),
});

const agentSchema = z.array(
  z.object({
    address: z.string(),
    name: z.string().nullish(),
    validUntil: z.coerce.number().nullish(),
  }),
);

/** A resting order, as `/info` reports it. */
const openOrderSchema = z.object({
  coin: z.string(),
  side: z.enum(['B', 'A']),
  limitPx: z.string(),
  sz: z.string(),
  oid: z.coerce.number(),
  timestamp: z.coerce.number(),
  origSz: z.string(),
  cloid: z.string().nullish(),
  reduceOnly: z.literal(true).nullish(),
});

/** A trade, as `/info userFills` reports it. */
const userFillSchema = z.object({
  coin: z.string(),
  px: z.string(),
  sz: z.string(),
  side: z.enum(['B', 'A']),
  time: z.coerce.number(),
  closedPnl: z.string(),
  hash: z.string(),
  oid: z.coerce.number(),
  crossed: z.boolean(),
  fee: z.string(),
  tid: z.coerce.number(),
});

/**
 * A client order id is `0x` followed by 32 hex characters. Reject a malformed
 * one here rather than let the venue refuse the whole batch it was part of.
 */
function assertCloid(cloid: string): string {
  if (!/^0x[0-9a-fA-F]{32}$/.test(cloid)) {
    throw new ValidationError('A client order id must be 0x followed by 32 hex characters', {
      cloid,
    });
  }
  return cloid;
}

export class HyperliquidPerpVenue implements MarketMakingVenue {
  readonly meta: ProviderMeta = {
    slug: HYPERLIQUID_SLUG,
    name: 'Hyperliquid',
    isMock: false,
  };

  readonly supportsMarketMaking = true as const;

  readonly settlementChainId = HYPERLIQUID_CHAIN_ID;
  readonly requiresBridgedCollateral = true;

  private universeCache: { at: number; markets: PerpMarket[] } | null = null;

  async listMarkets(): Promise<PerpMarket[]> {
    // Short cache: the universe changes rarely, but prices ride along with it
    // in the same call, so this cannot be cached for long.
    if (this.universeCache && Date.now() - this.universeCache.at < 5_000) {
      return this.universeCache.markets;
    }

    const parsed = metaAndCtxsSchema.parse(await this.info({ type: 'metaAndAssetCtxs' }));
    const [meta, contexts] = parsed;

    const markets = meta.universe.map((asset, index) => {
      const context = contexts[index];
      return {
        symbol: asset.name,
        name: asset.name,
        // Hyperliquid's asset id is the position in the *unfiltered* universe.
        // Captured here, while that ordering is still intact.
        venueAssetId: index,
        maxLeverage: asset.maxLeverage,
        sizeDecimals: asset.szDecimals,
        minSize: new Decimal(1).dividedBy(new Decimal(10).pow(asset.szDecimals)).toFixed(),
        indexPrice: context?.oraclePx ?? null,
        markPrice: context?.markPx ?? null,
        fundingRate: context?.funding ?? null,
        fundingIntervalHours: 1,
        openInterest: context?.openInterest ?? null,
        // Hyperliquid lists crypto only, and a crypto book never closes.
      assetClass: 'CRYPTO',
      isMarketOpen: true,
      secondsToSessionChange: null,
      isDelisted: asset.isDelisted ?? false,
      } satisfies PerpMarket;
    });

    this.universeCache = { at: Date.now(), markets };
    return markets;
  }

  async getMarket(symbol: string): Promise<PerpMarket | null> {
    const markets = await this.listMarkets();
    return markets.find((m) => m.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  }

  async getOrderBook(symbol: string, depth = 12): Promise<OrderBook> {
    const market = await this.requireMarket(symbol);
    const raw = bookSchema.parse(await this.info({ type: 'l2Book', coin: market.symbol }));

    const [bids, asks] = raw.levels;
    const level = (entry: { px: string; sz: string; n?: number | null }) => ({
      price: entry.px,
      size: entry.sz,
      orderCount: entry.n ?? null,
    });

    return {
      symbol: market.symbol,
      // Hyperliquid already returns bids descending and asks ascending. Sorted
      // again rather than assumed: a ladder rendered from a wrongly ordered
      // book puts the best price in the middle of the list, which reads as a
      // spread that does not exist.
      bids: bids.map(level).sort((a, b) => Number(b.price) - Number(a.price)).slice(0, depth),
      asks: asks.map(level).sort((a, b) => Number(a.price) - Number(b.price)).slice(0, depth),
      capturedAt: raw.time ? new Date(raw.time) : new Date(),
    };
  }

  async getCandles(
    symbol: string,
    interval: PerpCandleInterval,
    limit = 200,
  ): Promise<Candle[]> {
    const market = await this.requireMarket(symbol);
    const minutes = INTERVAL_MINUTES[interval];
    const endTime = Date.now();
    const startTime = endTime - minutes * 60_000 * limit;

    const raw = z
      .array(candleSchema)
      .parse(
        await this.info({
          type: 'candleSnapshot',
          req: { coin: market.symbol, interval, startTime, endTime },
        }),
      );

    return raw
      .map((candle) => ({
        // Lightweight Charts wants seconds; the venue reports milliseconds.
        time: Math.floor(candle.t / 1000),
        open: Number(candle.o),
        high: Number(candle.h),
        low: Number(candle.l),
        close: Number(candle.c),
        volume: Number(candle.v),
      }))
      .filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.close))
      .sort((a, b) => a.time - b.time);
  }

  async getRecentTrades(symbol: string, limit = 40): Promise<PerpTrade[]> {
    const market = await this.requireMarket(symbol);
    const raw = z
      .array(tradeSchema)
      .parse(await this.info({ type: 'recentTrades', coin: market.symbol }));

    // The venue also returns both counterparties on every trade. They are
    // dropped here rather than at the route, so no caller can accidentally
    // forward them.
    return raw
      .slice(0, limit)
      .map((trade) => ({
        price: trade.px,
        size: trade.sz,
        side: trade.side === 'B' ? ('BUY' as const) : ('SELL' as const),
        at: new Date(trade.time),
      }))
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  async getPositions(account: PerpAccountRef): Promise<PerpPosition[]> {
    const state = clearinghouseSchema.parse(
      await this.info({ type: 'clearinghouseState', user: account.address }),
    );

    return state.assetPositions
      .map(({ position }) => {
        const signed = new Decimal(position.szi);
        // A zero position is reported alongside real ones; it is not a position.
        if (signed.isZero()) return null;

        const side: PerpSide = signed.isPositive() ? 'LONG' : 'SHORT';

        return {
          symbol: position.coin,
          side,
          size: signed.abs().toFixed(),
          entryPrice: position.entryPx ?? '0',
          margin: position.marginUsed ?? '0',
          // Hyperliquid reports the mode on the leverage object; anything that
          // is not explicitly isolated shares the account balance.
          marginMode: position.leverage.type === 'isolated' ? 'ISOLATED' : 'CROSS',
          leverage: position.leverage.value,
          liquidationPrice: position.liquidationPx ?? null,
          unrealizedPnl: position.unrealizedPnl ?? null,
          fundingPaid: position.cumFunding?.sinceOpen ?? null,
        } satisfies PerpPosition;
      })
      .filter((position): position is PerpPosition => position !== null);
  }

  async getAccountSummary(account: PerpAccountRef): Promise<PerpAccountSummary> {
    const state = clearinghouseSchema.parse(
      await this.info({ type: 'clearinghouseState', user: account.address }),
    );

    const accountValue = state.marginSummary?.accountValue ?? '0';
    const marginUsed = state.marginSummary?.totalMarginUsed ?? '0';
    const positions = await this.getPositions(account);
    const pnl = positions.reduce(
      (total, position) => total.plus(position.unrealizedPnl ?? '0'),
      new Decimal(0),
    );

    return {
      accountValue,
      withdrawable: state.withdrawable ?? '0',
      totalMarginUsed: marginUsed,
      totalUnrealizedPnl: pnl.toFixed(),
      // Distinguishes "never bridged" from "bridged but flat" — the interface
      // has to send those two users to completely different places.
      hasCollateral: new Decimal(accountValue).greaterThan(0),
    };
  }

  async authorizationStatus(account: PerpAccountRef): Promise<VenueAuthorization> {
    const agents = agentSchema.parse(
      await this.info({ type: 'extraAgents', user: account.address }),
    );

    const now = Date.now();
    const live = agents.find((agent) => (agent.validUntil ?? 0) > now);

    return {
      required: true,
      granted: live !== undefined,
      description:
        'Authorises a key held only by this browser to place and cancel orders on your behalf. ' +
        'It cannot withdraw or transfer your funds, and you can revoke it at any time.',
      expiresAt: live?.validUntil ? new Date(live.validUntil) : null,
    };
  }

  async prepareAuthorization(): Promise<PreparedAction> {
    // The agent address is generated in the browser and filled in there; the
    // server never sees the key and therefore cannot name its address here.
    return {
      kind: 'typed-data',
      endpoint: `${this.baseUrl()}/exchange`,
      summary:
        'Allow this browser to place and cancel perpetual orders for you on Hyperliquid. ' +
        'This does not allow withdrawing or moving your funds.',
      typedData: {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: SIGNATURE_CHAIN_ID,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        types: {
          'HyperliquidTransaction:ApproveAgent': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'agentAddress', type: 'address' },
            { name: 'agentName', type: 'string' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        message: {
          hyperliquidChain: this.isTestnet() ? 'Testnet' : 'Mainnet',
          agentName: 'FLT-Exchange',
          nonce: Date.now(),
          // agentAddress is filled in by the client from the key it generates.
        },
      },
    };
  }

  async previewOrder(request: PrepareOrderRequest): Promise<OrderPreview> {
    const { intent } = request;
    const market = await this.requireMarket(intent.symbol);

    if (!market.markPrice) {
      throw new ProviderError(this.meta.slug, 'Venue did not report a mark price', {
        retryable: true,
        details: { symbol: market.symbol },
      });
    }

    const price = intent.limitPrice ?? market.markPrice;
    const orderNotional = notional(intent.size, price);

    const positions = await this.getPositions(request);
    const existing = positions.find((p) => p.symbol === market.symbol);

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
      // Hyperliquid does not quote a fee for an unplaced order, and the taker
      // rate depends on the account's volume tier. Left null rather than
      // guessed; the caller decides how to present an unknown.
      estimatedFee: null,
      integratorFee: integratorFee ? integratorFee.toFixed() : null,
      // The venue only reports a liquidation price for a position that exists.
      // Null here means the caller must estimate and label it as an estimate.
      liquidationPrice: null,
      reversesPosition:
        existing !== undefined &&
        existing.side !== intent.side &&
        new Decimal(intent.size).greaterThan(existing.size),
    };
  }

  async prepareOrder(request: PrepareOrderRequest): Promise<PreparedAction> {
    const { intent } = request;
    const market = await this.requireMarket(intent.symbol);

    if (market.isDelisted) {
      throw new ValidationError('This market has been delisted', { symbol: market.symbol });
    }
    if (!market.markPrice) {
      throw new ProviderError(this.meta.slug, 'Venue did not report a mark price', {
        retryable: true,
      });
    }

    const isBuy = intent.side === 'LONG';
    const orderType = intent.orderType ?? 'MARKET';
    const size = this.roundSize(intent.size, market);

    if (isTriggerOrder(orderType) && !intent.triggerPrice) {
      throw new ValidationError('A trigger price is required for this order type', {
        orderType,
      });
    }

    // The price the order is judged against. A trigger order is priced from its
    // own trigger, not the mark — pricing a stop off the current mark would
    // send a bound computed for a price the order will never execute at.
    const reference = isTriggerOrder(orderType)
      ? intent.triggerPrice!
      : (intent.limitPrice ?? market.markPrice);

    const restsAsLimit = orderType === 'LIMIT' || triggerRestsAsLimit(orderType);

    const entry: NormalizedVenueOrder = {
      assetId: market.venueAssetId,
      symbol: market.symbol,
      isBuy,
      size,
      // Both a resting limit and a market order's IOC bound reach the venue as
      // a price, and the venue rejects one that is off its tick — so the bound
      // is rounded here too, not only the limit.
      limitPrice: this.roundPrice(
        restsAsLimit ? reference : boundPrice(reference, isBuy, intent.slippageBps),
        market,
      ),
      // A market order goes out as immediate-or-cancel at a bounded price,
      // never as an unbounded market order.
      timeInForce: restsAsLimit ? 'GTC' : 'IOC',
      reduceOnly: intent.reduceOnly,
      trigger: isTriggerOrder(orderType)
        ? {
            triggerPrice: this.roundPrice(intent.triggerPrice!, market),
            // A stop protects against the position moving against you; a
            // take-profit fires in your favour. The venue matches them against
            // different sides of the mark.
            kind: orderType.startsWith('STOP') ? 'sl' : 'tp',
            isMarket: !triggerRestsAsLimit(orderType),
          }
        : null,
      ...this.builderFee(request.fee),
    };

    // Bracket legs close the position, so they are the opposite side of the
    // entry and always reduce-only — a rounding error must never be able to
    // open a position on the other side.
    const attached: NormalizedVenueOrder[] = [];

    if (intent.takeProfitPrice) {
      attached.push(this.protectiveLeg(market, intent, size, !isBuy, intent.takeProfitPrice, 'tp'));
    }
    if (intent.stopLossPrice) {
      attached.push(this.protectiveLeg(market, intent, size, !isBuy, intent.stopLossPrice, 'sl'));
    }

    return {
      kind: 'venue-order',
      endpoint: `${this.baseUrl()}/exchange`,
      requiresAgentKey: true,
      order: entry,
      ...(attached.length > 0
        ? {
            attached,
            // normalTpsl makes the pair an OCO: filling one cancels the other.
            // Without it both legs rest and a whipsaw could execute both,
            // leaving a position opposite the one that was closed.
            grouping: 'normalTpsl' as const,
          }
        : {}),
    };
  }

  /**
   * One leg of a bracket.
   *
   * Never carries a builder fee: the fee is charged once, on the entry. Taking
   * it again on the exit would double-charge a round trip that the participant
   * was quoted once.
   */
  private protectiveLeg(
    market: PerpMarket,
    intent: PerpOrderIntent,
    size: string,
    isBuy: boolean,
    triggerPrice: string,
    kind: 'tp' | 'sl',
  ): NormalizedVenueOrder {
    return {
      assetId: market.venueAssetId,
      symbol: market.symbol,
      isBuy,
      size,
      // Market on trigger: a protective stop that rests as a limit can be
      // skipped straight past in a fast move, which is the one case it exists
      // for. Bounded by slippage rather than unbounded.
      limitPrice: this.roundPrice(boundPrice(triggerPrice, isBuy, Math.max(intent.slippageBps, 100)), market),
      timeInForce: 'IOC',
      reduceOnly: true,
      trigger: {
        triggerPrice: this.roundPrice(triggerPrice, market),
        kind,
        isMarket: true,
      },
      builderFeeTenthsBps: null,
      builderAddress: null,
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
    if (!market.markPrice) {
      throw new ProviderError(this.meta.slug, 'Venue did not report a mark price', {
        retryable: true,
      });
    }

    // Closing a long is a sell. Reduce-only guarantees a rounding error cannot
    // turn a full close into a small position on the opposite side.
    const isBuy = position.side === 'SHORT';

    return {
      kind: 'venue-order',
      endpoint: `${this.baseUrl()}/exchange`,
      requiresAgentKey: true,
      order: {
        assetId: market.venueAssetId,
        symbol: market.symbol,
        isBuy,
        size: this.roundSize(size, market),
        limitPrice: this.roundPrice(boundPrice(market.markPrice, isBuy, request.slippageBps), market),
        timeInForce: 'IOC',
        reduceOnly: true,
        trigger: null,
        ...this.builderFee(request.fee),
      },
    };
  }

  async prepareLeverageChange(request: PrepareLeverageRequest): Promise<PreparedAction> {
    const market = await this.requireMarket(request.symbol);
    if (request.leverage > market.maxLeverage) {
      throw new ValidationError(`This market allows at most ${market.maxLeverage}x`, {
        requested: request.leverage,
        max: market.maxLeverage,
      });
    }

    return {
      kind: 'venue-order',
      endpoint: `${this.baseUrl()}/exchange`,
      requiresAgentKey: true,
      order: {
        assetId: market.venueAssetId,
        symbol: market.symbol,
        isBuy: true,
        // A leverage change is not a trade; size zero marks it as a settings
        // action for the client to route to updateLeverage.
        size: '0',
        limitPrice: market.markPrice ?? '0',
        timeInForce: 'GTC',
        reduceOnly: false,
        trigger: null,
        builderFeeTenthsBps: null,
        builderAddress: null,
      },
    };
  }

  /**
   * The orders the account is resting.
   *
   * Read, not signed: `/info` needs no key. The maker uses this to decide what
   * to cancel before it re-quotes, so it must reflect the venue, not our memory
   * of what we sent.
   */
  async getOpenOrders(account: PerpAccountRef): Promise<OpenOrder[]> {
    const raw = z
      .array(openOrderSchema)
      .parse(await this.info({ type: 'openOrders', user: account.address }));

    return raw.map((order) => ({
      symbol: order.coin,
      oid: order.oid,
      cloid: order.cloid ?? null,
      isBuy: order.side === 'B',
      price: order.limitPx,
      size: order.sz,
    }));
  }

  /**
   * The account's recent fills.
   *
   * Read and then filtered here: the venue returns a fixed recent window, and
   * the caller (the worker) dedups on `venueTid` anyway, so this is a source of
   * truth rather than an incrementing feed.
   */
  async getFills(account: PerpAccountRef, since?: Date): Promise<VenueFill[]> {
    const raw = z
      .array(userFillSchema)
      .parse(await this.info({ type: 'userFills', user: account.address }));

    const sinceMs = since ? since.getTime() : 0;
    return raw
      .filter((fill) => fill.time >= sinceMs)
      .map((fill) => ({
        venueTid: String(fill.tid),
        venueOid: fill.oid ?? null,
        symbol: fill.coin,
        isBuy: fill.side === 'B',
        price: fill.px,
        size: fill.sz,
        feeUsd: fill.fee,
        closedPnlUsd: fill.closedPnl,
        filledAt: new Date(fill.time),
        venueHash: fill.hash ?? null,
      }));
  }

  /**
   * Prepares one post-only quote.
   *
   * The price and size are the maker's own decision (computed in core from the
   * ladder); this only clamps them to what the venue will accept, so a
   * mis-rounded quote is corrected here rather than rejected there.
   */
  async prepareMakerQuote(request: MakerQuoteRequest): Promise<MakerAction> {
    const market = await this.requireMarket(request.symbol);
    return {
      kind: 'maker-quotes',
      endpoint: `${this.baseUrl()}/exchange`,
      quotes: [
        {
          assetId: market.venueAssetId,
          symbol: market.symbol,
          isBuy: request.isBuy,
          price: this.roundPrice(request.price, market),
          size: this.roundSize(request.size, market),
          cloid: assertCloid(request.cloid),
        },
      ],
    };
  }

  /** Prepares cancels for the orders the maker is pulling before it re-quotes. */
  async prepareMakerCancel(request: MakerCancelRequest): Promise<MakerAction> {
    const cancels: MakerCancel[] = [];
    for (const cancel of request.cancels) {
      const market = await this.requireMarket(cancel.symbol);
      if (cancel.oid == null && !cancel.cloid) {
        throw new ValidationError('A cancel needs an order id or a client order id', {
          symbol: cancel.symbol,
        });
      }
      cancels.push({
        assetId: market.venueAssetId,
        oid: cancel.oid ?? null,
        cloid: cancel.cloid ? assertCloid(cancel.cloid) : null,
      });
    }
    return { kind: 'maker-cancel', endpoint: `${this.baseUrl()}/exchange`, cancels };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const markets = await this.listMarkets();
      return markets.length > 0
        ? { ok: true, detail: `${markets.length} markets` }
        : { ok: false, detail: 'Venue returned no markets' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private builderFee(fee?: { bps: number; recipientAddress: string }) {
    if (!fee || fee.bps === 0) {
      return { builderFeeTenthsBps: null, builderAddress: null };
    }
    if (fee.bps > MAX_BUILDER_FEE_BPS) {
      throw new ValidationError(
        `Hyperliquid caps builder fees on perpetuals at ${MAX_BUILDER_FEE_BPS} bps`,
        { requested: fee.bps },
      );
    }
    return {
      // The venue expresses builder fees in tenths of a basis point.
      builderFeeTenthsBps: Math.round(fee.bps * 10),
      builderAddress: fee.recipientAddress,
    };
  }

  /**
   * Hyperliquid accepts at most five significant figures on a price, and
   * (6 - sizeDecimals) decimal places. A price outside that is rejected
   * outright, so it is clamped here rather than at the venue.
   */
  private roundPrice(price: string, market: PerpMarket): string {
    const maxDecimals = Math.max(0, 6 - market.sizeDecimals);
    return new Decimal(price)
      .toSignificantDigits(5, Decimal.ROUND_HALF_UP)
      .toDecimalPlaces(maxDecimals, Decimal.ROUND_HALF_UP)
      .toFixed();
  }

  private roundSize(size: string, market: PerpMarket): string {
    const rounded = new Decimal(size).toDecimalPlaces(market.sizeDecimals, Decimal.ROUND_DOWN);
    if (rounded.lessThan(market.minSize)) {
      throw new ValidationError(
        `Size is below the minimum of ${market.minSize} on this market`,
        { size, minSize: market.minSize },
      );
    }
    return rounded.toFixed();
  }

  private async requireMarket(symbol: string): Promise<PerpMarket> {
    const market = await this.getMarket(symbol);
    if (!market) {
      throw new ValidationError('Unknown market', { symbol });
    }
    return market;
  }

  private baseUrl(): string {
    const configured = env().HYPERLIQUID_API_URL;
    if (!configured) {
      throw new ProviderNotConfiguredError(this.meta.slug, 'HYPERLIQUID_API_URL is not set');
    }
    return configured.replace(/\/$/, '');
  }

  private isTestnet(): boolean {
    return this.baseUrl().includes('testnet');
  }

  private async info(body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ProviderError(this.meta.slug, 'Venue did not respond', {
        retryable: true,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    if (response.status === 429) {
      throw new ProviderError(this.meta.slug, 'Venue is rate limiting us', { retryable: true });
    }
    if (!response.ok) {
      throw new ProviderError(this.meta.slug, 'Venue rejected the request', {
        retryable: response.status >= 500,
        details: { status: response.status },
      });
    }

    return response.json();
  }
}
