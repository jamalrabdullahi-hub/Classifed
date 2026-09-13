import { z } from 'zod';
import { reviewOffering } from '@flt/core/services/algorithms';
import { PERMISSIONS } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Approve or reject a participant-published offering.
 *
 * Approving moves it from PENDING_REVIEW to PUBLIC, where everyone can activate
 * it and the creator earns 50% of the fees. Rejecting returns it to PRIVATE.
 */
const schema = z.object({
  slug: z.string().trim().min(1).max(64),
  approve: z.coerce.boolean(),
  reason: reasonSchema,
});

export const POST = adminHandler(
  { schema, permission: PERMISSIONS.MANAGE_ALGORITHMS },
  async ({ admin, body }) => {
    const row = await reviewOffering(admin, body.slug, body.approve);
    return { slug: row.slug, visibility: row.visibility };
  },
);
