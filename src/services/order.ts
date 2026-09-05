import type { Order } from '@prisma/client';
import { Decimal, USD_SCALE, roundDeliverable } from '../domain/money';
import {
  InsufficientFundsError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import { newId } from '../domain/id';
import { orderMachine, type OrderState } from '../domain/state/index';
import { env } from '../server/env';
import { inTransaction, prisma, type Tx } from '../server/db';
import { AuditAction, audit, type AuditContext } from './audit';
import { AccountCode } from './accounts';
import { ledgerKey } from './idempotency';
import * as journal from './journal';
import { getAccountBalance, postTransaction } from './ledger';
import { assertWithinTradeLimits, getCustomerStanding } from './limits';
import { consumeQuote } from './quote';
import {
  STABLE_SYMBOL,
  assertTierAllowsAutomaticExecution,
  assertWithinTierSize,
  executeAtVenue,
  gatherVenueQuotes,
  recordAttempts,
  type SourcingRequest,
  type SourcingResult,
} from './execution';

/**
 * Order lifecycle.
 *
 * The shape of every path through this file is the same:
 *   1. Claim the quote (single-use, unexpired).
 *   2. Move the customer's funds into a hold, so they cannot be spent twice.
 *   3. Execute at the venue with the order's idempotency key.
 *   4. Post the ledger entries for what actually happened, and release the hold.
 *
 * Steps 2 and 4 are ledger transactions keyed on the order id, so a retry at any
 * point converges on the same books rather than duplicating them.
 */

export interface CreateOrderInput {
  userId: string;
  quoteId: string;
  idempotencyKey: string;
}

/**
 * Create an order from a quote and place a hold on the funds.
 *
 * Note what is absent: the client sends a quote id and nothing else. Every
 * amount is read from the quote we priced server-side.
 */
export async function createOrder(
  input: CreateOrderInput,
  context: AuditContext = {},
): Promise<Order> {
  const existing = await prisma.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return existing;

  return inTransaction(async (tx) => {
    const quote = await consumeQuote(tx, { quoteId: input.quoteId, userId: input.userId });
    const asset = await tx.asset.findUnique({ where: { id: quote.assetId } });
    if (!asset) throw new NotFoundError('Asset');

    const usdAsset = await tx.asset.findUnique({ where: { symbol: 'USD' } });
    if (!usdAsset) throw new NotFoundError('Asset USD');

    const standing = await getCustomerStanding(tx, input.userId);
    await assertWithinTradeLimits(tx, standing, new Decimal(quote.fiatAmount.toString()));

    const order = await tx.order.create({
      data: {
        id: newId(),
        userId: input.userId,
        assetId: quote.assetId,
        quoteId: quote.id,
        side: quote.side,
        status: 'CREATED',
        requestedFiatAmount: quote.fiatAmount.toString(),
        requestedCryptoAmount: quote.cryptoAmount.toString(),
        brokerageFee: quote.brokerageFee.toString(),
        idempotencyKey: input.idempotencyKey,
      },
    });

    // What the customer must put up: USD for a buy, crypto for a sell.
    const holdAssetId = quote.side === 'BUY' ? usdAsset.id : asset.id;
    const holdAmount =
      quote.side === 'BUY'
        ? new Decimal(quote.fiatAmount.toString())
        : new Decimal(quote.cryptoAmount.toString());
    const isFiatHold = quote.side === 'BUY';

    const available = await getAccountBalance(tx, {
      code: isFiatHold ? AccountCode.USER_FIAT : AccountCode.USER_CRYPTO,
      assetId: holdAssetId,
      userId: input.userId,
    });

    if (available.natural.lt(holdAmount)) {
      if (quote.side === 'SELL') {
        // Nothing to fund a sell with; fail immediately rather than leaving a
        // dangling order the customer cannot progress.
        throw new InsufficientFundsError(
          asset.symbol,
          holdAmount.toFixed(),
          available.natural.toFixed(),
        );
      }
      // A buy can be funded by a deposit; leave it awaiting payment.
      const pending = await transitionOrder(tx, order, 'PENDING_PAYMENT');
      await audit(tx, {
        ...context,
        actorType: 'USER',
        actorUserId: input.userId,
        action: AuditAction.ORDER_CREATED,
        entityType: 'Order',
        entityId: order.id,
        after: { status: pending.status, awaitingFunding: holdAmount.toFixed() },
      });
      return pending;
    }

    await placeOrderHold(tx, {
      order,
      assetId: holdAssetId,
      amount: holdAmount,
      isFiat: isFiatHold,
    });

    const funded = await transitionOrder(tx, order, 'PAID');

    await audit(tx, {
      ...context,
      actorType: 'USER',
      actorUserId: input.userId,
      action: AuditAction.ORDER_CREATED,
      entityType: 'Order',
      entityId: order.id,
      after: { status: funded.status, held: holdAmount.toFixed() },
    });

    return funded;
  });
}

async function placeOrderHold(
  tx: Tx,
  params: { order: Order; assetId: string; amount: Decimal; isFiat: boolean },
): Promise<void> {
  const template = journal.placeHold({
    userId: params.order.userId,
    assetId: params.assetId,
    amount: params.amount,
    reason: 'ORDER',
    isFiat: params.isFiat,
  });

  await postTransaction(tx, {
    type: template.type,
    referenceType: 'Order',
    referenceId: params.order.id,
    idempotencyKey: ledgerKey('Order', params.order.id, 'hold'),
    description: template.description,
    occurredAt: new Date(),
    metadata: { userId: params.order.userId, orderId: params.order.id },
    legs: template.legs,
  });
}

/**
 * Fund a PENDING_PAYMENT order once the customer's deposit has landed, then
 * place the hold. Called by the deposit flow and by the status poller.
 */
export async function fundPendingOrder(
  orderId: string,
  context: AuditContext = {},
): Promise<Order> {
  return inTransaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError('Order');
    if (order.status !== 'PENDING_PAYMENT') return order;

    const usdAsset = await tx.asset.findUnique({ where: { symbol: 'USD' } });
    if (!usdAsset) throw new NotFoundError('Asset USD');

    const required = new Decimal(order.requestedFiatAmount.toString());
    const available = await getAccountBalance(tx, {
      code: AccountCode.USER_FIAT,
      assetId: usdAsset.id,
      userId: order.userId,
    });
    if (available.natural.lt(required)) return order;

    await placeOrderHold(tx, {
      order,
      assetId: usdAsset.id,
      amount: required,
      isFiat: true,
    });

    const funded = await transitionOrder(tx, order, 'PAID');
    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: order.userId,
      action: AuditAction.ORDER_CREATED,
      entityType: 'Order',
      entityId: order.id,
      after: { status: funded.status, funded: required.toFixed() },
    });
    return funded;
  });
}

