import { env } from '@flt/config';
import { ProviderNotConfiguredError, ValidationError } from '@flt/core/domain';
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

  const preview = await venue.previewOrder(request);
  const action = await venue.prepareOrder(request);
  const venueOrderId = await submitPrepared(venue.meta.slug, agent.privateKey, action);

  return { venueOrderId, preview };
}

/** Closes (or reduces) the omnibus's position on a market. */
export async function closeCustodyPerpPosition(
  symbol: string,
  slippageBps = 100,
): Promise<{ venueOrderId: string | null }> {
  const { venue, account, agent } = await venueAndAgent();
  const action = await venue.prepareClose({ address: account, symbol, size: null, slippageBps });
  const venueOrderId = await submitPrepared(venue.meta.slug, agent.privateKey, action);
  return { venueOrderId };
}
