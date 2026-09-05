import { z } from 'zod';
import { prisma } from '@flt/db';
import { createLinkChallenge } from '@flt/core/services/wallets';
import { RateLimits } from '@flt/core/services/ratelimit';
import { addressSchema, chainIdSchema, handler } from '@/server/api';

/**
 * Issues the message a user signs to prove they control an address.
 *
 * The nonce is single-use and expires in five minutes, so a signature captured
 * from one session cannot be replayed into another.
 */
const schema = z.object({
  address: addressSchema,
  chainId: chainIdSchema,
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'wallet-challenge' } },
  async ({ body, user, context }) => {
    const challenge = await createLinkChallenge(prisma, user, body, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  },
);