/**
 * Execute a funded order.
 *
 * The router decides where the liquidity comes from — existing inventory, an
 * on-chain swap, or an OTC counterparty — and records every venue it considered.
 * The customer's accounting is identical whichever wins, because their trade is
 * always against our book (see journal.customerBuy / customerSell).
 */
export async function executeOrder(
  orderId: string,
  context: AuditContext = {},
): Promise<Order> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order');
  if (order.status === 'SETTLED' || order.status === 'REFUNDED') return order;
  if (order.status !== 'PAID' && order.status !== 'EXECUTING') {
    throw new ValidationError(`Order ${order.id} is ${order.status} and cannot be executed`);
  }

  const [asset, usdAsset, quote] = await Promise.all([
    prisma.asset.findUnique({ where: { id: order.assetId } }),
    prisma.asset.findUnique({ where: { symbol: 'USD' } }),
    prisma.quote.findUnique({ where: { id: order.quoteId } }),
  ]);
  if (!asset || !usdAsset || !quote) throw new NotFoundError('Order references');

  if (order.status === 'PAID') {
    await inTransaction(async (tx) => {
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (current.status === 'PAID') await transitionOrder(tx, current, 'EXECUTING');
    });
  }

  // What we need the venue to deliver, and the floor below which we will not
  // settle. The floor came from the quote the customer accepted — it is not
  // recomputed here, because that would let a moved market redefine the promise.
  const minOutput = new Decimal(
    (order.minOutputAmount ?? quote.minOutputAmount).toString(),
  );

  const amountIn =
    order.side === 'BUY'
      ? new Decimal(order.requestedFiatAmount.toString()).minus(order.brokerageFee.toString())
      : new Decimal(order.requestedCryptoAmount.toString());

  const request: SourcingRequest = {
    orderId: order.id,
    asset,
    usdAsset,
    side: order.side,
    amountIn,
    expectedOutput:
      order.side === 'BUY'
        ? new Decimal(order.requestedCryptoAmount.toString())
        : new Decimal(quote.totalCustomerCost.toString()),
    minOutput,
    notionalUsd: new Decimal(order.requestedFiatAmount.toString()),
  };

  let sourcing: SourcingResult;
  try {
    sourcing = await sourceLiquidity(request, context);
  } catch (error) {
    // Nothing was obtained. Release the hold and return the customer's money —
    // never leave funds committed to an order that cannot complete.
    await failAndRefundOrder(
      order.id,
      error instanceof Error ? error.message : 'No venue could fill this order',
      context,
    );
    throw error;
  }

  return settleOrder(order.id, sourcing, context);
}

