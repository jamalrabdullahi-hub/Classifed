import { z } from 'zod';
import { FeeType } from '@flt/db';
import { PERMISSIONS, setFeeConfigEnabled, upsertFeeConfig } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Edits or toggles one fee rule.
 *
 * Two actions rather than one, for the same reason the user route separates
 * suspension from trading: taking a rule out of service and rewriting its terms
 * are different decisions, and an operator disabling a rule should not have to
 * restate its whole configuration to do it.
 *
 * There is deliberately no delete. A quote records the rule that priced it, and
 * a rule that can no longer be named leaves the audit trail unable to explain
 * what a customer was charged.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('toggle'),
    enabled: z.boolean(),
    reason: reasonSchema,
  }),
  z.object({
    action: z.literal('edit'),
    name: z.string().trim().min(1).max(80),
    feeType: z.nativeEnum(FeeType),
    bps: z.coerce.number().int().min(0).max(10_000).nullish(),
    fixedAmount: z.string().trim().regex(/^\d+$/).nullish(),
    chainId: z.coerce.number().int().positive().nullish(),
    tokenAddress: z
      .string()
      .trim()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .nullish(),
    accountType: z.enum(['INVESTOR', 'TRADER', 'INSTITUTION']).nullish(),
    validFrom: z.coerce.date().nullish(),
    validUntil: z.coerce.date().nullish(),
    priority: z.coerce.number().int().min(0).max(1_000),
    isEnabled: z.boolean(),
    reason: reasonSchema,
  }),
]);

export const POST = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { permission: PERMISSIONS.MANAGE_FEES, schema },
  async ({ body, params, admin, context }) => {
    const actor = {
      admin,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    };

    if (body.action === 'toggle') {
      await setFeeConfigEnabled(actor, {
        feeConfigId: params.id,
        enabled: body.enabled,
        reason: body.reason,
      });
      return { enabled: body.enabled };
    }

    const { action: _action, ...rest } = body;
    const saved = await upsertFeeConfig(actor, { ...rest, feeConfigId: params.id });
    return { id: saved.id, name: saved.name, bps: saved.bps, isEnabled: saved.isEnabled };
  },
);
