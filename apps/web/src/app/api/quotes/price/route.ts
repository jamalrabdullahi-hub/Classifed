import { z } from 'zod';
import { prisma } from '@flt/db';
import { NotFoundError, TokenDisabledError } from '@flt/core/domain';
import { RateLimits } from '@flt/core/services/ratelimit';
import { entitlementsFor } from '@flt/core/services/entitlements';
import { resolveFee } from '@flt/core/services/fees';
import { dexRouter } from '@flt/providers';
import { env } from '@flt/config';
import { addressSchema, baseUnitsSchema, handler } from '@/server/api';

/**
 * Indicative price.
 *
 * Called as the user types, so it is deliberately cheap: no quote row, no
 * calldata, no commitment. It exists to answer "roughly what would I get?"
 * without spending a firm quote the user has not asked for.
 */
const schema = z.object({
  sellTokenAddress: addressSchema,
  buyTokenAddress: addressSchema,
  sellAmount: baseUnitsSchema,
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.PRICE, scope: 'price' } },
  async ({ body, user }) => {
    const [sellToken, buyToken] = await Promise.all([
      prisma.token.findFirst({ where: { address: body.sellTokenAddress } }),
      prisma.token.findFirst({ where: { address: body.buyTokenAddress } }),
    ]);

    if (!sellToken || !buyToken) throw new NotFoundError('Token');
    if (!sellToken.isEnabled) throw new TokenDisabledError(sellToken.symbol, sellToken.disabledReason);
    if (!buyToken.isEnabled) throw new TokenDisabledError(buyToken.symbol, buyToken.disabledReason);

    const entitlements = await entitlementsFor(user.id);

    const fee = await resolveFee(prisma, {
      chainId: sellToken.chainId,
      accountType: user.accountType,
      feeTokenAddress: buyToken.address,
      referenceAmount: body.sellAmount,
      feeDiscountBps: entitlements.feeDiscountBps,
    });

    const price = await dexRouter().getIndicativePrice({
      chainId: sellToken.chainId,
      sellTokenAddress: sellToken.address,
      buyTokenAddress: buyToken.address,
      sellAmount: body.sellAmount,
      sellTokenDecimals: sellToken.decimals,
      buyTokenDecimals: buyToken.decimals,
      slippageBps: env().DEFAULT_SLIPPAGE_BPS,
      ...(fee.bps > 0 && fee.recipientAddress
        ? {
            fee: {
              bps: fee.bps,
              recipientAddress: fee.recipientAddress,
              tokenAddress: buyToken.address,
            },
          }
        : {}),
    });

    return {
      liquidityAvailable: price.liquidityAvailable,
      sellAmount: price.sellAmount,
      buyAmount: price.buyAmount,
      minBuyAmount: price.minBuyAmount,
      estimatedNetworkFee: price.estimatedNetworkFee,
      feeAmount: price.feeAmount,
      feeBps: fee.bps,
      route: price.route,
    };
  },
);