/**
 * Ask every venue, rank them on net output, and execute against the best one.
 *
 * If the chosen venue fails at execution time we fall through to the next
 * usable one rather than failing the customer's order outright — that fallback
 * is the entire point of having more than one venue.
 */
async function sourceLiquidity(
  request: SourcingRequest,
  context: AuditContext,
): Promise<SourcingResult> {
  assertTierAllowsAutomaticExecution(request.asset);
  assertWithinTierSize(request.asset, request.notionalUsd);

  const quotes = await gatherVenueQuotes(prisma, request);

  const attemptIds = await inTransaction(async (tx) =>
    recordAttempts(tx, request.orderId, request, quotes),
  );

  // Inventory first when it can fill: it costs no gas, moves no market, and
  // carries no settlement risk, so a venue that merely delivers marginally more
  // is not worth the execution exposure. External venues are then ranked among
  // themselves on output net of gas.
  const usableQuotes = quotes.filter((q) => !q.rejectedReason && q.netOutput.isPositive());
  const inventory = usableQuotes.filter((q) => q.venueKind === 'INVENTORY');
  const external = usableQuotes
    .filter((q) => q.venueKind !== 'INVENTORY')
    .sort((a, b) => b.netOutput.comparedTo(a.netOutput));
  const usable = [...inventory, ...external];

  if (usable.length === 0) {
    const reasons = quotes
      .map((q) => `${q.venueKind}/${q.venueName}: ${q.rejectedReason ?? 'no output'}`)
      .join('; ');
    await audit(prisma, {
      ...context,
      actorType: 'SYSTEM',
      action: AuditAction.ROUTE_REJECTED,
      entityType: 'Order',
      entityId: request.orderId,
      after: { reasons },
    });
    throw new ValidationError(
      'We could not source this trade at an acceptable price right now. Please try again shortly.',
      { venues: reasons },
    );
  }

  let lastError: unknown;
  for (const venue of usable) {
    const attemptId = attemptIds.get(`${venue.venueKind}:${venue.venueName}`);
    if (!attemptId) continue;

    try {
      return await executeAtVenue(prisma, { request, venue, attemptId }, context);
    } catch (error) {
      lastError = error;
      // Try the next venue. The attempt row already records why this one failed.
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ValidationError('Every available venue failed to fill this order');
}

/** Post the trade, the sourcing, and the customer's ledger entries. */
async function settleOrder(
  orderId: string,
  sourcing: SourcingResult,
  context: AuditContext,
): Promise<Order> {
  return inTransaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === 'SETTLED') return order;

    const asset = await tx.asset.findUniqueOrThrow({ where: { id: order.assetId } });
    const usdAsset = await tx.asset.findUniqueOrThrow({ where: { symbol: 'USD' } });

    // 1. Sourcing, if a venue was actually touched. Posted first and separately,
    //    because it is our position change, not the customer's.
    if (!sourcing.fromInventory) {
      await postSourcing(tx, { order, asset, usdAsset, sourcing });
    }

    // 2. The customer's trade, identical whatever the venue was.
    const filledCrypto =
      order.side === 'BUY'
        ? roundDeliverable(
            Decimal.min(sourcing.output, new Decimal(order.requestedCryptoAmount.toString())),
            asset.quoteScale,
          )
        : new Decimal(order.requestedCryptoAmount.toString());
    const filledFiat =
      order.side === 'BUY'
        ? new Decimal(order.requestedFiatAmount.toString())
        : sourcing.output.toDecimalPlaces(USD_SCALE, Decimal.ROUND_DOWN);

    await recordTrade(tx, order.id, {
      quantity: filledCrypto,
      price:
        filledCrypto.isZero()
          ? new Decimal(0)
          : filledFiat.dividedBy(filledCrypto).toDecimalPlaces(18),
      fiatValue: filledFiat,
      fee: sourcing.protocolFee,
      externalRef: sourcing.externalRef,
    });

    if (order.side === 'BUY') {
      await settleBuy(tx, { order, asset, usdAsset, cryptoDelivered: filledCrypto });
    } else {
      await settleSell(tx, { order, asset, usdAsset, grossProceeds: filledFiat });
    }

    const executed = await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'FILLED',
        filledCryptoAmount: filledCrypto.toFixed(),
        filledFiatAmount: filledFiat.toFixed(),
        executionPrice: filledCrypto.isZero()
          ? null
          : filledFiat.dividedBy(filledCrypto).toDecimalPlaces(18).toFixed(),
        providerOrderId: sourcing.externalRef ?? null,
        providerFee: sourcing.protocolFee.toFixed(),
        executionVenue: sourcing.venueKind,
        priceImpactBps: sourcing.priceImpactBps,
        executedAt: new Date(),
        version: { increment: 1 },
      },
    });

    const settled = await transitionOrder(tx, executed, 'SETTLED');

    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: order.userId,
      action: AuditAction.ORDER_EXECUTED,
      entityType: 'Order',
      entityId: order.id,
      after: {
        venue: sourcing.venueKind,
        venueName: sourcing.venueName,
        filledCrypto: filledCrypto.toFixed(),
        filledFiat: filledFiat.toFixed(),
        priceImpactBps: sourcing.priceImpactBps,
        txHash: sourcing.txHash,
      },
    });

    return settled;
  });
}

