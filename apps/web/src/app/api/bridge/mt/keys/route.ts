import { z } from 'zod';
import { createBridgeKey, listBridgeKeys } from '@flt/core/services/mt-bridge';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Bridge keys for a participant's own MT4/5 Expert Advisor.
 *
 * Ordinary session-authed routes — a person manages these from the FLT web
 * app. The key itself is only ever returned once, from POST, at creation.
 */
const schema = z.object({
  label: z.string().trim().min(1).max(60),
});

export const GET = handler({}, async ({ user }) => {
  const keys = await listBridgeKeys(user.id);
  return keys.map((key) => ({
    id: key.id,
    label: key.label,
    lastFour: key.lastFour,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  }));
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'bridge-key-create' } },
  async ({ body, user }) => {
    return createBridgeKey(user, body.label);
  },
);
