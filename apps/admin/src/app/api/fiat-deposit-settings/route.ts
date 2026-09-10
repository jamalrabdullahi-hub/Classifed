import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  resolveFiatDepositSettings,
  setFiatDepositSettings,
} from '@flt/core/services/platform-settings';
import { adminHandler } from '@/server/api';

/**
 * The commercial terms of a fiat deposit, and what participants are told about
 * where to send money.
 *
 * Held to MANAGE_PLATFORM_SETTINGS rather than the payout permission: these
 * instructions decide where every future transfer is sent, which is a wider
 * decision than approving one deposit that has already arrived.
 */
const schema = z.object({
  enabled: z.boolean(),
  feeBps: z.coerce.number().int().min(0).max(1_000),
  minUsd: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'An amount like 20 or 20.00'),
  instructions: z.string().max(4_000),
});

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS },
  async () => resolveFiatDepositSettings(),
);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS, schema },
  async ({ body, admin, context }) => {
    await setFiatDepositSettings(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      body,
    );
    return body;
  },
);
