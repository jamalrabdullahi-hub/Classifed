import { z } from 'zod';
import { CreditDestination } from '@flt/db';
import { updateProtectionSettings } from '@flt/core/services/protection-settings';
import { PERMISSIONS } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Protection settings.
 *
 * The reserve address is the consequential field here: it is where participant
 * capital lands, and a mistake in it is not recoverable by editing a file
 * afterwards. The service refuses rather than corrects — it will not let the
 * reserve and fee addresses match, and will not enable selling without a
 * reserve to sell into.
 *
 * An empty string clears a field back to the environment default; omitting it
 * leaves it alone. The two are different intentions and are kept distinct.
 */
const schema = z.object({
  reserveAddress: z
    .string()
    .trim()
    .regex(/^(0x[a-fA-F0-9]{40})?$/, 'Must be a 20-byte hex address, or empty to clear')
    .optional(),
  operatorAddress: z
    .string()
    .trim()
    .regex(/^(0x[a-fA-F0-9]{40})?$/, 'Must be a 20-byte hex address, or empty to clear')
    .optional(),
  /** Basis points of the contribution, charged on top of it. */
  operatorFeeBps: z.coerce.number().int().min(0).max(5_000).optional(),
  creditDestination: z.nativeEnum(CreditDestination).optional(),
  allowCreditChoice: z.coerce.boolean().optional(),
  mode: z.enum(['off', 'optional', 'required']).optional(),
  reason: reasonSchema,
});

// MANAGE_FEES gates the route; the service narrows it further to SUPER_ADMIN,
// because moving the reserve address is not an ordinary pricing decision.
export const POST = adminHandler(
  { schema, permission: PERMISSIONS.MANAGE_FEES },
  async ({ admin, body }) => {
  const settings = await updateProtectionSettings(admin, {
    reserveAddress: body.reserveAddress,
    operatorAddress: body.operatorAddress,
    operatorFeeBps: body.operatorFeeBps,
    creditDestination: body.creditDestination,
    allowCreditChoice: body.allowCreditChoice,
    mode: body.mode,
    reason: body.reason,
  });

    return {
      settings: {
        reserveAddress: settings.reserveAddress,
        operatorAddress: settings.operatorAddress,
        operatorFeeBps: settings.operatorFeeBps,
        creditDestination: settings.creditDestination,
        allowCreditChoice: settings.allowCreditChoice,
        mode: settings.mode,
        updatedAt: settings.updatedAt,
      },
    };
  },
);
