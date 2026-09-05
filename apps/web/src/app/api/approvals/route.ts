import { z } from 'zod';
import { recordApproval } from '@flt/core/services/trades';
import { RateLimits } from '@flt/core/services/ratelimit';
import { addressSchema, chainIdSchema, handler, txHashSchema } from '@/server/api';

/**
 * Records an ERC-20 approval.
 *
 * Tracked separately from the swap so the Activity feed can explain why a
 * first-time trade needed two wallet prompts.
 */
const schema = z.object({
  walletId: z.string().uuid(),
  chainId: chainIdSchema,
  txHash: txHashSchema,
  tokenAddress: addressSchema,
  spenderAddress: addressSchema,
});

export const POST = handler(
  {
    schema,
    rateLimit: { rule: RateLimits.TRADE_SUBMIT, scope: 'approval-submit' },
    idempotency: 'approvals.record',
  },
  async ({ body, user, context }) => {
    const transaction = await recordApproval({
      user,
      walletId: body.walletId,
      chainId: body.chainId,
      txHash: body.txHash,
      tokenAddress: body.tokenAddress,
      spenderAddress: body.spenderAddress,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      id: transaction.id,
      txHash: transaction.txHash,
      status: transaction.status,
    };
  },
);
