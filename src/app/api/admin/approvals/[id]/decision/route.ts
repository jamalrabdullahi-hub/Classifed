import { z } from 'zod';
import { adminHandler } from '@/server/api';
import { decideApproval } from '@/services/admin';

const schema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

/** Resolve a manual approval. Refuses self-approval; see services/admin.ts. */
export const POST = adminHandler<z.infer<typeof schema>, { id: string }, { ok: true }>(
  { schema },
  async ({ body, params, admin, context }) => {
    await decideApproval({ approvalId: params.id, ...body }, admin.id, context);
    return { ok: true };
  },
);
