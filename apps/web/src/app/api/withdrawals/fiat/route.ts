import { z } from 'zod';
import {
  listFiatWithdrawalsForUser,
  requestFiatWithdrawal,
} from '@flt/core/services/fiat-withdrawals';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Asking for cash: USD to an EVC number, a bank account, or a PayPal address.
 *
 * The request reserves the amount and records it for an operator to pay. The
 * balance is spent only when the payout is recorded with its reference — see
 * `packages/core/src/services/fiat-withdrawals.ts`. Card is not a method: card
 * payouts need a payment processor.
 */
const money = z
  .string()
  .trim()
  .transform((value) => (value.startsWith('.') ? `0${value}` : value))
  .pipe(z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 100 or 100.50'));

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const GET = handler({}, async ({ user }) => {
  const rows = await listFiatWithdrawalsForUser(user.id);
  return {
    withdrawals: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      method: row.method,
      amountUsd: row.amountUsd.toString(),
      feeUsd: row.feeUsd.toString(),
      netUsd: row.netUsd.toString(),
      status: row.status,
      note: row.note,
      createdAt: row.createdAt,
    })),
  };
});

export const POST = handler(
  {
    schema: z.object({
      method: z.enum(['EVC', 'BANK', 'PAYPAL']),
      amountUsd: money,
      payeeName: z.string().trim().min(2).max(120),
      payeePhone: optionalText(24),
      payeeEmail: z.string().trim().email().max(200).optional(),
      bankName: optionalText(120),
      accountNumber: optionalText(40),
      routingNumber: optionalText(40),
      swift: optionalText(11),
      country: optionalText(60),
    }),
    rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'fiat-withdrawal-request' },
  },
  async ({ user, body }) => {
    const row = await requestFiatWithdrawal(user, body);
    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      amountUsd: row.amountUsd.toString(),
      feeUsd: row.feeUsd.toString(),
      netUsd: row.netUsd.toString(),
    };
  },
);