/** The position change from actually obtaining (or disposing of) the asset. */
async function postSourcing(
  tx: Tx,
  params: {
    order: Order;
    asset: { id: string; symbol: string };
    usdAsset: { id: string };
    sourcing: SourcingResult;
  },
): Promise<void> {
  const { order, asset, usdAsset, sourcing } = params;

  if (sourcing.venueKind === 'OTC') {
    const template =
      order.side === 'BUY'
        ? journal.treasuryOtcFill({
            usdAssetId: usdAsset.id,
            cryptoAssetId: asset.id,
            usdCost: sourcing.input,
            cryptoReceived: sourcing.output,
            providerFee: sourcing.protocolFee,
          })
        : journal.treasuryOtcSale({
            usdAssetId: usdAsset.id,
            cryptoAssetId: asset.id,
            cryptoSold: sourcing.input,
            usdReceived: sourcing.output,
            providerFee: sourcing.protocolFee,
          });

    await postTransaction(tx, {
      type: template.type,
      referenceType: 'Order',
      referenceId: order.id,
      idempotencyKey: ledgerKey('Order', order.id, 'sourcing'),
      description: template.description,
      occurredAt: new Date(),
      metadata: { orderId: order.id, venue: sourcing.venueName },
      legs: template.legs,
    });
    return;
  }

  // DEX: a swap between treasury assets, plus gas.
  const stable = await tx.asset.findUnique({ where: { symbol: STABLE_SYMBOL } });
  if (!stable) throw new NotFoundError(`Sourcing stablecoin ${STABLE_SYMBOL}`);

  const gasAsset = sourcing.gasAssetSymbol
    ? await tx.asset.findUnique({ where: { symbol: sourcing.gasAssetSymbol } })
    : null;

  const template = journal.treasurySwap({
    fromAssetId: order.side === 'BUY' ? stable.id : asset.id,
    toAssetId: order.side === 'BUY' ? asset.id : stable.id,
    amountIn: sourcing.input,
    amountOut: sourcing.output,
    gasAssetId: gasAsset?.id,
    gasFee: gasAsset ? sourcing.gasFeeNative : undefined,
  });

  await postTransaction(tx, {
    type: template.type,
    referenceType: 'Order',
    referenceId: order.id,
    idempotencyKey: ledgerKey('Order', order.id, 'sourcing'),
    description: template.description,
    occurredAt: new Date(),
    metadata: {
      orderId: order.id,
      venue: sourcing.venueName,
      txHash: sourcing.txHash ?? null,
      priceImpactBps: sourcing.priceImpactBps,
    },
    legs: template.legs,
  });
}

