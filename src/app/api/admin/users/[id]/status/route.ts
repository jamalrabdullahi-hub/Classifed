import { z } from 'zod';
import { adminHandler } from '@/server/api';
import { setUserStatus } from '@/services/admin';

const schema = z.object({
  // CLOSED is intentionally absent: closing an account has consequences for
  // held balances that no single click should decide.
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

/** Suspend or reactivate a customer account. */
export const POST = adminHandler<z.infer<typeof schema>, { id: string }, { ok: true }>(
  { schema },
  async ({ body, params, admin, context }) => {
    await setUserStatus(params.id, body.status, admin.id, context);
    return { ok: true };
  },
);
