import { PerpOrderKind, PerpOrderStatus, prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, newId } from '@flt/core/domain';
import { ProviderNotConfiguredError, ValidationError } from '@flt/core/domain';
import { lockFunds, unlockFunds } from '@flt/core/services/ledger';
import { assertLeveragedCover } from '@flt/core/services/perps';
import { HyperliquidPerpVenue } from './hyperliquid';
import { closeCustodyPerpPosition as placeClose, placeCustodyPerpOrder } from './place-order';
import type { OrderPreview, PerpOrderIntent } from './types';

/**
 * Custodial perp execution, with the participant's margin on the ledger.
 *
 * The order is placed on the **omnibus's** venue account, but the **participant's**
 * margin is reserved on the ledger before the order is broadcast, and the
 * `PerpOrder` row records who it belongs to. This is the accounting contract of
 * ADR 0006: trading the pooled account with no participant attributable is
 * forbidden — it is the "balance promised twice" failure the ledger exists to
 * prevent.
 *
 * Realized-only (ADR 0006 P5): PnL reaches the ledger at close, not per mark.
 */

const VENUE_SLUG = 'hyperliquid';
const MARGIN_ASSET = 'USDC';

function omnibus(): string {
  const address = env().OMNIBUS_EVM_ADDRESS;
  if (!address) {
    throw new ProviderNotConfiguredError('privy-custody', 'OMNIBUS_EVM_ADDRESS is not set');
  }
  return address;
}

export interface CustodyOpenResult {
  orderId: string;
  venueOrderId: string | null;
  preview: OrderPreview;
  /** The participant margin reserved on the ledger for this position. */
  margin: string;
}

/**
 * Opens a position: reserve the participant's margin, place on the omnibus,
 * record the attribution.
 *
 * The lock happens before the broadcast (ADR 0006 P3) and is released if the
 * broadcast fails, so a failed open never leaves the balance frozen.
 */