async function settleBuy(
  tx: Tx,
  params: {
    order: Order;
    asset: { id: string; quoteScale: number };
    usdAsset: { id: string };
    cryptoDelivered: Decimal;
  },
): Promise<void> {
  const held = new Decimal(params.order.requestedFiatAmount.toString());
  const quotedFee = new Decimal(params.order.brokerageFee.toString());
  const promised = new Decimal(params.order.requestedCryptoAmount.toString());

  // A short fill is refunded proportionally, and our fee is charged only on the
  // portion actually delivered.
  const fillRatio = promised.isZero()
    ? new Decimal(1)
    : Decimal.min(params.cryptoDelivered.dividedBy(promised), new Decimal(1));

  const brokerageFee = quotedFee
    .times(fillRatio)
    .toDecimalPlaces(USD_SCALE, Decimal.ROUND_UP);
  const spendable = held.minus(quotedFee);
  const refund = spendable
    .times(new Decimal(1).minus(fillRatio))
    .toDecimalPlaces(USD_SCALE, Decimal.ROUND_DOWN)
    .plus(quotedFee.minus(brokerageFee));

  const template = journal.customerBuy({
    userId: params.order.userId,
    usdAssetId: params.usdAsset.id,
    cryptoAssetId: params.asset.id,
    heldUsd: held,
    brokerageFee,
    cryptoDelivered: params.cryptoDelivered,
    refundedUsd: refund,
  });

  await postTransaction(tx, {
    type: template.type,
    referenceType: 'Order',
    referenceId: params.order.id,
    idempotencyKey: ledgerKey('Order', params.order.id, 'settle'),
    description: template.description,
    occurredAt: new Date(),
    metadata: { userId: params.order.userId, orderId: params.order.id },
    legs: template.legs,
  });

  if (refund.isPositive()) {
    await tx.order.update({
      where: { id: params.order.id },
      data: { refundedFiatAmount: refund.toFixed() },
    });
  }
}

async function settleSell(
  tx: Tx,
  params: {
    order: Order;
    asset: { id: string };
    usdAsset: { id: string };
    grossProceeds: Decimal;
  },
): Promise<void> {
  const heldCrypto = new Decimal(params.order.requestedCryptoAmount.toString());
  const quotedFee = new Decimal(params.order.brokerageFee.toString());

  const brokerageFee = Decimal.min(quotedFee, params.grossProceeds).toDecimalPlaces(
    USD_SCALE,
    Decimal.ROUND_UP,
  );
  const netProceeds = params.grossProceeds
    .minus(brokerageFee)
    .toDecimalPlaces(USD_SCALE, Decimal.ROUND_DOWN);

  const template = journal.customerSell({
    userId: params.order.userId,
    usdAssetId: params.usdAsset.id,
    cryptoAssetId: params.asset.id,
    heldCrypto,
    cryptoSold: heldCrypto,
    grossProceeds: params.grossProceeds,
    brokerageFee,
    netProceeds,
  });

  await postTransaction(tx, {
    type: template.type,
    referenceType: 'Order',
    referenceId: params.order.id,
    idempotencyKey: ledgerKey('Order', params.order.id, 'settle'),
    description: template.description,
    occurredAt: new Date(),
    metadata: { userId: params.order.userId, orderId: params.order.id },
    legs: template.legs,
  });
}

