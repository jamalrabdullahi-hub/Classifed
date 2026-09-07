import {
  PerpOrderKind,
  PerpOrderStatus,
  type PerpMarket as PerpMarketRow,
  type PerpOrder,
  type User,
  type Wallet,
  prisma,
} from '@flt/db';
import { env } from '@flt/config';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  WalletNotVerifiedError,
} from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { checksumAddress } from '../domain/address';
import {
  assertLeverage,
  isTriggerOrder,
  estimateLiquidationPrice,
  initialMargin,
  notional,
  type PerpMarket,
  type PerpOrderIntent,
  type PerpSide,
} from '../domain/perps';
import { assertMayTrade } from './kyc';
import { protectionRequired, quoteProtection } from './protection-quote';
import { AuditAction, audit } from './audit';
import type {
  OrderPreview,
  PerpIntegratorFee,
  PerpVenue,
  PreparedAction,
} from '../ports/perps';

/**
 * Perpetual order preparation.
 *
 * This service is where FLT's own policy is applied on top of whatever the
 * venue happens to permit, and it is deliberately the only place that happens.
 * The adapter reports what the venue allows; the decisions about what *we*
 * offer — which markets, how much leverage, what fee, and to whom — are made
 * here, once, and recorded.
 *
 * ## The order is persisted before the client is given anything
 *
 * On the spot path, tamper protection comes from hashing the calldata and
 * comparing it against the transaction that actually landed. There is no
 * calldata for a venue order, so the equivalent guarantee is built the other
 * way round: every economically meaningful field is written to the database
 * before the client receives a signable action, and the worker later compares
 * that record against the fill the venue reports. A user can therefore always
 * be shown what FLT specified on their behalf, and a divergence is an audit
 * event rather than a silent correction.
 *
 * ## Leverage is capped twice
 *
 * Once by the venue, and once by us, and the lower always wins. A venue
 * listing a market at 40x is not a decision to offer 40x to a retail user;
 * `PERP_MAX_LEVERAGE` is where that decision is actually made.
 */

