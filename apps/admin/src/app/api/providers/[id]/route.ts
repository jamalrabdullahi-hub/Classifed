import { z } from 'zod';
import { PERMISSIONS, setProviderEnabled } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Enables or disables a routing provider.
 *
 * Disabling the active provider makes quoting fail closed. That is the intended
 * behaviour: refusing to quote is safer than quoting from a venue an operator
 * has judged unsafe.
 */
const schema = z.object({ enabled: z.boolean(), reason: reasonSchema });

export const POST = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { permission: PERMISSIONS.MANAGE_PROVIDERS, schema },
  async ({ body, params, admin, context }) => {
    await setProviderEnabled(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      { providerId: params.id, enabled: body.enabled, reason: body.reason },
    );
    return { enabled: body.enabled };
  },
);