async function recordTrade(
  tx: Tx,
  orderId: string,
  fill: {
    quantity: Decimal;
    price: Decimal;
    fiatValue: Decimal;
    fee: Decimal;
    externalRef?: string;
  },
): Promise<void> {
  const existing = await tx.trade.count({ where: { orderId } });
  if (existing > 0) return;

  await tx.trade.create({
    data: {
      id: newId(),
      orderId,
      sequence: 1,
      quantity: fill.quantity.toFixed(),
      executedPrice: fill.price.toFixed(),
      fiatValue: fill.fiatValue.toFixed(),
      providerFee: fill.fee.toFixed(),
      providerTradeId: fill.externalRef ?? null,
      executedAt: new Date(),
    },
  });
}

/**
 * Release the hold and mark the order failed. Used when the venue rejects, the
 * call errors, or slippage blows through tolerance. The customer's money goes
 * back to their spendable balance; nothing is left stranded in a hold.
 */
export async function failAndRefundOrder(
  orderId: string,
  reason: string,
  context: AuditContext = {},
): Promise<Order> {
  return inTransaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === 'REFUNDED' || order.status === 'SETTLED') return order;

    const asset = await tx.asset.findUniqueOrThrow({ where: { id: order.assetId } });
    const usdAsset = await tx.asset.findUniqueOrThrow({ where: { symbol: 'USD' } });

    // Only release a hold that was actually placed.
    const heldTransaction = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey('Order', order.id, 'hold') },
    });

    if (heldTransaction) {
      const isFiatHold = order.side === 'BUY';
      const template = journal.releaseHold({
        userId: order.userId,
        assetId: isFiatHold ? usdAsset.id : asset.id,
        amount: isFiatHold
          ? new Decimal(order.requestedFiatAmount.toString())
          : new Decimal(order.requestedCryptoAmount.toString()),
        reason: 'ORDER',
        isFiat: isFiatHold,
      });

      await postTransaction(tx, {
        type: 'REFUND',
        referenceType: 'Order',
        referenceId: order.id,
        idempotencyKey: ledgerKey('Order', order.id, 'refund'),
        description: `Refund for failed order: ${reason}`,
        occurredAt: new Date(),
        metadata: { userId: order.userId, orderId: order.id, reason },
        legs: template.legs,
      });
    }

    const failed = await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'FAILED',
        failureReason: reason,
        refundedFiatAmount:
          order.side === 'BUY' ? order.requestedFiatAmount.toString() : '0',
        version: { increment: 1 },
      },
    });

    const refunded = await transitionOrder(tx, failed, 'REFUNDED');

    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: order.userId,
      action: AuditAction.ORDER_REFUNDED,
      entityType: 'Order',
      entityId: order.id,
      after: { reason, status: refunded.status },
    });

    return refunded;
  });
}

/** Guarded status change. Illegal transitions throw; concurrent ones lose. */
async function transitionOrder(tx: Tx, order: Order, to: OrderState): Promise<Order> {
  orderMachine.assertTransition(order.status as OrderState, to);

  const result = await tx.order.updateMany({
    where: { id: order.id, version: order.version },
    data: { status: to, version: { increment: 1 } },
  });
  if (result.count === 0) {
    // Someone else moved this order. Return their version rather than clobbering it.
    return tx.order.findUniqueOrThrow({ where: { id: order.id } });
  }
  return tx.order.findUniqueOrThrow({ where: { id: order.id } });
}
