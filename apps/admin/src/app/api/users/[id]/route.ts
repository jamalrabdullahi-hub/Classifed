import { z } from 'zod';
import { PERMISSIONS, setTradingDisabled, setUserSuspension } from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Account controls.
 *
 * Suspension and trading are separate switches on purpose. Compliance suspends
 * an account; operations disables trading. Collapsing them into one control
 * would mean one team's decision silently overriding the other's.
 */
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), suspended: z.boolean(), reason: reasonSchema }),
  z.object({ action: z.literal('trading'), disabled: z.boolean(), reason: reasonSchema }),
]);

export const POST = adminHandler<z.infer<typeof schema>, { id: string }, unknown>(
  // The coarser of the two permissions is checked here; the service re-checks
  // the specific one, so a VIEWER cannot reach either path.
  { permission: PERMISSIONS.SUSPEND_USER, schema },
  async ({ body, params, admin, context }) => {
    if (body.action === 'suspend') {
      await setUserSuspension(
        { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
        { userId: params.id, suspended: body.suspended, reason: body.reason },
      );
      return { suspended: body.suspended };
    }

    await setTradingDisabled(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      { userId: params.id, disabled: body.disabled, reason: body.reason },
    );
    return { tradingDisabled: body.disabled };
  },
);
