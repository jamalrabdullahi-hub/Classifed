import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  markFiatWithdrawalPaid,
  rejectFiatWithdrawal,
} from '@flt/core/services/fiat-withdrawals';
import { adminHandler } from '@/server/api';

/**
 * The operator's two actions on a cash withdrawal.
 *
 * Held to MANAGE_PAYOUTS: recording a payout asserts that FLT's own money left
 * for somebody, and spends their reservation on the strength of it. Each action
 * demands its evidence — a payout reference to record a payment, a reason to
 * refuse one.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('paid'),
    withdrawalId: z.string().trim().min(1),
    payoutReference: z.string().trim().min(3).max(200),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('reject'),
    withdrawalId: z.string().trim().min(1),
    note: z.string().trim().min(8).max(500),
  }),
]);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PAYOUTS, schema },
  async ({ body, admin }) => {
    if (body.action === 'paid') {
      await markFiatWithdrawalPaid(admin.id, body.withdrawalId, {
        payoutReference: body.payoutReference,
        note: body.note ?? null,
      });
      return { status: 'PAID' };
    }

    await rejectFiatWithdrawal(admin.id, body.withdrawalId, { note: body.note });
    return { status: 'REJECTED' };
  },
);
