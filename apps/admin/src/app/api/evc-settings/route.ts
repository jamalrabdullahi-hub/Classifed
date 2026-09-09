import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import { resolveEvcSettings, setEvcSettings } from '@flt/core/services/platform-settings';
import { adminHandler } from '@/server/api';

/**
 * The EVC Plus merchant number and whether the rail is offered.
 *
 * Not a secret — participants are shown the number so they can dial it — so
 * unlike the DeepSeek key this reads back the stored value. It still sits
 * behind MANAGE_PLATFORM_SETTINGS: changing it redirects where every future
 * payment is sent.
 */
const schema = z.object({
  enabled: z.boolean(),
  merchantNumber: z.string().trim().regex(/^\d{3,15}$/, 'Digits only, 3–15 of them'),
});

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS },
  async () => resolveEvcSettings(),
);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS, schema },
  async ({ body, admin, context }) => {
    await setEvcSettings(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      body,
    );
    return body;
  },
);
