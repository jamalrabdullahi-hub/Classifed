import { PerpOrderKind, PerpOrderStatus, prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, newId } from '@flt/core/domain';
import { ProviderNotConfiguredError, ValidationError } from '@flt/core/domain';
import { lockFunds, unlockFunds } from '@flt/core/services/ledger';
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
}): Promise<CustodyOpenResult> {
  const venue = new HyperliquidPerpVenue();
  const request = { address: omnibus(), intent: params.intent };

  const preview = await venue.previewOrder(request);
  const margin = new Decimal(preview.marginRequired);
  if (margin.lessThanOrEqualTo(0)) {
    throw new ValidationError('The venue returned a non-positive margin requirement');
  }

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
  /** The margin reserved when the position opened, recorded for the settle. */
  margin: Decimal;
  slippageBps?: number;
}): Promise<{ venueOrderId: string | null; orderId: string }> {
  const { venueOrderId } = await placeClose(params.symbol, params.slippageBps ?? 100);
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
      size: '0',
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
