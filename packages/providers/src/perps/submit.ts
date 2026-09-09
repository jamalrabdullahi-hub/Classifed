import * as hl from '@nktkas/hyperliquid';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { env } from '@flt/config';
import { ValidationError } from '@flt/core/domain';
import type { NormalizedVenueOrder, PreparedAction } from '@flt/core/ports';

/**
 * Signing and sending an order a venue has already accepted the shape of.
 *
 * Shared by the two callers that can legitimately sign for a participant: the
 * AI agent's executor, and manual one-click execution. Both reach here only
 * after the order has been prepared, persisted and risk-checked, so this file
 * has exactly one job — turn a prepared action into a signed submission — and
 * deliberately holds no policy of its own about whether it should have been
 * called.
 *
 * The key handed in has already been decrypted by the caller. Nothing here
 * reads or writes the database.
 */

/** Signs and sends whatever the venue asked for, returning its order id if it has one. */
export async function submitPrepared(
  venueSlug: string,
  privateKey: Hex,
  action: PreparedAction,
): Promise<string | null> {
  if (action.kind === 'venue-order') {
    // Hyperliquid. The venue's own agent-key model: this key can place and
    // cancel orders and nothing else, enforced by Hyperliquid itself.
    const client = new hl.ExchangeClient({
      transport: new hl.HttpTransport(),
      wallet: privateKeyToAccount(privateKey),
    });

    const orders = [action.order, ...(action.attached ?? [])];
    const response = await client.order({
      orders: orders.map((each: NormalizedVenueOrder) => ({
        a: each.assetId,
        b: each.isBuy,
        p: each.limitPrice,
        s: each.size,
        r: each.reduceOnly,
        t: each.trigger
          ? {
              trigger: {
                isMarket: each.trigger.isMarket,
                triggerPx: each.trigger.triggerPrice,
                tpsl: each.trigger.kind,
              },
            }
          : { limit: { tif: each.timeInForce === 'IOC' ? 'Ioc' : each.timeInForce === 'ALO' ? 'Alo' : 'Gtc' } },
      })),
      grouping: action.grouping ?? 'na',
      ...(action.order.builderAddress && action.order.builderFeeTenthsBps
        ? { builder: { b: action.order.builderAddress as Address, f: action.order.builderFeeTenthsBps } }
        : {}),
    });

    const status = response.response?.data?.statuses?.[0];
    if (typeof status !== 'object' || status === null) {
      // "waitingForFill" / "waitingForTrigger" — accepted, no id to report yet.
      return null;
    }
    if ('error' in status) {
      throw new ValidationError(`Hyperliquid rejected the order (${venueSlug}): ${status.error}`);
    }
    const resting = 'resting' in status ? status.resting.oid : null;
    const filled = 'filled' in status ? status.filled.oid : null;
    return (resting ?? filled)?.toString() ?? null;
  }

  if (action.kind === 'evm-transaction') {
    // Ostium. No venue-side scoping — this is the isolated wallet's own key,
    // funded only up to the agent's Ostium allocation.
    const account = privateKeyToAccount(privateKey);
    const client = createWalletClient({
      account,
      chain: undefined,
      transport: http(env().ARBITRUM_RPC_URL),
    }).extend(publicActions);

    const hash = await client.sendTransaction({
      chain: undefined,
      to: action.transaction.to as Address,
      data: action.transaction.data as Hex,
      value: action.transaction.value ? BigInt(action.transaction.value) : 0n,
    });
    await client.waitForTransactionReceipt({ hash });
    return hash;
  }

  throw new ValidationError(`${venueSlug} cannot submit a "${action.kind}" action.`);
}
