import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import { confirmEvcPayment, rejectEvcPayment } from '@flt/core/services/evc';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Reviewing claimed EVC Plus payments.
 *
 * Confirming grants a real subscription, so this is gated on
 * MANAGE_SUBSCRIPTIONS — the same permission as a manual grant, because that
 * is exactly what a confirmation is.
 *
 * The note is required in both directions. On a confirmation it is which
 * statement line matched, which is the only thing that makes this
 * reconciliation rather than a guess; on a rejection it is what the
 * participant is told about money they believe they sent.
 */
const schema = z.object({
  paymentId: z.string().trim().min(1),
  decision: z.enum(['confirm', 'reject']),
  note: reasonSchema,
});

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_SUBSCRIPTIONS, schema },
  async ({ body, admin, context }) => {
    const actionContext = {
      admin,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    };

    const payment =
      body.decision === 'confirm'
        ? await confirmEvcPayment(actionContext, { paymentId: body.paymentId, note: body.note })
        : await rejectEvcPayment(actionContext, { paymentId: body.paymentId, note: body.note });

    return { id: payment.id, status: payment.status };
  },
);
