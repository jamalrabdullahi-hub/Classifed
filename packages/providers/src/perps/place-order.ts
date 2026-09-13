import { env } from '@flt/config';
import { DomainError, ProviderNotConfiguredError, ValidationError } from '@flt/core/domain';
import { HyperliquidPerpVenue } from './hyperliquid';
import { readPerpsAgentKey } from './agent-key';
import { submitPrepared } from './submit';
import type { OrderPreview, PerpOrderIntent } from './types';

/**
 * Placing a perpetual order from the omnibus's venue account.
 *
 * This is the custodial execution path (ADR 0005): the order is built for the
 * **omnibus** — the account the venue knows — and signed with the **server-held
 * agent key**, not by any participant. No wallet is connected and no participant
 * signs anything.
 *
 * The participant-attribution and ledger halves (a `PerpOrder` row, the margin
 * movement, settlement on fill) sit above this and are wired separately; this
 * module is the raw venue call and holds no policy about who should be allowed
 * to trade or how much.
 */

const VENUE_SLUG = 'hyperliquid';

async function venueAndAgent() {
  const account = env().OMNIBUS_EVM_ADDRESS;
  if (!account) {
    throw new ProviderNotConfiguredError('privy-custody', 'OMNIBUS_EVM_ADDRESS is not set');
  }
  const agent = await readPerpsAgentKey(VENUE_SLUG);
  if (!agent) {
    throw new ValidationError(
      'No Hyperliquid agent key is authorised for this deployment. Run the authorisation first.',
    );
  }
  return { venue: new HyperliquidPerpVenue(), account, agent };
}

export interface CustodyPerpOrderResult {
  venueOrderId: string | null;
  preview: OrderPreview;
}

/** Opens (or increases) a position on the omnibus's venue account. */
export async function placeCustodyPerpOrder(
  intent: PerpOrderIntent,
): Promise<CustodyPerpOrderResult> {
  const { venue, account, agent } = await venueAndAgent();
  const request = { address: account, intent };

  try {
    const preview = await venue.previewOrder(request);
    const action = await venue.prepareOrder(request);
    const venueOrderId = await submitPrepared(venue.meta.slug, agent.privateKey, action);

    return { venueOrderId, preview };
  } catch (error) {
    throw venueRejection(error);
  }
}

/**
 * Surfaces a venue rejection as our own error.
 *
 * The venue's message is the actionable part — "Order must have minimum value
 * of $10" tells the participant what to change, whereas a raw provider error
 * reaches them as the generic 500 "Something went wrong". Deliberately a
 * ValidationError (400) rather than a ProviderError (502): this API sits behind
 * Cloudflare, which replaces any origin 502 with its own HTML page, so a 502
 * here would be masked before the message ever reached the client.
 */
function venueRejection(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ValidationError(`The venue rejected the order: ${message}`);
}

/** Closes (or reduces) the omnibus's position on a market. */
export async function closeCustodyPerpPosition(
  symbol: string,
  size: string | null = null,
  slippageBps = 100,
): Promise<{ venueOrderId: string | null }> {
  const { venue, account, agent } = await venueAndAgent();
  try {
    const action = await venue.prepareClose({ address: account, symbol, size, slippageBps });
    const venueOrderId = await submitPrepared(venue.meta.slug, agent.privateKey, action);
    return { venueOrderId };
  } catch (error) {
    throw venueRejection(error);
  }
}
