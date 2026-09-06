import { z } from 'zod';
import { FeeType } from '@flt/db';
import { PERMISSIONS, upsertFeeConfig } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Creates a fee rule.
 *
 * Editing an existing one goes to `[id]/route.ts`; both call the same service
 * function, which is what keeps the validation in one place rather than split
 * across two routes that could drift.
 */
const feeRuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  feeType: z.nativeEnum(FeeType),
  /** Basis points, for a percentage rule. Capped by the service at 1000. */
  bps: z.coerce.number().int().min(0).max(10_000).nullish(),
  /** Base units, for a fixed rule. */
  fixedAmount: z
    .string()
    .trim()
    .regex(/^\d+$/, 'Must be a whole number of base units')
    .nullish(),
  /** Null means the rule applies on any chain. Same for the two below. */
  chainId: z.coerce.number().int().positive().nullish(),
  tokenAddress: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 20-byte hex address')
    .nullish(),
  accountType: z.enum(['INVESTOR', 'TRADER', 'INSTITUTION']).nullish(),
  validFrom: z.coerce.date().nullish(),
  validUntil: z.coerce.date().nullish(),
  priority: z.coerce.number().int().min(0).max(1_000),
  isEnabled: z.boolean(),
  reason: reasonSchema,
});

export const POST = adminHandler<z.infer<typeof feeRuleSchema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_FEES, schema: feeRuleSchema },
  async ({ body, admin, context }) => {
    const saved = await upsertFeeConfig(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      { ...body, feeConfigId: null },
    );
    return { id: saved.id, name: saved.name, bps: saved.bps, isEnabled: saved.isEnabled };
  },
);
