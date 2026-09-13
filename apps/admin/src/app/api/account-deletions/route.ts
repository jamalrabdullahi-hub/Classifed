import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import { completeAccountDeletion, refuseAccountDeletion } from '@flt/core/services/account-deletion';
import { adminHandler } from '@/server/api';

/**
 * Completing or refusing an account deletion request.
 *
 * Held to MANAGE_PAYOUTS, like the rest of the attention page: completion is
 * only safe once FLT provably holds nothing for the person.
 */
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete'), requestId: z.string().trim().min(1) }),
  z.object({
    action: z.literal('refuse'),
    requestId: z.string().trim().min(1),
    note: z.string().trim().min(8).max(500),
  }),
]);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PAYOUTS, schema },
  async ({ body, admin }) => {
    if (body.action === 'complete') {
      await completeAccountDeletion(admin.id, body.requestId);
      return { status: 'COMPLETED' };
    }
    await refuseAccountDeletion(admin.id, body.requestId, { note: body.note });
    return { status: 'REFUSED' };
  },
);
