import { z } from 'zod';
import { PERMISSIONS, setTokenEnabled } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

const schema = z.object({ enabled: z.boolean(), reason: reasonSchema });

export const POST = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { permission: PERMISSIONS.MANAGE_TOKENS, schema },
  async ({ body, params, admin, context }) => {
    await setTokenEnabled(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      { tokenId: params.id, enabled: body.enabled, reason: body.reason },
    );
    return { enabled: body.enabled };
  },
);