export async function openCustodyPerpPosition(params: {
  userId: string;
  walletId: string;
  marketId: string;
  intent: PerpOrderIntent;
  /**
   * Cover is being bought with this order, so the pre-existing-policy check is
   * satisfied by the policy the caller writes once the position exists. See the
   * note on `assertLeveragedCover`.
   */
  buyingCover?: boolean;
}): Promise<CustodyOpenResult> {
  const venue = new HyperliquidPerpVenue();
  const request = { address: omnibus(), intent: params.intent };

  const preview = await venue.previewOrder(request);
  const margin = new Decimal(preview.marginRequired);
  if (margin.lessThanOrEqualTo(0)) {
    throw new ValidationError('The venue returned a non-positive margin requirement');
  }

  /**
   * Insurance is mandatory on leveraged opens. Refuse before anything is
   * reserved or broadcast, so an uncovered order never reaches the venue.
   */
  await assertLeveragedCover({
    userId: params.userId,
    marketId: params.marketId,
    leverage: params.intent.leverage,
    reduceOnly: params.intent.reduceOnly,
    symbol: params.intent.symbol,
    buyingCover: params.buyingCover,
  });

  const orderId = newId();
  const lockReference = `perp-open:${orderId}`;

  await lockFunds({
    userId: params.userId,
    asset: MARGIN_ASSET,
    amount: margin,
    reference: lockReference,
    memo: `Reserved ${margin.toFixed()} ${MARGIN_ASSET} for perp ${params.intent.symbol} (${params.intent.side})`,
  });

  try {
    const { venueOrderId } = await placeCustodyPerpOrder(params.intent);

    await prisma.perpOrder.create({
      data: {
        id: orderId,
        userId: params.userId,
        walletId: params.walletId,
        marketId: params.marketId,
        venueSlug: VENUE_SLUG,
        kind: PerpOrderKind.OPEN,
        status: PerpOrderStatus.SUBMITTED,
        venueOrderId,
        submittedAt: new Date(),
        side: params.intent.side,
        size: params.intent.size,
        leverage: params.intent.leverage,
        marginMode: params.intent.marginMode,
        orderType: (params.intent.orderType ?? 'MARKET') as never,
        limitPrice: params.intent.limitPrice ?? preview.estimatedPrice ?? '0',
        isMarketOrder: params.intent.limitPrice === null,
        slippageBps: params.intent.slippageBps,
        reduceOnly: params.intent.reduceOnly,
        referencePrice: preview.estimatedPrice ?? null,
        marginRequired: preview.marginRequired,
        feeBps: 0,
      },
    });

    return { orderId, venueOrderId, preview, margin: margin.toFixed() };
  } catch (error) {
    await unlockFunds({
      userId: params.userId,
      asset: MARGIN_ASSET,
      amount: margin,
      reference: `perp-open-release:${orderId}`,
      memo: `Perp ${params.intent.symbol} did not open; releasing the reservation`,
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Closes a position: broadcast from the omnibus and record the CLOSE order.
 *
 * The ledger is NOT settled here. Settlement happens when the worker sees the
 * close fill — the same "settle on the fill, not the request" discipline as the
 * spot path, and the reason a reverted close cannot debit a balance. See
 * `apps/worker/src/perps.ts`.
 */
export async function closeCustodyPerpOrder(params: {
  userId: string;
  walletId: string;
  marketId: string;
  symbol: string;
  /** Contracts to close, or null to close the whole pooled position. */
  size?: string | null;
  /** The margin reserved when the position opened, recorded for the settle. */
  margin: Decimal;
  slippageBps?: number;
}): Promise<{ venueOrderId: string | null; orderId: string }> {
  const { venueOrderId } = await placeClose(params.symbol, params.size ?? null, params.slippageBps ?? 100);
  const orderId = newId();

  await prisma.perpOrder.create({
    data: {
      id: orderId,
      userId: params.userId,
      walletId: params.walletId,
      marketId: params.marketId,
      venueSlug: VENUE_SLUG,
      kind: PerpOrderKind.CLOSE,
      status: PerpOrderStatus.SUBMITTED,
      venueOrderId,
      submittedAt: new Date(),
      side: 'SHORT',
      size: params.size ?? '0',
      leverage: 1,
      marginMode: 'ISOLATED',
      orderType: 'MARKET' as never,
      limitPrice: '0',
      isMarketOrder: true,
      slippageBps: params.slippageBps ?? 100,
      reduceOnly: true,
      referencePrice: null,
      marginRequired: params.margin.toFixed(),
      feeBps: 0,
    },
  });

  return { venueOrderId, orderId };
}

/**
 * Attaches (or replaces) protective legs on a position that is already open.
 *
 * ## Why this is not the bracket the ticket sends
 *
 * A bracket placed with an entry rides along with it, so the position is never
 * unprotected. This is the other case: a position that exists, whose owner has
 * decided after the fact where they want out. The legs are ordinary reduce-only
 * trigger orders sized to the participant's *own* attributed size, so one
 * person's stop cannot flatten the pooled position.
 *
 * ## The legs are recorded on the entry, not as orders of their own
 *
 * Position attribution reads the latest `PerpOrder` per market and treats a
 * CLOSE as flat. A resting reduce-only leg written as its own CLOSE row would
 * therefore make an open position look closed — to the close path, to the
 * runner, and to the participant's own screen. So the venue ids go on the entry
 * row, which is also where `takeProfitPrice`/`stopLossPrice` already live.
 *
 * ## No ledger movement
 *
 * Nothing is reserved and nothing settles here. A protective leg costs nothing
 * until it fills, and when it does the worker settles it exactly as it settles
 * any other close.
 */
export async function attachCustodyPerpBracket(params: {
  userId: string;
  orderId: string;
  symbol: string;
  /** The side of the position being protected. */
  side: 'LONG' | 'SHORT';
  /** The participant's attributed size. */
  size: string;
  takeProfitPrice?: string | null;
  stopLossPrice?: string | null;
  slippageBps?: number;
}): Promise<{ takeProfitVenueOrderId: string | null; stopLossVenueOrderId: string | null }> {
  const takeProfit = params.takeProfitPrice?.trim() || null;
  const stopLoss = params.stopLossPrice?.trim() || null;
  if (!takeProfit && !stopLoss) {
    throw new ValidationError('Give a take-profit price, a stop-loss price, or both');
  }

  // A protective leg trades against the position, so it is the opposite side.
  const exitSide = params.side === 'LONG' ? 'SHORT' : 'LONG';
  const slippageBps = params.slippageBps ?? 100;

  const base = {
    symbol: params.symbol,
    side: exitSide as PerpOrderIntent['side'],
    size: params.size,
    leverage: 1,
    marginMode: 'ISOLATED' as PerpOrderIntent['marginMode'],
    limitPrice: null,
    slippageBps,
    // The whole point: these can only ever reduce the position, never open one.
    reduceOnly: true,
  };

  let takeProfitVenueOrderId: string | null = null;
  let stopLossVenueOrderId: string | null = null;

  if (takeProfit) {
    const placed = await placeCustodyPerpOrder({
      ...base,
      orderType: 'TAKE_PROFIT_MARKET' as PerpOrderIntent['orderType'],
      triggerPrice: takeProfit,
    });
    takeProfitVenueOrderId = placed.venueOrderId;
  }

  /**
   * The stop is placed even if the take-profit failed, and the caller is told
   * what actually landed. Refusing to place a stop because a target was
   * rejected would leave the position with neither, which is the wrong way for
   * this to fail.
   */
  if (stopLoss) {
    const placed = await placeCustodyPerpOrder({
      ...base,
      orderType: 'STOP_MARKET' as PerpOrderIntent['orderType'],
      triggerPrice: stopLoss,
    });
    stopLossVenueOrderId = placed.venueOrderId;
  }

  await prisma.perpOrder.update({
    where: { id: params.orderId },
    data: {
      takeProfitPrice: takeProfit,
      stopLossPrice: stopLoss,
      takeProfitVenueOrderId,
      stopLossVenueOrderId,
      bracketUpdatedAt: new Date(),
    },
  });

  return { takeProfitVenueOrderId, stopLossVenueOrderId };
}
