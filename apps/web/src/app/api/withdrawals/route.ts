import { z } from 'zod';
import { listWithdrawalsForUser, requestWithdrawal } from '@flt/core/services/withdrawals';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Withdrawing from custody.
 *
 * A request reserves the amount on the ledger and records a PENDING
 * withdrawal; the worker broadcasts it from the omnibus and debits the ledger
 * only once the transfer is confirmed on-chain. Nothing here signs or moves
 * funds directly — see `packages/core/src/services/withdrawals.ts`.
 */
export const GET = handler({}, async ({ user }) => {
  const withdrawals = await listWithdrawalsForUser(user.id);
  return {
    withdrawals: withdrawals.map((withdrawal) => ({
      id: withdrawal.id,
      asset: withdrawal.asset,
      chainId: withdrawal.chainId,
      amount: withdrawal.amount,
      destinationAddress: withdrawal.destinationAddress,
      txHash: withdrawal.txHash,
      status: withdrawal.status,
      failureReason: withdrawal.failureReason,
      createdAt: withdrawal.createdAt,
    })),
  };
});

export const POST = handler(
  {
    schema: z.object({
      asset: z.string().trim().min(1).max(20),
      chainId: z.coerce.number().int().positive(),
      amount: z.string().trim().regex(/^\d+(\.\d{1,18})?$/, 'Enter an amount like 10 or 10.50'),
      destinationAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Enter a wallet address'),
    }),
    rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'withdrawal-request' },
    idempotency: 'withdrawals.request',
  },
  async ({ user, body }) => {
    const withdrawal = await requestWithdrawal(user, body);
    return {
      id: withdrawal.id,
      status: withdrawal.status,
      asset: withdrawal.asset,
      amountBaseUnits: withdrawal.amountBaseUnits,
      destinationAddress: withdrawal.destinationAddress,
    };
  },
);
