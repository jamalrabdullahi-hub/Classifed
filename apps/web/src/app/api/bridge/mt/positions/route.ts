import { z } from 'zod';
import { agentStatusFor } from '@flt/core/services/agent-trading';
import { ValidationError } from '@flt/core/domain';
import { perpVenueBySlug } from '@flt/providers';
import { bridgeHandler } from '@/server/bridge-auth';

/**
 * Open positions for the agent-controlled wallet on one venue — what an EA
 * polls to mirror its own chart state, since it has no other way to learn
 * what FLT actually did with a signal it sent.
 */
const schema = z.object({ venue: z.enum(['hyperliquid', 'ostium']) });

export const GET = bridgeHandler({ schema }, async ({ body, user }) => {
  const status = await agentStatusFor(user);
  const key = status.keys.find((k) => k.venueSlug === body.venue && k.authorizedAt);
  if (!status.agent || !key) {
    throw new ValidationError(`No authorised ${body.venue} agent wallet for this account.`);
  }

  const venue = perpVenueBySlug(body.venue);
  if (!venue) throw new ValidationError('Venue not configured.');

  const [positions, summary] = await Promise.all([
    venue.getPositions({ address: key.address }),
    venue.getAccountSummary({ address: key.address }),
  ]);

  return { address: key.address, summary, positions };
});
