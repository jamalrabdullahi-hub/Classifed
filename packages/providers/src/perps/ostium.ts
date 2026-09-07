import { encodeFunctionData, getAddress, erc20Abi, type Address } from 'viem';
import { env } from '@flt/config';
import { ProviderError, ValidationError } from '@flt/core/domain';
import { Decimal, initialMargin, notional } from '@flt/core/domain';
import { z } from 'zod';
import { boundPrice } from './mock';
import type {
  Candle,
  OrderBook,
  OrderPreview,
  PerpAccountRef,
  PerpAccountSummary,
  PerpAssetClass,
  PerpMarket,
  PerpPosition,
  PerpTrade,
  PerpVenue,
  PrepareCloseRequest,
  PrepareLeverageRequest,
  PrepareOrderRequest,
  PreparedAction,
  ProviderMeta,
  VenueAuthorization,
} from './types';

/**
 * Ostium — perpetuals on real-world assets.
 *
 * ## Why a second venue rather than more markets on the first
 *
 * Hyperliquid lists 177 markets and every one is crypto. Ostium lists equities,
 * indices, FX and commodities as perpetuals settled in USDC. A perp is a
 * synthetic — nothing about the contract requires the underlying to be a token
 * — and this is the venue that acts on that.
 *
 * ## Two sources, because the venue has two
 *
 * The subgraph is authoritative for *what exists*: pair ids, groups, leverage
 * ceilings, open interest. The metadata backend is authoritative for *what it
 * costs right now*: bid, mid, ask, and whether the session is open. Neither can
 * answer the other's question, so both are read and joined on the from/to pair.
 *
 * ## The session is not decoration
 *
 * A crypto book never closes. An equity does, and a position held across the
 * close reopens into a gap. `isMarketOpen` is carried on every market, and this
 * adapter refuses to prepare an order into a closed session: the contract would
 * revert anyway, and it is far better to say why before the user signs than
 * after they have paid gas to find out.
 *
 * ## Orders are transactions, not signed venue messages
 *
 * Hyperliquid takes an EIP-712 action signed by a browser-held agent key.
 * Ostium takes an Arbitrum transaction against its Trading contract, signed by
 * the user's own wallet. `PreparedAction` is a union precisely so both fit
 * without either pretending to be the other, and FLT still signs nothing.
 */

/** Prices are 1e18 on-chain, leverage 1e2, collateral USDC's own 1e6. */
const PRICE_PRECISION = new Decimal(10).pow(18);
const LEVERAGE_PRECISION = new Decimal(100);
const COLLATERAL_PRECISION = new Decimal(10).pow(6);

const ARBITRUM_ONE = 42161;

/**
 * The venue's own grouping, mapped to ours.
 *
 * Taken from the venue rather than inferred from the ticker, and the reason is
 * concrete: Ostium's `SPX` is the S&P 500 while Hyperliquid's `SPX` is a
 * memecoin called SPX6900. A classifier reading the symbol would get one of
 * them wrong, and would get the more dangerous one wrong.
 */
const GROUP_TO_ASSET_CLASS: Record<string, PerpAssetClass> = {
  crypto: 'CRYPTO',
  stocks: 'EQUITY',
  indices: 'FUTURE',
  forex: 'FOREX',
  commodities: 'COMMODITY',
  // An ETF is a basket of equities and behaves like one: same sessions, same
  // gap risk, same holidays.
  etf: 'EQUITY',
};

/**
 * Only the two functions this adapter calls.
 *
 * Transcribed from the venue's published ABI. A trimmed ABI is deliberate: an
 * adapter that carries the whole surface invites a later caller to reach for a
 * function nobody reviewed.
 */
const TRADING_ABI = [
  {
    name: 'openTrade',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 't',
        type: 'tuple',
        components: [
          { name: 'collateral', type: 'uint256' },
          { name: 'openPrice', type: 'uint192' },
          { name: 'tp', type: 'uint192' },
          { name: 'sl', type: 'uint192' },
          { name: 'trader', type: 'address' },
          { name: 'leverage', type: 'uint32' },
          { name: 'pairIndex', type: 'uint16' },
          { name: 'index', type: 'uint8' },
          { name: 'buy', type: 'bool' },
          { name: 'isDayTrade', type: 'bool' },
        ],
      },
      {
        name: 'bf',
        type: 'tuple',
        components: [
          { name: 'builder', type: 'address' },
          { name: 'builderFee', type: 'uint32' },
        ],
      },
      { name: 'orderType', type: 'uint8' },
      { name: 'slippageP', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'closeTradeMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pairIndex', type: 'uint16' },
      { name: 'index', type: 'uint8' },
      { name: 'closePercentage', type: 'uint16' },
      { name: 'marketPrice', type: 'uint192' },
      { name: 'slippageP', type: 'uint32' },
    ],
    outputs: [],
  },
] as const;

