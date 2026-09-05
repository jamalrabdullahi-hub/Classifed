import { z } from 'zod';
import { decimalString, handler } from '@/server/api';
import { prisma } from '@/server/db';
import { createDeposit } from '@/services/deposit';
import { RateLimits } from '@/services/ratelimit';
import { serializeDeposit } from '@/services/serialize';

const schema = z.object({
  amount: decimalString,
  // MSISDN the customer pays from.
  payerAccountRef: z.string().trim().min(6).max(32),
  orderId: z.string().uuid().optional(),
});

export const GET = handler({}, async ({ userId }) => {
  const deposits = await prisma.deposit.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return deposits.map(serializeDeposit);
});

export const POST = handler(
  {
    schema,
    idempotency: 'POST /api/deposits',
    rateLimit: { rule: RateLimits.DEPOSIT, scope: 'deposit' },
  },
  async ({ body, userId, context, request }) => {
    const key = request.headers.get('idempotency-key')!;
    const deposit = await createDeposit(
      {
        userId,
        amount: body.amount,
        payerAccountRef: body.payerAccountRef,
        orderId: body.orderId ?? null,
        idempotencyKey: key,
      },
      context,
    );
    return serializeDeposit(deposit);
  },
);
