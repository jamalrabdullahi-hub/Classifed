import { z } from 'zod';
import {
  PERMISSIONS,
  setAccountType,
  setTradingApproval,
  setTradingDisabled,
  setUserSuspension,
} from '@flt/core/services/admin';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Account controls.
 *
 * Suspension and trading are separate switches on purpose. Compliance suspends
 * an account; operations disables trading. Collapsing them into one control
 * would mean one team's decision silently overriding the other's.
 *
 * The pricing tier is a third, and belongs to neither: it decides what the
 * customer is charged, not whether they may trade.
 */
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), suspended: z.boolean(), reason: reasonSchema }),
  z.object({ action: z.literal('trading'), disabled: z.boolean(), reason: reasonSchema }),
  z.object({ action: z.literal('approval'), approved: z.boolean(), reason: reasonSchema }),
  z.object({
    action: z.literal('tier'),
    accountType: z.enum(['INVESTOR', 'TRADER', 'INSTITUTION']),
    reason: reasonSchema,
  }),
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

    if (body.action === 'approval') {
      await setTradingApproval(
        { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
        { userId: params.id, approved: body.approved, reason: body.reason },
      );
      return { tradingApproved: body.approved };
    }

    if (body.action === 'trading') {
      await setTradingDisabled(
        { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
        { userId: params.id, disabled: body.disabled, reason: body.reason },
      );
      return { tradingDisabled: body.disabled };
    }

    // Pricing, not access — so it checks MANAGE_FEES inside the service rather
    // than riding on the suspension permission this route opens with.
    await setAccountType(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      { userId: params.id, accountType: body.accountType, reason: body.reason },
    );
    return { accountType: body.accountType };
  },
);