/** The venue's OpenOrderType enum. */
const ORDER_TYPE = { MARKET: 0, LIMIT: 1, STOP: 2 } as const;

const pairSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  isActive: z.boolean().nullable().optional(),
  maxLeverage: z.string().nullable().optional(),
  longOI: z.string().nullable().optional(),
  shortOI: z.string().nullable().optional(),
  lastTradePrice: z.string().nullable().optional(),
  group: z.object({
    id: z.string(),
    name: z.string(),
    maxLeverage: z.string().nullable().optional(),
  }),
});

const priceSchema = z.object({
  from: z.string(),
  to: z.string(),
  bid: z.number().nullable().optional(),
  mid: z.number().nullable().optional(),
  ask: z.number().nullable().optional(),
  isMarketOpen: z.boolean().nullable().optional(),
  isDayTradingClosed: z.boolean().nullable().optional(),
  secondsToToggleIsDayTradingClosed: z.number().nullable().optional(),
});

const tradeSchema = z.object({
  index: z.string(),
  isBuy: z.boolean(),
  collateral: z.string(),
  leverage: z.string(),
  openPrice: z.string(),
  liquidationPrice: z.string().nullable().optional(),
  funding: z.string().nullable().optional(),
  rollover: z.string().nullable().optional(),
  pair: z.object({ id: z.string(), from: z.string(), to: z.string() }),
});

type OstiumPair = z.infer<typeof pairSchema>;
type OstiumPrice = z.infer<typeof priceSchema>;
type OstiumTrade = z.infer<typeof tradeSchema>;

export class OstiumVenue implements PerpVenue {
  readonly meta: ProviderMeta = {
    slug: 'ostium',
    name: 'Ostium',
    isMock: false,
  };

  readonly settlementChainId = ARBITRUM_ONE;

  /**
   * Collateral is USDC on Arbitrum while the rest of FLT settles on Base, so
   * the user must bridge. The port carries this flag so the interface cannot
   * quietly skip saying so.
   */
  readonly requiresBridgedCollateral = true;

  /** Markets change rarely; prices change constantly. Cached separately. */
  private pairsCache: { at: number; pairs: OstiumPair[] } | null = null;
  private pricesCache: { at: number; prices: Map<string, OstiumPrice> } | null = null;

  // ── Reads ─────────────────────────────────────────────────────────────────

  async listMarkets(): Promise<PerpMarket[]> {
    const [pairs, prices] = await Promise.all([this.pairs(), this.prices()]);
    return pairs.map((pair) => this.toMarket(pair, prices.get(key(pair.from, pair.to))));
  }

  async getMarket(symbol: string): Promise<PerpMarket | null> {
    const markets = await this.listMarkets();
    return markets.find((market) => market.symbol === symbol.toUpperCase()) ?? null;
  }

  /**
   * Ostium has no resting order book.
   *
   * It fills against an oracle price with a spread and a price-impact curve, so
   * there are no levels to show. Empty sides are the honest answer; synthesising
   * a ladder from the spread would draw depth nobody is quoting.
   */
  async getOrderBook(symbol: string): Promise<OrderBook> {
    const market = await this.requireMarket(symbol);
    return { symbol: market.symbol, bids: [], asks: [], capturedAt: new Date() };
  }

  /**
   * Ostium publishes no candle history.
   *
   * Empty rather than fabricated: a chart assembled from repeated samples of the
   * current price would look like history and be nothing of the kind. The
   * caller renders "no chart available", which is true.
   */
  async getCandles(): Promise<Candle[]> {
    return [];
  }

  async getRecentTrades(): Promise<PerpTrade[]> {
    return [];
  }

  async getPositions(account: PerpAccountRef): Promise<PerpPosition[]> {
    const trades = await this.openTrades(account.address);
    return trades.map((trade) => this.toPosition(trade));
  }

