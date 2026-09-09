import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  holdRemittance,
  markRemittancePaid,
  rejectRemittance,
} from '@flt/core/services/remittance';
import {
  resolveRemittanceSettings,
  setRemittanceSettings,
} from '@flt/core/services/platform-settings';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Settling remittances, and the corridor's terms.
 *
 * Gated on MANAGE_PAYOUTS rather than the general operator permissions:
 * marking a transfer paid releases real fiat from FLT's float to a phone
 * number, and unlike every other action in this panel it cannot be undone by
 * clicking again.
 *
 * Every decision carries a note. On a payout it is the EVC reference — the
 * only evidence that leg produces — and on a rejection it is what the sender
 * is told about money that has already left their wallet.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('paid'),
    orderId: z.string().trim().min(1),
    reference: reasonSchema,
  }),
  z.object({ action: z.literal('hold'), orderId: z.string().trim().min(1), reason: reasonSchema }),
  z.object({ action: z.literal('reject'), orderId: z.string().trim().min(1), reason: reasonSchema }),
  z.object({
    action: z.literal('settings'),
    enabled: z.boolean(),
    fxRate: z.string().trim().regex(/^\d+(\.\d+)?$/),
    feeBps: z.coerce.number().int().min(0).max(2_000),
    minUsd: z.string().trim().regex(/^\d+(\.\d+)?$/),
    maxUsd: z.string().trim().regex(/^\d+(\.\d+)?$/),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
  }),
]);

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PAYOUTS },
  async () => resolveRemittanceSettings(),
);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PAYOUTS, schema },
  async ({ body, admin, context }) => {
    const actionContext = {
      admin,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    };

    if (body.action === 'settings') {
      await setRemittanceSettings(actionContext, {
        enabled: body.enabled,
        fxRate: body.fxRate,
        feeBps: body.feeBps,
        minUsd: body.minUsd,
        maxUsd: body.maxUsd,
        currency: body.currency.toUpperCase(),
      });
      return { saved: true };
    }

    const order =
      body.action === 'paid'
        ? await markRemittancePaid(actionContext, {
            orderId: body.orderId,
            reference: body.reference,
          })
        : body.action === 'hold'
          ? await holdRemittance(actionContext, { orderId: body.orderId, reason: body.reason })
          : await rejectRemittance(actionContext, { orderId: body.orderId, reason: body.reason });

    return { id: order.id, status: order.status };
  },
);
