import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  marketMakerStatus,
  setMarketMakerEnabled,
  setMarketMakerHalt,
  upsertMarketMakerConfig,
  type MarketMakerConfigInput,
} from '@flt/core/services/market-maker-settings';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Operator control of the market-making book (docs/adr/0007).
 *
 * Gated on MANAGE_MARKET_MAKING, which is SUPER_ADMIN only — this switches on an
 * automated system trading FLT's own capital. Every mutation carries a reason,
 * which `recordAdminAction` writes to both the admin-action and audit trails.
 */

const capsSchema = z.object({
  halfSpreadBps: z.coerce.number().int().min(0).max(1_000),
  levels: z.coerce.number().int().min(1).max(20),
  levelSize: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a whole or decimal number'),
  levelStepBps: z.coerce.number().int().min(0).max(1_000),
  maxInventory: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a whole or decimal number'),
  maxDailyLossUsd: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a whole or decimal number'),
  requoteMs: z.coerce.number().int().min(1_000).max(600_000),
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), reason: reasonSchema }),
  z.object({ action: z.literal('disable'), reason: reasonSchema }),
  z.object({ action: z.literal('halt'), reason: reasonSchema }),
  z.object({ action: z.literal('resume'), reason: reasonSchema }),
  capsSchema.extend({ action: z.literal('update'), reason: reasonSchema }),
]);

type Body = z.infer<typeof bodySchema>;

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_MARKET_MAKING },
  async () => marketMakerStatus(),
);

export const POST = adminHandler<Body, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_MARKET_MAKING, schema: bodySchema },
  async ({ body, admin, context }) => {
    const ctx = {
      admin,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    };

    switch (body.action) {
      case 'enable':
        await setMarketMakerEnabled(ctx, true, body.reason);
        break;
      case 'disable':
        await setMarketMakerEnabled(ctx, false, body.reason);
        break;
      case 'halt':
        await setMarketMakerHalt(ctx, true, body.reason);
        break;
      case 'resume':
        await setMarketMakerHalt(ctx, false, body.reason);
        break;
      case 'update': {
        const input: MarketMakerConfigInput = {
          halfSpreadBps: body.halfSpreadBps,
          levels: body.levels,
          levelSize: body.levelSize,
          levelStepBps: body.levelStepBps,
          maxInventory: body.maxInventory,
          maxDailyLossUsd: body.maxDailyLossUsd,
          requoteMs: body.requoteMs,
          reason: body.reason,
        };
        await upsertMarketMakerConfig(ctx, input);
        break;
      }
    }

    return { ok: true };
  },
);