  async getAccountSummary(account: PerpAccountRef): Promise<PerpAccountSummary> {
    const positions = await this.getPositions(account);
    const margin = positions.reduce((sum, position) => sum.plus(position.margin), new Decimal(0));

    return {
      /**
       * Ostium holds no account balance: collateral is posted per trade and the
       * wallet keeps the rest. So account value is what is demonstrably locked
       * in positions — reporting a wallet balance the venue does not hold would
       * claim custody that does not exist.
       */
      accountValue: margin.toFixed(),
      withdrawable: '0',
      totalMarginUsed: margin.toFixed(),
      // The subgraph carries no marked PnL and computing one here would put an
      // estimate where the venue's own number belongs.
      totalUnrealizedPnl: '0',
      hasCollateral: positions.length > 0,
    };
  }

  /**
   * Nothing to authorise ahead of time.
   *
   * Every Ostium action is a transaction the user's wallet signs, so unlike
   * Hyperliquid there is no agent key to grant. The only prerequisite is the
   * USDC allowance, which `prepareOrder` surfaces with the order itself.
   */
  async authorizationStatus(): Promise<VenueAuthorization> {
    return {
      required: false,
      granted: true,
      description:
        'Ostium needs no separate authorisation: every order is a transaction your own wallet ' +
        'signs against the Trading contract.',
      expiresAt: null,
    };
  }

