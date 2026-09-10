import { z } from 'zod';
import { FiatDepositMethod } from '@flt/db';
import {
  listFiatDepositsForUser,
  requestFiatDeposit,
} from '@flt/core/services/fiat-deposits';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Telling FLT that money is on its way.
 *
 * Creates nothing of value and credits nothing — it returns the reference the
 * participant must put on their transfer, so that when the money lands there
 * is something to match it to. The balance appears only once an operator has
 * seen the cash and delivered the crypto.
 */
export const GET = handler({}, async ({ user }) => {
  const deposits = await listFiatDepositsForUser(user.id);

  return {
    deposits: deposits.map((deposit) => ({
      id: deposit.id,
      reference: deposit.reference,
      method: deposit.method,
      currency: deposit.currency,
      amountFiat: deposit.amountFiat.toString(),
      netUsd: deposit.netUsd?.toString() ?? null,
      status: deposit.status,
      note: deposit.note,
      deliveryTxHash: deposit.deliveryTxHash,
      createdAt: deposit.createdAt,
    })),
  };
});

export const POST = handler(
  {
    schema: z.object({
      method: z.nativeEnum(FiatDepositMethod),
      amountFiat: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 1000 or 1000.50'),
      currency: z.string().trim().length(3).optional(),
    }),
    rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'deposit-request' },
  },
  async ({ user, body }) => {
    const instructions = await requestFiatDeposit(user, body);

    return {
      ...instructions,
      note:
        'Put this reference on your transfer. Your balance appears once we have matched the ' +
        'payment and sent the funds to your FLT wallet.',
    };
  },
);
