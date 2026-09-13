import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  resolveFiatRailSettings,
  setFiatRailSettings,
} from '@flt/core/services/platform-settings';
import { adminHandler } from '@/server/api';

/**
 * Bank wire and PayPal deposit details, and the terms of cash withdrawals.
 *
 * Held to MANAGE_PLATFORM_SETTINGS: these decide where every future deposit is
 * sent and on what terms money leaves, which is wider than handling any one of
 * them.
 */
const schema = z.object({
  wire: z.object({
    enabled: z.boolean(),
    bankName: z.string().max(120),
    accountName: z.string().max(120),
    accountNumber: z.string().max(60),
    routingNumber: z.string().max(40),
    swift: z.string().max(11),
    bankAddress: z.string().max(400),
  }),
  paypal: z.object({
    enabled: z.boolean(),
    address: z.string().max(200),
  }),
  withdrawals: z.object({
    enabled: z.boolean(),
    feeBps: z.coerce.number().int().min(0).max(1_000),
    minUsd: z.string().trim().max(20),
    evc: z.boolean(),
    bank: z.boolean(),
    paypal: z.boolean(),
  }),
});

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS },
  async () => resolveFiatRailSettings(),
);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS, schema },
  async ({ body, admin, context }) => {
    await setFiatRailSettings(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      body,
    );
    return resolveFiatRailSettings();
  },
);