  async prepareAuthorization(): Promise<PreparedAction> {
    throw new ValidationError('Ostium does not need a separate authorisation step');
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async previewOrder(request: PrepareOrderRequest): Promise<OrderPreview> {
    const market = await this.requireMarket(request.intent.symbol);
    this.assertTradeable(market);

    const price = request.intent.limitPrice ?? market.markPrice;
    if (!price) {
      throw new ProviderError(this.meta.slug, 'Venue is not quoting this market', {
        retryable: true,
      });
    }

    const positionNotional = notional(request.intent.size, price);
    const positions = await this.getPositions({ address: request.address });
    const existing = positions.find((position) => position.symbol === market.symbol);

    return {
      symbol: market.symbol,
      side: request.intent.side,
      size: request.intent.size,
      estimatedPrice: price,
      notional: positionNotional,
      marginRequired: initialMargin(request.intent.size, price, request.intent.leverage),
      // Ostium takes its fee from collateral at open and does not quote it in
      // advance through any endpoint this adapter can read. Null rather than a
      // guess.
      estimatedFee: null,
      integratorFee: request.fee ? this.builderFeeUsd(positionNotional, request.fee.bps) : null,
      liquidationPrice: null,
      reversesPosition: existing !== undefined && existing.side !== request.intent.side,
    };
  }

  async prepareOrder(request: PrepareOrderRequest): Promise<PreparedAction> {
    const { intent } = request;
    const market = await this.requireMarket(intent.symbol);
    this.assertTradeable(market);

    if (!market.markPrice) {
      throw new ProviderError(this.meta.slug, 'Venue did not report a price', { retryable: true });
    }

    const isBuy = intent.side === 'LONG';
    const orderType = intent.orderType ?? 'MARKET';

    if (orderType !== 'MARKET' && orderType !== 'LIMIT' && !intent.triggerPrice) {
      throw new ValidationError('A trigger price is required for this order type', { orderType });
    }

    // A trigger order is priced from its own trigger; a limit from its limit;
    // a market from the mark. Pricing a stop off the mark would send a bound
    // computed for a price the order will never execute at.
    const reference =
      orderType === 'MARKET'
        ? market.markPrice
        : (intent.triggerPrice ?? intent.limitPrice ?? market.markPrice);

    const positionNotional = new Decimal(notional(intent.size, reference));
    const collateral = positionNotional.dividedBy(intent.leverage);

    const trade = {
      collateral: BigInt(
        collateral.times(COLLATERAL_PRECISION).toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(),
      ),
      openPrice: toPriceUnits(
        orderType === 'MARKET' ? boundPrice(reference, isBuy, intent.slippageBps) : reference,
      ),
      tp: intent.takeProfitPrice ? toPriceUnits(intent.takeProfitPrice) : 0n,
      sl: intent.stopLossPrice ? toPriceUnits(intent.stopLossPrice) : 0n,
      trader: getAddress(request.address),
      leverage: Number(new Decimal(intent.leverage).times(LEVERAGE_PRECISION).toFixed(0)),
      pairIndex: market.venueAssetId,
      // The venue assigns the slot; zero on an opening trade.
      index: 0,
      buy: isBuy,
      /**
       * Day trades are charged differently from positions held overnight, and
       * the venue caps overnight leverage lower. Declaring false is the
       * conservative choice: it is the setting that assumes the position may be
       * held, so nothing is charged as intraday that then rolls.
       */
      isDayTrade: false,
    };

    const builder = request.fee?.recipientAddress
      ? {
          builder: getAddress(request.fee.recipientAddress),
          // The venue takes the builder fee at 1e2, matching leverage.
          builderFee: Math.round(request.fee.bps),
        }
      : { builder: '0x0000000000000000000000000000000000000000' as Address, builderFee: 0 };

    const data = encodeFunctionData({
      abi: TRADING_ABI,
      functionName: 'openTrade',
      args: [
        trade,
        builder,
        orderType === 'LIMIT'
          ? ORDER_TYPE.LIMIT
          : orderType === 'MARKET'
            ? ORDER_TYPE.MARKET
            : ORDER_TYPE.STOP,
        BigInt(intent.slippageBps) * 100n,
      ],
    });

    return {
      kind: 'evm-transaction',
      chainId: ARBITRUM_ONE,
      transaction: {
        to: this.tradingAddress(),
        data,
        value: '0',
        gas: null,
      },
    };
  }

  async prepareClose(request: PrepareCloseRequest): Promise<PreparedAction> {
    const market = await this.requireMarket(request.symbol);
    this.assertTradeable(market);

    const trades = await this.openTrades(request.address);
    const trade = trades.find(
      (candidate) => symbolFor(candidate.pair.from, candidate.pair.to) === market.symbol,
    );

    if (!trade) {
      throw new ValidationError('No open position on this market', { symbol: request.symbol });
    }
    if (!market.markPrice) {
      throw new ProviderError(this.meta.slug, 'Venue did not report a price', { retryable: true });
    }

    const position = this.toPosition(trade);

    /**
     * Closed as a percentage, which is how the contract expresses it.
     *
     * Deriving a percentage from a requested size and rounding it down leaves a
     * dust position behind; a full close must therefore be exactly 100% rather
     * than a computed 99.9997%.
     */
    const percentage = request.size
      ? Decimal.min(
          new Decimal(request.size).dividedBy(position.size).times(10_000),
          new Decimal(10_000),
        )
          .toDecimalPlaces(0, Decimal.ROUND_DOWN)
          .toNumber()
      : 10_000;

    if (percentage <= 0) {
      throw new ValidationError('That size rounds to nothing on this position', {
        size: request.size,
      });
    }

    // Closing a long sells into the bid, so the bound moves the other way.
    const bounded = boundPrice(market.markPrice, position.side === 'SHORT', request.slippageBps);

    const data = encodeFunctionData({
      abi: TRADING_ABI,
      functionName: 'closeTradeMarket',
      args: [
        market.venueAssetId,
        Number(trade.index),
        percentage,
        toPriceUnits(bounded),
        request.slippageBps * 100,
      ],
    });

    return {
      kind: 'evm-transaction',
      chainId: ARBITRUM_ONE,
      transaction: { to: this.tradingAddress(), data, value: '0', gas: null },
    };
  }

  async prepareLeverageChange(_request: PrepareLeverageRequest): Promise<PreparedAction> {
    throw new ValidationError(
      'Ostium sets leverage per trade rather than per market, so there is nothing to change ' +
        'between orders.',
    );
  }

  /**
   * The USDC approval an order needs before it can be signed.
   *
   * Not part of the port — the spot path has its own approval flow and perps
   * have not needed one until now — so it is exposed for the order service to
   * call rather than folded silently into `prepareOrder`. An approval is its
   * own transaction and its own decision.
   */
  prepareCollateralApproval(amountUsd: string): PreparedAction {
    const amount = BigInt(
      new Decimal(amountUsd)
        .times(COLLATERAL_PRECISION)
        .toDecimalPlaces(0, Decimal.ROUND_UP)
        .toFixed(),
    );

    return {
      kind: 'evm-transaction',
      chainId: ARBITRUM_ONE,
      transaction: {
        to: getAddress(env().OSTIUM_USDC_ADDRESS),
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [getAddress(this.tradingAddress()), amount],
        }),
        value: '0',
        gas: null,
      },
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const [pairs, prices] = await Promise.all([this.pairs(), this.prices()]);
      const open = [...prices.values()].filter((price) => price.isMarketOpen).length;
      return { ok: pairs.length > 0, detail: `${pairs.length} pairs, ${open} sessions open` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private tradingAddress(): string {
    return getAddress(env().OSTIUM_TRADING_ADDRESS);
  }

  private builderFeeUsd(positionNotional: string, bps: number): string {
    return new Decimal(positionNotional).times(bps).dividedBy(10_000).toFixed();
  }

  private assertTradeable(market: PerpMarket): void {
    if (market.isDelisted) {
      throw new ValidationError('This market has been delisted', { symbol: market.symbol });
    }

    if (market.isMarketOpen === false) {
      const reopens =
        market.secondsToSessionChange && market.secondsToSessionChange > 0
          ? ` It reopens in about ${formatDuration(market.secondsToSessionChange)}.`
          : '';
      throw new ValidationError(
        `The ${market.symbol} market is closed, so an order cannot be placed right now.${reopens}`,
        { symbol: market.symbol, assetClass: market.assetClass },
      );
    }
  }

  private async requireMarket(symbol: string): Promise<PerpMarket> {
    const market = await this.getMarket(symbol);
    if (!market) throw new ValidationError('Unknown market on this venue', { symbol });
    return market;
  }

  private toPosition(trade: OstiumTrade): PerpPosition {
    const collateral = new Decimal(trade.collateral).dividedBy(COLLATERAL_PRECISION);
    const leverage = new Decimal(trade.leverage).dividedBy(LEVERAGE_PRECISION);
    const openPrice = new Decimal(trade.openPrice).dividedBy(PRICE_PRECISION);

    // Ostium sizes by collateral and leverage; size in units of the underlying
    // is what the rest of FLT speaks, so it is derived once here.
    const size = openPrice.isZero()
      ? new Decimal(0)
      : collateral.times(leverage).dividedBy(openPrice);

    const carry = new Decimal(trade.funding ?? '0')
      .plus(trade.rollover ?? '0')
      .dividedBy(COLLATERAL_PRECISION);

    return {
      symbol: symbolFor(trade.pair.from, trade.pair.to),
      side: trade.isBuy ? 'LONG' : 'SHORT',
      size: size.toFixed(),
      entryPrice: openPrice.toFixed(),
      margin: collateral.toFixed(),
      // Every Ostium position carries its own collateral; there is no shared
      // balance to cross against.
      marginMode: 'ISOLATED',
      leverage: Math.max(1, Math.round(leverage.toNumber())),
      liquidationPrice: trade.liquidationPrice
        ? new Decimal(trade.liquidationPrice).dividedBy(PRICE_PRECISION).toFixed()
        : null,
      unrealizedPnl: null,
      fundingPaid: carry.toFixed(),
    };
  }

  private toMarket(pair: OstiumPair, price: OstiumPrice | undefined): PerpMarket {
    const groupName = pair.group.name.toLowerCase();
    /**
     * An unmapped group means the venue added a class we have not seen. It is
     * not crypto merely because that default would be convenient — it is
     * reported as FUTURE, the closest thing to "a synthetic we cannot classify",
     * so a new class shows up as unfamiliar rather than as a crypto market.
     */
    const assetClass = GROUP_TO_ASSET_CLASS[groupName] ?? 'FUTURE';

    // Pair-level leverage of zero means "inherit the group's ceiling".
    const pairMax = new Decimal(pair.maxLeverage ?? '0');
    const groupMax = new Decimal(pair.group.maxLeverage ?? '0');
    const raw = pairMax.greaterThan(0) ? pairMax : groupMax;
    const maxLeverage = Math.max(1, Math.floor(raw.dividedBy(LEVERAGE_PRECISION).toNumber()));

    const mid = price?.mid ?? null;
    const last = pair.lastTradePrice
      ? new Decimal(pair.lastTradePrice).dividedBy(PRICE_PRECISION).toFixed()
      : null;
    // The live mid wins; the last on-chain trade is the fallback, and on a
    // closed market it is the only thing there is.
    const quoted = mid !== null ? String(mid) : last;

    return {
      symbol: symbolFor(pair.from, pair.to),
      name: symbolFor(pair.from, pair.to),
      venueAssetId: Number(pair.id),
      maxLeverage,
      // Ostium sizes a position by collateral and leverage rather than by a
      // contract count, so there is no venue-imposed size step. Six places is
      // the collateral's own precision.
      sizeDecimals: 6,
      minSize: '0.000001',
      indexPrice: quoted,
      markPrice: quoted,
      // Ostium charges rollover rather than a periodic funding rate, and it is
      // not expressed as a per-interval rate this field could carry honestly.
      fundingRate: null,
      fundingIntervalHours: 1,
      openInterest: new Decimal(pair.longOI ?? '0')
        .plus(pair.shortOI ?? '0')
        .dividedBy(PRICE_PRECISION)
        .toFixed(),
      isDelisted: pair.isActive === false,
      assetClass,
      isMarketOpen: price?.isMarketOpen ?? null,
      secondsToSessionChange:
        typeof price?.secondsToToggleIsDayTradingClosed === 'number' &&
        price.secondsToToggleIsDayTradingClosed >= 0
          ? price.secondsToToggleIsDayTradingClosed
          : null,
    };
  }

  private async openTrades(address: string): Promise<OstiumTrade[]> {
    const query = `
      query Positions($trader: String!) {
        trades(where: { trader: $trader, isOpen: true }, first: 200) {
          index isBuy collateral leverage openPrice liquidationPrice funding rollover
          pair { id from to }
        }
      }
    `;

    const data = await this.graph<{ trades: unknown[] }>(query, {
      trader: address.toLowerCase(),
    });

    return data.trades.flatMap((raw) => {
      const parsed = tradeSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  }

  private async pairs(): Promise<OstiumPair[]> {
    if (this.pairsCache && Date.now() - this.pairsCache.at < 60_000) {
      return this.pairsCache.pairs;
    }

    const query = `
      {
        pairs(first: 500, where: { isActive: true }) {
          id from to isActive maxLeverage longOI shortOI lastTradePrice
          group { id name maxLeverage }
        }
      }
    `;

    const data = await this.graph<{ pairs: unknown[] }>(query, {});
    const pairs = data.pairs.flatMap((raw) => {
      const parsed = pairSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });

    this.pairsCache = { at: Date.now(), pairs };
    return pairs;
  }

  private async prices(): Promise<Map<string, OstiumPrice>> {
    if (this.pricesCache && Date.now() - this.pricesCache.at < 5_000) {
      return this.pricesCache.prices;
    }

    const base = env().OSTIUM_METADATA_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/PricePublish/latest-prices`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new ProviderError(this.meta.slug, `Price feed returned ${response.status}`, {
        retryable: response.status >= 500,
      });
    }

    const raw: unknown = await response.json();
    const prices = new Map<string, OstiumPrice>();

    for (const entry of Array.isArray(raw) ? raw : []) {
      const parsed = priceSchema.safeParse(entry);
      if (parsed.success) prices.set(key(parsed.data.from, parsed.data.to), parsed.data);
    }

    this.pricesCache = { at: Date.now(), prices };
    return prices;
  }

  private async graph<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(env().OSTIUM_SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new ProviderError(this.meta.slug, `Subgraph returned ${response.status}`, {
        retryable: response.status >= 500,
      });
    }

    const payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (payload.errors?.length) {
      throw new ProviderError(this.meta.slug, `Subgraph error: ${payload.errors[0]!.message}`, {
        retryable: false,
      });
    }
    if (!payload.data) {
      throw new ProviderError(this.meta.slug, 'Subgraph returned no data', { retryable: true });
    }

    return payload.data;
  }
}

/**
 * The symbol as a trader would write it.
 *
 * A USD quote is dropped — "AAPL" reads better than "AAPL/USD" and matches the
 * venue's own naming. Anything else keeps the pair, because EUR/GBP and EUR/USD
 * are different instruments and "EUR" alone would not say which.
 */
function symbolFor(from: string, to: string): string {
  const base = from.toUpperCase();
  const quote = to.toUpperCase();
  return quote === 'USD' ? base : `${base}/${quote}`;
}

function key(from: string, to: string): string {
  return `${from.toUpperCase()}/${to.toUpperCase()}`;
}

function toPriceUnits(price: string): bigint {
  return BigInt(
    new Decimal(price).times(PRICE_PRECISION).toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(),
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5_400) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}
