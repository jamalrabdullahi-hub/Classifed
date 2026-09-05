import { z } from 'zod';
import { prisma } from '@flt/db';
import { NotFoundError } from '@flt/core/domain';
import { createQuote } from '@flt/core/services/quotes';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { RateLimits } from '@flt/core/services/ratelimit';
import { readAllowance } from '@flt/core/chains';
import { dexRouter, riskEngine } from '@flt/providers';
import { addressSchema, baseUnitsSchema, handler } from '@/server/api';

/**
 * Firm quote.
 *
 * Returns everything the review screen needs to answer the five questions the
 * brief insists a user must always be able to answer: what am I buying, where
 * is the transaction going, what does it cost, which wallet signs it, and what
 * happens on-chain.
 *
 * The calldata is persisted server-side. What is returned here is the same
 * transaction the wallet will be asked to sign, and the monitor later checks
 * that what was mined matches it.
 */
const schema = z.object({
  sellTokenAddress: addressSchema,
  buyTokenAddress: addressSchema,
  sellAmount: baseUnitsSchema,
  walletId: z.string().uuid().optional(),
  slippageBps: z.coerce.number().int().min(1).max(5_000).optional(),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'quote' } },
  async ({ body, user, context }) => {
    const [sellToken, buyToken, wallet] = await Promise.all([
      prisma.token.findFirst({ where: { address: body.sellTokenAddress } }),
      prisma.token.findFirst({ where: { address: body.buyTokenAddress } }),
      resolveTradingWallet(prisma, user.id, body.walletId),
    ]);

    if (!sellToken || !buyToken) throw new NotFoundError('Token');

    const { quote, fee, warnings } = await createQuote(dexRouter(), riskEngine(), {
      user,
      wallet,
      sellToken,
      buyToken,
      sellAmount: body.sellAmount,
      ...(body.slippageBps ? { slippageBps: body.slippageBps } : {}),
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    // Read the live allowance rather than trusting the aggregator's snapshot,
    // so the review screen does not ask for an approval the user already gave.
    let allowanceRequired = false;
    if (quote.allowanceTarget && quote.allowanceNeeded) {
      try {
        const current = await readAllowance(
          quote.chainId,
          sellToken.address,
          wallet.address,
          quote.allowanceTarget,
        );
        allowanceRequired = BigInt(current) < BigInt(quote.sellAmount);
      } catch {
        // If the chain cannot be read, assume an approval is needed. Prompting
        // for an unnecessary approval is a wasted click; skipping a necessary
        // one is a failed transaction the user paid gas for.
        allowanceRequired = true;
      }
    }

    return {
      id: quote.id,
      expiresAt: quote.expiresAt.toISOString(),

      sellToken: tokenView(sellToken),
      buyToken: tokenView(buyToken),

      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      minBuyAmount: quote.minBuyAmount,

      priceImpactBps: quote.priceImpactBps,
      slippageBps: quote.slippageBps,
      networkFeeNative: quote.networkFeeNative,

      fee: {
        bps: quote.feeBps,
        amount: quote.feeAmount,
        tokenAddress: quote.feeTokenAddress,
        description: fee.description,
      },

      route: quote.routeJson,
      provider: quote.providerSlug,

      // The exact transaction the wallet is asked to sign.
      transaction: {
        to: quote.txTo,
        data: quote.txData,
        value: quote.txValue,
        gas: quote.txGas,
      },

      allowance: allowanceRequired
        ? { required: true, spender: quote.allowanceTarget, amount: quote.sellAmount }
        : { required: false, spender: null, amount: null },

      wallet: { id: wallet.id, address: wallet.address, chainId: wallet.chainId },
      warnings,
    };
  },
);

function tokenView(token: {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  verificationTier: string;
}) {
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    verificationTier: token.verificationTier,
  };
}
