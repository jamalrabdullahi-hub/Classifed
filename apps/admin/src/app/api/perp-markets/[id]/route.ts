import { z } from 'zod';
import { PERMISSIONS, setPerpMarketEnabled } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

const schema = z.object({
  enabled: z.boolean(),
  /** Omitted leaves the existing cap alone. Clamped to the venue's own maximum. */
  maxLeverage: z.coerce.number().int().min(1).max(100).optional(),
  reason: reasonSchema,
});

export const POST = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { permission: PERMISSIONS.MANAGE_TOKENS, schema },
  async ({ body, params, admin, context }) => {
    await setPerpMarketEnabled(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      {
        marketId: params.id,
        enabled: body.enabled,
        ...(body.maxLeverage === undefined ? {} : { maxLeverage: body.maxLeverage }),
        reason: body.reason,
      },
    );
    return { enabled: body.enabled };
  },
);
