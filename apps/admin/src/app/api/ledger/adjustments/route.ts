import { z } from 'zod';
import { ValidationError } from '@flt/core/domain';
import { PERMISSIONS, adjustClientBalance } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Allocate custodied capital to an account.
 *
 * The operator names the account by email, the amount, and why. This posts a
 * real, audited ledger `ADJUSTMENT` — it is not a display figure. `SUPER_ADMIN`
 * only: it is the one action that writes a balance no deposit produced, so it
 * sits with `MANAGE_PAYOUTS` rather than with the per-account controls.
 */
const schema = z.object({
  /** The account to credit, by email (the panel's identifier) or by id. */
  email: z.string().trim().email().optional(),
  userId: z.string().uuid().optional(),
  asset: z.string().trim().min(1).max(16),
  /** Human-scaled amount, e.g. "1" or "1.50". Validated again in the service. */
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal number'),
  reason: reasonSchema,
});

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.ADJUST_LEDGER, schema },
  async ({ body, admin, context }) => {
    if (Boolean(body.userId) === Boolean(body.email)) {
      throw new ValidationError('Name the account by exactly one of email or userId');
    }

    return adjustClientBalance(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      {
        userId: body.userId,
        email: body.email,
        asset: body.asset,
        amount: body.amount,
        reason: body.reason,
      },
    );
  },
);
