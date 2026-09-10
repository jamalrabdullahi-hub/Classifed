import { z } from 'zod';
import { encodeFunctionData, erc20Abi } from 'viem';
import { QuoteStatus, prisma } from '@flt/db';
import { NotFoundError, ValidationError } from '@flt/core/domain';
import { recordApproval } from '@flt/core/services/trades';
import { RateLimits } from '@flt/core/services/ratelimit';
import { isManagedWallet, sendManagedTransaction } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * Approves a swap's sell token from an FLT-provisioned wallet.
 *
 * The counterpart to POST /api/approvals, which records an approval the
 * participant's own wallet already broadcast. Without this, a managed wallet
 * could be quoted and could execute, but could never grant the allowance the
 * execution depends on — so every first trade in a token would revert.
 *
 * ## Why this takes a quote id and not an approval to make
 *
 * The obvious signature is `{ token, spender, amount }`, and it is the wrong
 * one: it lets a caller ask FLT to sign an unlimited allowance to any address
 * it names, which is the shape of every token-approval drain there has ever
 * been. Everything approved here is read off the persisted quote instead, so
 * the only allowance FLT will ever sign is the one the swap it already quoted
 * actually needs.
 *
 * The amount is the exact sell amount, never unlimited. An unlimited approval
 * is marginally more convenient and leaves a standing permission on a contract
 * long after the trade is done — the same choice the browser path makes.
 */
export const POST = handler(
  {
    schema: z.object({ quoteId: z.string().uuid() }),
    rateLimit: { rule: RateLimits.TRADE_SUBMIT, scope: 'approval-execute' },
    idempotency: 'approvals.execute',
  },
  async ({ body, user, context }) => {
    const quote = await prisma.quote.findUnique({
      where: { id: body.quoteId },
      include: { wallet: true },
    });

    if (!quote || quote.userId !== user.id) throw new NotFoundError('Quote');

    if (quote.status !== QuoteStatus.ACTIVE) {
      throw new ValidationError('That quote has already been used or cancelled', {
        status: quote.status,
      });
    }
    if (!quote.allowanceTarget) {
      throw new ValidationError('That quote does not need an approval');
    }
    if (!isManagedWallet(quote.wallet)) {
      throw new ValidationError(
        'That quote is against a wallet you linked yourself, so the approval has to be signed ' +
          'in your wallet rather than executed here.',
      );
    }

    const txHash = await sendManagedTransaction({
      wallet: quote.wallet,
      to: quote.sellTokenAddress,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [quote.allowanceTarget as `0x${string}`, BigInt(quote.sellAmount)],
      }),
      value: '0',
    });

    const transaction = await recordApproval({
      user,
      walletId: quote.walletId,
      chainId: quote.wallet.chainId,
      txHash,
      tokenAddress: quote.sellTokenAddress,
      spenderAddress: quote.allowanceTarget,
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
