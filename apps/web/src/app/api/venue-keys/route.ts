import { z } from 'zod';
import { env } from '@flt/config';
import { ValidationError } from '@flt/core/domain';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { prisma } from '@flt/db';
import {
  ONE_CLICK_DISCLOSURE_VERSION,
  confirmVenueKey,
  provisionVenueKey,
  venueKeysConfigured,
  venueKeysFor,
} from '@flt/core/services/venue-keys';
import { handler } from '@/server/api';

/**
 * The venue signing key that makes one-click execution work.
 *
 * Separate from `/api/agent` on purpose. Both end up using the same key, but
 * obtaining one for your own button must not require configuring an AI agent —
 * that coupling is what sent people pressing Execute to a page about
 * autonomous trading.
 *
 * PUT verifies against Hyperliquid's own record of approved agents rather than
 * believing the browser's claim that the signature went through. A participant
 * who confirms before actually signing gets told so.
 */
export const GET = handler({}, async ({ user }) => ({
  configured: venueKeysConfigured(),
  disclosureVersion: ONE_CLICK_DISCLOSURE_VERSION,
  keys: await venueKeysFor(user.id),
}));

export const POST = handler(
  {
    schema: z.object({
      venueSlug: z.enum(['hyperliquid', 'ostium']),
      disclosureVersion: z.string().trim().min(1),
    }),
  },
  async ({ user, body }) => provisionVenueKey(user, body.venueSlug, body.disclosureVersion),
);

export const PUT = handler(
  { schema: z.object({ venueSlug: z.enum(['hyperliquid', 'ostium']) }) },
  async ({ user, body }) => {
    if (body.venueSlug !== 'hyperliquid') {
      // Ostium's key is a funded wallet of its own, so "authorised" there means
      // a deposit has landed — a different check, and one the agent page
      // already owns. Nothing here should mark it usable on a claim alone.
      throw new ValidationError(
        'One-click execution is only available on Hyperliquid at the moment.',
      );
    }

    const keys = await venueKeysFor(user.id);
    const key = keys.find((entry) => entry.venueSlug === body.venueSlug);
    if (!key) throw new ValidationError('Set up a signing key first.');

    const wallet = await resolveTradingWallet(prisma, user.id);
    await verifyHyperliquidApproval(wallet.address, key.address);

    await confirmVenueKey(user, body.venueSlug);
    return { venueSlug: body.venueSlug, authorized: true };
  },
);

async function verifyHyperliquidApproval(ownerAddress: string, agentAddress: string): Promise<void> {
  const response = await fetch(`${env().HYPERLIQUID_API_URL}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'extraAgents', user: ownerAddress }),
  });
  if (!response.ok) {
    throw new ValidationError('Could not reach Hyperliquid to verify the approval.');
  }

  const agents = (await response.json()) as Array<{ address: string; validUntil?: number | null }>;
  const now = Date.now();
  const live = agents.find(
    (entry) =>
      entry.address.toLowerCase() === agentAddress.toLowerCase() && (entry.validUntil ?? 0) > now,
  );

  if (!live) {
    throw new ValidationError(
      'Hyperliquid does not show this address as an approved key yet. Sign the approval in your ' +
        'wallet and try again.',
    );
  }
}
