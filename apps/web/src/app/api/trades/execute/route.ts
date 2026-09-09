import { z } from 'zod';
import { QuoteStatus, prisma } from '@flt/db';
import { NotFoundError, ValidationError } from '@flt/core/domain';
import { submitTrade } from '@flt/core/services/trades';
import { RateLimits } from '@flt/core/services/ratelimit';
import { isManagedWallet, sendManagedTransaction } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * Executes a quote from an FLT-provisioned wallet.
 *
 * The counterpart to POST /api/trades, which records a transaction the
 * participant's own wallet already broadcast. Here FLT asks Privy to sign, so
 * this endpoint produces the hash rather than being told it — but both end in
 * the same `submitTrade`, so a trade is recorded and monitored identically
 * however it was signed.
 *
 * ## What it will not do
 *
 * Sign for a wallet the participant linked themselves. `isManagedWallet` is
 * checked before anything else: connecting your own wallet to FLT must never
 * be the same act as authorising FLT to spend from it. Without an unrevoked
 * delegation the signer refuses too — that check lives with the signing, so
 * there is no route into it that skips the permission.
 *
 * ## The quote is not rebuilt
 *
 * The stored `txTo`/`txData`/`txValue` are sent exactly as quoted. Rebuilding
 * the transaction here would mean the participant approved one thing and FLT
 * broadcast another, which is precisely what the persisted quote exists to
 * make impossible.
 */
export const POST = handler(
  {
    schema: z.object({ quoteId: z.string().uuid() }),
    rateLimit: { rule: RateLimits.TRADE_SUBMIT, scope: 'trade-execute' },
    idempotency: 'trades.execute',
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
    if (quote.expiresAt.getTime() <= Date.now()) {
      // Refused rather than refreshed: a stale quote's price is not the price,
      // and silently re-quoting would execute at a number nobody agreed to.
      throw new ValidationError('That quote has expired. Ask for a new one.');
    }
    if (!isManagedWallet(quote.wallet)) {
      throw new ValidationError(
        'That quote is against a wallet you linked yourself, so it has to be signed in your ' +
          'wallet rather than executed here.',
      );
    }

    const txHash = await sendManagedTransaction({
      wallet: quote.wallet,
      to: quote.txTo,
      data: quote.txData,
      value: quote.txValue,
      gas: quote.txGas,
    });

    const transaction = await submitTrade({
      user,
      quoteId: quote.id,
      txHash,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      id: transaction.id,
      txHash: transaction.txHash,
      status: transaction.status,
      chainId: transaction.chainId,
      submittedAt: transaction.submittedAt.toISOString(),
    };
  },
);
