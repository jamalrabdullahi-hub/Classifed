import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  confirmFiatDelivered,
  confirmFiatReceived,
  rejectFiatDeposit,
} from '@flt/core/services/fiat-deposits';
import { adminHandler } from '@/server/api';

/**
 * The two operator steps of a fiat deposit, and the refusal.
 *
 * Gated on MANAGE_PAYOUTS rather than the general admin permission: confirming
 * receipt creates a debt FLT owes, and confirming delivery asserts that
 * somebody else's money left FLT's control. Both are narrower decisions than
 * the rest of the panel.
 *
 * Each action demands its own evidence — a statement line for receipt, a
 * transaction hash for delivery. An operator-confirmed movement with nothing
 * to check it against is indistinguishable from a mistake, and that
 * indistinguishability is where custody failures start.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('receive'),
    depositId: z.string().trim().min(1),
    amountReceived: z.string().trim().regex(/^\d+(\.\d{1,18})?$/),
    feeUsd: z.string().trim().regex(/^\d+(\.\d{1,18})?$/),
    bankReference: z.string().trim().min(3).max(200),
  }),
  z.object({
    action: z.literal('deliver'),
    depositId: z.string().trim().min(1),
    txHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Record the transaction hash'),
    address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Record the destination address'),
    chainId: z.coerce.number().int().positive(),
  }),
  z.object({
    action: z.literal('reject'),
    depositId: z.string().trim().min(1),
    note: z.string().trim().min(8).max(500),
  }),
]);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PAYOUTS, schema },
  async ({ body, admin, context }) => {
    const actionContext = {
      admin,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    };

    if (body.action === 'receive') {
      const deposit = await confirmFiatReceived(actionContext, body);
      return { id: deposit.id, status: deposit.status, netUsd: deposit.netUsd?.toString() ?? null };
    }

    if (body.action === 'deliver') {
      const deposit = await confirmFiatDelivered(actionContext, body);
      return { id: deposit.id, status: deposit.status };
    }

    const deposit = await rejectFiatDeposit(actionContext, body);
    return { id: deposit.id, status: deposit.status };
  },
);
