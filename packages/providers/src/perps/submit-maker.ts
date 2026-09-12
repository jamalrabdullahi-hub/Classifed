import * as hl from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ValidationError } from '@flt/core/domain';
import type { MakerAction } from '@flt/core/ports';

/**
 * Signing and sending a market-making action.
 *
 * Separate from `submitPrepared` on purpose. That function signs a
 * *participant's* order and is reached only after the order has been prepared,
 * persisted and risk-checked (docs/adr/0006) — its contract is about a person's
 * order. A maker action is FLT signing for its own book: no participant, no
 * `PerpOrder` row. It gets its own signer so the participant contract is not
 * diluted by the house's needs (ADR 0007).
 *
 * The key is the venue agent key (ADR 0007 §2), already decrypted by the caller.
 * It can place and cancel orders and cannot withdraw; that bound is enforced by
 * the venue, not here. Nothing here reads or writes the database.
 */
export interface MakerSubmitResult {
  /** Venue order ids minted by a placement, in the order the quotes were sent. */
  oids: string[];
  /** How many cancels were submitted. */
  cancels: number;
}

export async function submitMakerAction(
  slug: string,
  privateKey: Hex,
  action: MakerAction,
): Promise<MakerSubmitResult> {
  const client = new hl.ExchangeClient({
    transport: new hl.HttpTransport(),
    wallet: privateKeyToAccount(privateKey),
  });

  if (action.kind === 'maker-quotes') {
    const response = await client.order({
      orders: action.quotes.map((quote) => ({
        a: quote.assetId,
        b: quote.isBuy,
        p: quote.price,
        s: quote.size,
        // A maker quote is never reduce-only; it is an add on whichever side.
        r: false,
        // Post-only: the maker adds liquidity and never takes (ADR 0007 §3).
        t: { limit: { tif: 'Alo' as const } },
        // The client order id makes a retried requote idempotent at the venue.
        c: quote.cloid as `0x${string}`,
      })),
      grouping: 'na',
    });

    const statuses = response.response?.data?.statuses ?? [];
    const oids: string[] = [];
    for (const status of statuses) {
      if (typeof status !== 'object' || status === null) continue;
      if ('error' in status) {
        throw new ValidationError(`${slug} rejected a maker quote: ${status.error}`);
      }
      if ('resting' in status) oids.push(String(status.resting.oid));
      else if ('filled' in status) oids.push(String(status.filled.oid));
    }
    return { oids, cancels: 0 };
  }

  // A cancel is addressed by venue order id where we have one, and by client
  // order id otherwise — the two are separate venue actions, so a batch is
  // split and sent as whichever it has.
  const byOid = action.cancels
    .filter((cancel) => cancel.oid != null)
    .map((cancel) => ({ a: cancel.assetId, o: cancel.oid as number }));
  const byCloid = action.cancels
    .filter((cancel) => cancel.oid == null && cancel.cloid)
    .map((cancel) => ({ asset: cancel.assetId, cloid: cancel.cloid as `0x${string}` }));

  if (byOid.length > 0) await client.cancel({ cancels: byOid });
  if (byCloid.length > 0) await client.cancelByCloid({ cancels: byCloid });

  return { oids: [], cancels: action.cancels.length };
}
