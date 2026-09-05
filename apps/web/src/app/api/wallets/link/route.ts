import { z } from 'zod';
import { completeLink } from '@flt/core/services/wallets';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Verifies the signature and links the wallet.
 *
 * The signature is checked against the address the challenge was issued for,
 * with an EIP-1271 fallback so smart-contract accounts are not excluded.
 */
const schema = z.object({
  nonce: z.string().trim().min(16).max(200),
  message: z.string().min(32).max(4_000),
  signature: z.string().trim().regex(/^0x[a-fA-F0-9]+$/, 'Not a valid signature'),
  connector: z.string().trim().max(64).optional(),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'wallet-link' } },
  async ({ body, user, context }) => {
    const wallet = await completeLink(user, body, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      id: wallet.id,
      address: wallet.address,
      chainId: wallet.chainId,
      isPreferred: wallet.isPreferred,
      verifiedAt: wallet.verifiedAt?.toISOString() ?? null,
    };
  },
);
