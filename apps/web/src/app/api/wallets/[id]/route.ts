import { z } from 'zod';
import { setPreferredWallet, unlinkWallet } from '@flt/core/services/wallets';
import { routeHandler } from '@/server/api';

const patchSchema = z.object({ isPreferred: z.literal(true) });

export const PATCH = routeHandler<z.infer<typeof patchSchema>, { id: string }, unknown>(
  { schema: patchSchema },
  async ({ params, user, context }) => {
    await setPreferredWallet(user.id, params.id, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
    return { ok: true };
  },
);

/**
 * Unlinks a wallet.
 *
 * Transaction history is retained — unlinking a wallet does not unmake the
 * trades that were signed with it.
 */
export const DELETE = routeHandler<unknown, { id: string }, unknown>(
  {},
  async ({ params, user, context }) => {
    await unlinkWallet(user.id, params.id, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
    return { ok: true };
  },
);
