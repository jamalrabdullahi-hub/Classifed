import { z } from 'zod';
import { assetSymbol, decimalString, handler } from '@/server/api';
import { prisma } from '@/server/db';
import { isProduction } from '@/server/env';
import { RateLimits } from '@/services/ratelimit';
import { serializeWithdrawal } from '@/services/serialize';
import { requestWithdrawal } from '@/services/withdrawal';

const schema = z.object({
  assetSymbol,
  amount: decimalString,
  walletId: z.string().uuid(),
});

export const GET = handler({}, async ({ userId }) => {
  const withdrawals = await prisma.withdrawal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { asset: true },
  });
  return withdrawals.map(serializeWithdrawal);
});

export const POST = handler(
  {
    schema,
    idempotency: 'POST /api/withdrawals',
    rateLimit: { rule: RateLimits.WITHDRAWAL, scope: 'withdrawal' },
  },
  async ({ body, userId, context, request }) => {
    const key = request.headers.get('idempotency-key')!;
    const result = await requestWithdrawal(
      {
        userId,
        assetSymbol: body.assetSymbol,
        amount: body.amount,
        walletId: body.walletId,
        idempotencyKey: key,
      },
      context,
    );

    const full = await prisma.withdrawal.findUniqueOrThrow({
      where: { id: result.withdrawal.id },
      include: { asset: true },
    });

    return {
      ...serializeWithdrawal(full),
      // Development convenience only. In production the code must be delivered
      // out-of-band; returning it here would defeat the second factor entirely.
      confirmationCode: isProduction() ? undefined : result.confirmationCode,
    };
  },
);
