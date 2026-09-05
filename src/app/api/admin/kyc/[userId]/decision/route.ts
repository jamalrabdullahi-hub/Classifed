import { z } from 'zod';
import { adminHandler } from '@/server/api';
import { decideKyc } from '@/services/admin';

const schema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'IN_REVIEW']),
  tier: z.number().int().min(0).max(3).optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Record an operator's KYC verdict. */
export const POST = adminHandler<z.infer<typeof schema>, { userId: string }, { ok: true }>(
  { schema },
  async ({ body, params, admin, context }) => {
    await decideKyc({ userId: params.userId, ...body }, admin.id, context);
    return { ok: true };
  },
);
