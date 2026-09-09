import { z } from 'zod';
import { SubscriptionTier } from '@flt/db';
import { createEvcPayment, listEvcPaymentsForUser } from '@flt/core/services/evc';
import { resolveEvcSettings } from '@flt/core/services/platform-settings';
import { handler } from '@/server/api';

/**
 * EVC Plus checkout.
 *
 * POST records what the participant says they will pay and returns the USSD
 * string to dial. It does not activate anything: this rail has no way to
 * verify a payment, so a claim goes to an operator queue and the plan starts
 * when a human has matched it against the merchant statement.
 *
 * GET is the participant's own history, so "did my payment go through?" has an
 * answer on the site rather than only in an operator's inbox.
 */
export const GET = handler({}, async ({ user }) => {
  const [settings, payments] = await Promise.all([
    resolveEvcSettings(),
    listEvcPaymentsForUser(user.id),
  ]);

  return {
    available: settings.enabled,
    payments: payments.map((payment) => ({
      id: payment.id,
      tier: payment.tier,
      amountUsd: payment.amountUsd,
      status: payment.status,
      reviewNote: payment.reviewNote,
      createdAt: payment.createdAt,
      reviewedAt: payment.reviewedAt,
    })),
  };
});

export const POST = handler(
  {
    schema: z.object({
      tier: z.nativeEnum(SubscriptionTier),
      payerName: z.string().trim().min(2).max(120),
      payerPhone: z.string().trim().min(7).max(24),
    }),
  },
  async ({ user, body }) => {
    const prepared = await createEvcPayment(user, {
      tier: body.tier,
      payerName: body.payerName,
      payerPhone: body.payerPhone,
    });

    return {
      ...prepared,
      note:
        'Dial the code above on the phone you named. Your plan starts once we have matched ' +
        'the payment against our EVC statement — this usually takes a little while, and you ' +
        'can check back on this page.',
    };
  },
);