export interface PerpOrderContext {
  user: User;
  wallet: Wallet;
  intent: PerpOrderIntent;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface PreparedOrderResult {
  order: PerpOrder;
  action: PreparedAction;
  preview: OrderPreview;
  /** The liquidation estimate shown to the user, and whether the venue supplied it. */
  liquidation: { price: string | null; source: 'venue' | 'estimated' };
  warnings: PerpWarning[];
}

export interface PerpWarning {
  code: string;
  message: string;
}

/**
 * Refuses everything unless perpetuals are switched on for this deployment.
 *
 * Called at the top of every entry point rather than relied upon at the route
 * layer, so a new route cannot accidentally expose leveraged trading by
 * forgetting a check.
 */
export function assertPerpsEnabled(): void {
  if (!env().PERPS_ENABLED) {
    throw new ForbiddenError('Perpetual futures are not available on this deployment');
  }
}

/** The leverage FLT will actually allow on a market: the lower of the two caps. */
export function effectiveMaxLeverage(market: { maxLeverage: number }): number {
  return Math.min(market.maxLeverage, env().PERP_MAX_LEVERAGE);
}

/**
 * The markets FLT offers, joined to live venue data.
 *
 * The registry row decides *whether* a market is offered; the venue decides
 * what it currently costs. A registry row whose market the venue no longer
 * lists is dropped rather than rendered with empty prices — an enabled row is
 * not a promise the venue still exists.
 */
export async function listOfferedMarkets(venue: PerpVenue): Promise<
  Array<PerpMarket & { maxLeverage: number; venueMaxLeverage: number }>
> {
  assertPerpsEnabled();

  const [rows, live] = await Promise.all([
    prisma.perpMarket.findMany({
      where: { venueSlug: venue.meta.slug, isEnabled: true },
      orderBy: { symbol: 'asc' },
    }),
    venue.listMarkets(),
  ]);

  const bySymbol = new Map(live.map((market) => [market.symbol, market]));

  return rows.flatMap((row) => {
    const market = bySymbol.get(row.symbol);
    if (!market || market.isDelisted) return [];

    return [
      {
        ...market,
        // The registry's copy of the venue id is authoritative for ordering,
        // but the live value wins if the venue has renumbered.
        venueAssetId: market.venueAssetId,
        maxLeverage: effectiveMaxLeverage(row),
        venueMaxLeverage: market.maxLeverage,
      },
    ];
  });
}

export async function getOfferedMarket(
  venue: PerpVenue,
  symbol: string,
): Promise<{ row: PerpMarketRow; market: PerpMarket; maxLeverage: number } | null> {
  assertPerpsEnabled();

  const row = await prisma.perpMarket.findUnique({
    where: { venueSlug_symbol: { venueSlug: venue.meta.slug, symbol: symbol.toUpperCase() } },
  });
  if (!row || !row.isEnabled) return null;

  const market = await venue.getMarket(row.symbol);
  if (!market || market.isDelisted) return null;

  return { row, market, maxLeverage: effectiveMaxLeverage(row) };
}

/**
 * Prepares an order to open or increase a position.
 *
 * Every refusal here happens before the venue is asked for anything, so an
 * ineligible user never has an order constructed on their behalf at all.
 */
export async function prepareOpen(
  venue: PerpVenue,
  context: PerpOrderContext,
): Promise<PreparedOrderResult> {
  assertPerpsEnabled();

  const { user, wallet, intent } = context;

  assertMayTrade(user);
  if (!wallet.verifiedAt) {
    throw new WalletNotVerifiedError();
  }

  const offered = await getOfferedMarket(venue, intent.symbol);
  if (!offered) {
    throw new NotFoundError('This market is not available for trading');
  }
  const { row, market, maxLeverage } = offered;

  // The lower of FLT's cap and the venue's, enforced before anything is built.
  assertLeverage(intent.leverage, maxLeverage);

  if (new Decimal(intent.size).lessThan(market.minSize)) {
    throw new ValidationError(`The minimum size on this market is ${market.minSize}`, {
      size: intent.size,
      minSize: market.minSize,
    });
  }
  if (intent.slippageBps < 0 || intent.slippageBps > 1_000) {
    throw new ValidationError('Slippage must be between 0 and 1000 basis points', {
      slippageBps: intent.slippageBps,
    });
  }

  /**
   * Leverage requires protection, and protection bounds the leverage.
   *
   * The waterfall the product promises is: insurance first, margin second. It
   * holds only while the protection boundary sits between the mark and the
   * venue's liquidation price, and above a certain leverage it simply does
   * not — the venue closes the position before the boundary is reached, and
   * the cover would have been sold against an event that cannot happen.
   *
   * So this refuses rather than warns, and it refuses on a bound recomputed
   * from live volatility. The same leverage is sound on a quiet day and
   * unsound on a violent one; a fixed cap would be wrong on both.
   */
  if (intent.leverage > 1 && protectionRequired() && !intent.reduceOnly) {
    const quote = await quoteProtection(venue, {
      symbol: market.symbol,
      side: intent.side,
      usdNotional: new Decimal(intent.size).times(market.markPrice ?? '0'),
      leverage: intent.leverage,
      percentile: intent.protectionPercentile,
    });

    if (!quote.waterfallHolds) {
      throw new ValidationError(quote.refusal ?? 'Protection cannot cover this position', {
        maxLeverage: quote.waterfall.maxWholeLeverage,
        boundary: quote.boundary.toFixed(),
        liquidation: quote.estimatedLiquidation?.toFixed() ?? null,
      });
    }

    if (!quote.sellable) {
      throw new ValidationError(
        'Leveraged trading requires protection, and protection is not currently available to ' +
          'buy on this deployment. Only unleveraged positions can be opened.',
        { protectionMode: env().PROTECTION_MODE },
      );
    }
  }

  assertOrderPrices(intent, market.markPrice);

  const fee = builderFee();
  const normalized: PerpOrderIntent = { ...intent, symbol: market.symbol };

  const [preview, action] = await Promise.all([
    venue.previewOrder({ address: wallet.address, intent: normalized, fee }),
    venue.prepareOrder({ address: wallet.address, intent: normalized, fee }),
  ]);

  const referencePrice = preview.estimatedPrice ?? market.markPrice;
  const liquidation = resolveLiquidation({
    venuePrice: preview.liquidationPrice,
    side: intent.side,
    entryPrice: referencePrice,
    leverage: intent.leverage,
    maxLeverage: market.maxLeverage,
  });

  const warnings = collectWarnings({ preview, market, intent, venue });

  const order = await prisma.perpOrder.create({
    data: {
      id: newId(),
      userId: user.id,
      walletId: wallet.id,
      marketId: row.id,
      venueSlug: venue.meta.slug,
      kind: PerpOrderKind.OPEN,
      status: PerpOrderStatus.PREPARED,
      side: intent.side,
      size: intent.size,
      leverage: intent.leverage,
      marginMode: intent.marginMode,
      limitPrice: action.kind === 'venue-order' ? action.order.limitPrice : (referencePrice ?? '0'),
      isMarketOrder: intent.limitPrice === null,
      slippageBps: intent.slippageBps,
      reduceOnly: intent.reduceOnly,
      orderType: (intent.orderType ?? 'MARKET') as never,
      triggerPrice: intent.triggerPrice ?? null,
      takeProfitPrice: intent.takeProfitPrice ?? null,
      stopLossPrice: intent.stopLossPrice ?? null,
      bracketGroupId:
        intent.takeProfitPrice || intent.stopLossPrice ? newId() : null,
      referencePrice,
      estimatedLiquidationPrice: liquidation.price,
      marginRequired: preview.marginRequired,
      feeBps: fee?.bps ?? 0,
      feeRecipient: fee?.recipientAddress ?? null,
    },
  });

  await audit(prisma, {
    action: AuditAction.PERP_ORDER_PREPARED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'perp_order',
    entityId: order.id,
    after: {
      symbol: market.symbol,
      side: intent.side,
      size: intent.size,
      leverage: intent.leverage,
      venue: venue.meta.slug,
      liquidationPrice: liquidation.price,
      liquidationSource: liquidation.source,
    },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { order, action, preview, liquidation, warnings };
}

/** Prepares an order that reduces or flattens an existing position. */
export async function prepareClose(
  venue: PerpVenue,
  context: {
    user: User;
    wallet: Wallet;
    symbol: string;
    size: string | null;
    slippageBps: number;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ order: PerpOrder; action: PreparedAction }> {
  assertPerpsEnabled();
  assertMayTrade(context.user);

  if (!context.wallet.verifiedAt) {
    throw new WalletNotVerifiedError();
  }

  const offered = await getOfferedMarket(venue, context.symbol);
  if (!offered) {
    throw new NotFoundError('This market is not available');
  }

  const positions = await venue.getPositions({ address: context.wallet.address });
  const position = positions.find((p) => p.symbol === offered.market.symbol);
  if (!position) {
    throw new NotFoundError('No open position on this market');
  }

  const fee = builderFee();
  const action = await venue.prepareClose({
    address: context.wallet.address,
    symbol: offered.market.symbol,
    size: context.size,
    slippageBps: context.slippageBps,
    fee,
  });

  const size = context.size ?? position.size;

  const order = await prisma.perpOrder.create({
    data: {
      id: newId(),
      userId: context.user.id,
      walletId: context.wallet.id,
      marketId: offered.row.id,
      venueSlug: venue.meta.slug,
      kind: PerpOrderKind.CLOSE,
      status: PerpOrderStatus.PREPARED,
      // Closing a long is a sell; the order's side records the direction of
      // the order itself, not of the position being closed.
      side: position.side === 'LONG' ? 'SHORT' : 'LONG',
      size,
      leverage: position.leverage,
      marginMode: position.marginMode,
      limitPrice: action.kind === 'venue-order' ? action.order.limitPrice : '0',
      isMarketOrder: true,
      slippageBps: context.slippageBps,
      reduceOnly: true,
      referencePrice: offered.market.markPrice,
      feeBps: fee?.bps ?? 0,
      feeRecipient: fee?.recipientAddress ?? null,
    },
  });

  await audit(prisma, {
    action: AuditAction.PERP_ORDER_PREPARED,
    actorType: 'USER',
    actorUserId: context.user.id,
    entityType: 'perp_order',
    entityId: order.id,
    after: { symbol: offered.market.symbol, kind: 'CLOSE', size },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { order, action };
}

/**
 * Records that the client says it submitted an order.
 *
 * This is a claim, not a confirmation. FLT does not post to the venue and
 * therefore cannot witness the submission; the worker reconciles against the
 * venue's own record and is what actually moves an order to FILLED.
 */
export async function recordSubmission(params: {
  orderId: string;
  userId: string;
  venueOrderId: string | null;
  ip?: string | null;
}): Promise<PerpOrder> {
  const order = await prisma.perpOrder.findUnique({ where: { id: params.orderId } });
  if (!order || order.userId !== params.userId) {
    throw new NotFoundError('Order not found');
  }
  if (order.status !== PerpOrderStatus.PREPARED) {
    throw new ValidationError('This order has already been reported', {
      status: order.status,
    });
  }

  const updated = await prisma.perpOrder.update({
    where: { id: order.id },
    data: {
      status: PerpOrderStatus.SUBMITTED,
      venueOrderId: params.venueOrderId,
      submittedAt: new Date(),
    },
  });

  await audit(prisma, {
    action: AuditAction.PERP_ORDER_SUBMITTED,
    actorType: 'USER',
    actorUserId: params.userId,
    entityType: 'perp_order',
    entityId: order.id,
    after: { venueOrderId: params.venueOrderId },
    ip: params.ip ?? null,
  });

  return updated;
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * The builder code attached to orders, or none.
 *
 * Returns undefined rather than a zero-bps fee so the adapter can tell "no fee"
 * from "a fee of nothing", and so a misconfigured recipient never silently
 * becomes a free trade routed under someone else's code.
 */
function builderFee(): PerpIntegratorFee | undefined {
  const config = env();
  if (config.PERP_BUILDER_FEE_BPS <= 0) return undefined;
  if (!config.HYPERLIQUID_BUILDER_ADDRESS) return undefined;

  return {
    bps: config.PERP_BUILDER_FEE_BPS,
    recipientAddress: checksumAddress(config.HYPERLIQUID_BUILDER_ADDRESS),
  };
}

/**
 * The liquidation price to show, and where it came from.
 *
 * The venue's own number always wins. Ours is a fallback for an order that does
 * not exist yet, and the source travels with it so the interface can label an
 * estimate as an estimate rather than presenting both with equal confidence.
 */
export function resolveLiquidation(params: {
  venuePrice: string | null;
  side: PerpSide;
  entryPrice: string | null;
  leverage: number;
  maxLeverage: number;
}): { price: string | null; source: 'venue' | 'estimated' } {
  if (params.venuePrice) {
    return { price: params.venuePrice, source: 'venue' };
  }
  if (!params.entryPrice) {
    return { price: null, source: 'estimated' };
  }

  const estimate = estimateLiquidationPrice({
    side: params.side,
    entryPrice: params.entryPrice,
    leverage: params.leverage,
    maxLeverage: params.maxLeverage,
  });

  return {
    // Rounded here rather than in the arithmetic. The domain function stays
    // exact so its invariant test can assert equality outright, but the value
    // that gets persisted and read back by a person should not carry forty
    // digits of working precision — significant digits rather than decimal
    // places, because this has to hold both a $79,000 contract and a sub-cent
    // one.
    price: estimate
      ? new Decimal(estimate).toSignificantDigits(12, Decimal.ROUND_HALF_UP).toFixed()
      : null,
    source: 'estimated',
  };
}

function collectWarnings(params: {
  preview: OrderPreview;
  market: PerpMarket;
  intent: PerpOrderIntent;
  venue: PerpVenue;
}): PerpWarning[] {
  const warnings: PerpWarning[] = [];

  if (params.preview.reversesPosition) {
    warnings.push({
      code: 'reverses_position',
      message:
        'This order is larger than your open position on the other side, so it will close that position and open a new one in the opposite direction.',
    });
  }

  if (params.venue.requiresBridgedCollateral) {
    warnings.push({
      code: 'bridged_collateral',
      message:
        'Margin for this trade is held on the venue, not in your linked wallet. Moving it back is a separate withdrawal.',
    });
  }

  if (params.intent.leverage >= 10) {
    // Not a blocker, but the point at which the distance to liquidation stops
    // being intuitive: at 10x a 10% move against the position ends it.
    const move = new Decimal(100).dividedBy(params.intent.leverage).toDecimalPlaces(1);
    warnings.push({
      code: 'high_leverage',
      message: `At ${params.intent.leverage}x, a move of roughly ${move.toFixed()}% against you closes this position.`,
    });
  }

  if (params.market.fundingRate && new Decimal(params.market.fundingRate).abs().greaterThan('0.0005')) {
    const payer =
      new Decimal(params.market.fundingRate).isPositive() === (params.intent.side === 'LONG');
    warnings.push({
      code: 'elevated_funding',
      message: payer
        ? 'Funding on this market is unusually high and you would be paying it every hour this position stays open.'
        : 'Funding on this market is unusually high and currently pays your side of the trade.',
    });
  }

  return warnings;
}

/** Notional and margin for display, without touching the venue. */
export function orderEconomics(params: {
  size: string;
  price: string;
  leverage: number;
}): { notional: string; margin: string } {
  return {
    notional: notional(params.size, params.price),
    margin: initialMargin(params.size, params.price, params.leverage),
  };
}


/**
 * Trigger and bracket prices must sit on the right side of the market.
 *
 * A stop above the entry on a long is not a stop — it fires immediately, or
 * takes profit, depending on the venue. Refusing here means the mistake is
 * caught while it is still a form field rather than after it has been signed
 * and sent, when it is the venue's problem and the user's money.
 */
function assertOrderPrices(intent: PerpOrderIntent, markPrice: string | null): void {
  const orderType = intent.orderType ?? 'MARKET';
  const isLong = intent.side === 'LONG';

  if (isTriggerOrder(orderType)) {
    if (!intent.triggerPrice) {
      throw new ValidationError('This order type needs a trigger price', { orderType });
    }
    const trigger = new Decimal(intent.triggerPrice);
    if (!trigger.isFinite() || trigger.lessThanOrEqualTo(0)) {
      throw new ValidationError('The trigger price must be a positive number');
    }
  }

  if (!markPrice) return;
  const mark = new Decimal(markPrice);

  // Both legs close the position, so they sit opposite one another around the
  // entry: profit in the direction the position gains, stop the other way.
  if (intent.takeProfitPrice) {
    const tp = new Decimal(intent.takeProfitPrice);
    const wrongSide = isLong ? tp.lessThanOrEqualTo(mark) : tp.greaterThanOrEqualTo(mark);
    if (wrongSide) {
      throw new ValidationError(
        `A take-profit on a ${isLong ? 'long' : 'short'} must sit ${isLong ? 'above' : 'below'} the market price.`,
        { takeProfitPrice: intent.takeProfitPrice, markPrice },
      );
    }
  }

  if (intent.stopLossPrice) {
    const sl = new Decimal(intent.stopLossPrice);
    const wrongSide = isLong ? sl.greaterThanOrEqualTo(mark) : sl.lessThanOrEqualTo(mark);
    if (wrongSide) {
      throw new ValidationError(
        `A stop on a ${isLong ? 'long' : 'short'} must sit ${isLong ? 'below' : 'above'} the market price.`,
        { stopLossPrice: intent.stopLossPrice, markPrice },
      );
    }
  }

  if (intent.takeProfitPrice && intent.stopLossPrice) {
    const tp = new Decimal(intent.takeProfitPrice);
    const sl = new Decimal(intent.stopLossPrice);
    const crossed = isLong ? sl.greaterThanOrEqualTo(tp) : sl.lessThanOrEqualTo(tp);
    if (crossed) {
      throw new ValidationError('The stop and take-profit cross each other.', {
        takeProfitPrice: intent.takeProfitPrice,
        stopLossPrice: intent.stopLossPrice,
      });
    }
  }
}
