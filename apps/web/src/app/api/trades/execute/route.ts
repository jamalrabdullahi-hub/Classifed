import { z } from 'zod';
import { QuoteStatus, prisma } from '@flt/db';
import { Decimal, NotFoundError, ValidationError, fromBaseUnits } from '@flt/core/domain';
import { submitTrade } from '@flt/core/services/trades';
import { lockFunds, unlockFunds } from '@flt/core/services/ledger';
import { RateLimits } from '@flt/core/services/ratelimit';
import {
  custodyProvider,
  isManagedWallet,
  sendManagedTransaction,
  sendOmnibusTransaction,
} from '@flt/providers';
import { handler } from '@/server/api';

/**
 * Executes a quote.
 *
 * Two paths, chosen by whether custody is on:
 *
 * - **Custody** (`CUSTODY_PROVIDER=privy`): the swap executes from the omnibus.
 *   The participant's spend is reserved with `lockFunds`, FLT signs through
 *   Privy, and the ledger is settled on confirmation by the monitor.
 * - **Delegated**: the participant's own FLT-provisioned wallet signs, gated on
 *   an unrevoked `WalletDelegation`.
 *
 * The counterpart to POST /api/trades, which records a transaction the
 * participant's own wallet already broadcast. Both paths end in the same
 * `submitTrade`, so a trade is recorded and monitored identically however it
 * was signed.
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
    let txHash: `0x${string}`;

    if (custodyProvider()) {
      /**
       * Custody: the swap executes from the omnibus. Reserve the participant's
       * spend first so the same balance cannot back two trades, then sign.
       *
       * The reservation is released only if the broadcast itself fails — once a
       * transaction is on the wire the funds are committed, and the monitor
       * settles or releases them when the chain decides.
       */
      const sellToken = await prisma.token.findFirst({
        where: { chainId: quote.chainId, address: { equals: quote.sellTokenAddress, mode: 'insensitive' } },
      });
      if (!sellToken) {
        throw new ValidationError('The asset being sold is not in the registry for this chain');
      }

      const amount = new Decimal(fromBaseUnits(quote.sellAmount, sellToken.decimals));

      await lockFunds({
        userId: user.id,
        asset: sellToken.symbol,
        amount,
        reference: `trade-lock:${quote.id}`,
        memo: `Reserved ${sellToken.symbol} for quote ${quote.id}`,
      });

      try {
        txHash = await sendOmnibusTransaction({
          chainId: quote.chainId,
          to: quote.txTo,
          data: quote.txData,
          value: quote.txValue,
          gas: quote.txGas,
        });
      } catch (error) {
        await unlockFunds({
          userId: user.id,
          asset: sellToken.symbol,
          amount,
          reference: `trade-unlock:${quote.id}`,
          memo: `Quote ${quote.id} failed to broadcast; releasing the reservation`,
        }).catch(() => undefined);
        throw error;
      }
    } else {
      if (!isManagedWallet(quote.wallet)) {
        throw new ValidationError(
          'That quote is against a wallet you linked yourself, so it has to be signed in your ' +
            'wallet rather than executed here.',
        );
      }

      txHash = await sendManagedTransaction({
        wallet: quote.wallet,
        to: quote.txTo,
        data: quote.txData,
        value: quote.txValue,
        gas: quote.txGas,
      });
    }

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
